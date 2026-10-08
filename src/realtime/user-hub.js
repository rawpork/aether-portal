// UserHub (Phase 10 realtime, R1): one hibernating WebSocket Durable Object per user, addressed by idFromName(userId).
// Every browser tab of the user and the user's engine connect to it. The hub stamps each event with a monotonic seq,
// keeps the last 200 events / 10 minutes in storage so a reconnecting tab can resume, and fans events out to the tabs.
// Wire format and validation: public/js/realtime-protocol.js (shared with the browser). Plan: PHASE2_PLAN.md.
//
// The Worker authenticates before it forwards (src/index.js) and tells the hub who connected with the X-Hub-Role header
// ("client" for a browser tab, "engine" for the engine's push connection). The hub is only reachable through its stub,
// so that header cannot come from a browser. Browsers never write data over the socket: they send hello, ack and ping.

import {
	ENGINE_SILENCE_MS,
	MAX_CLIENT_MESSAGES_PER_SECOND,
	MAX_CONNECTIONS_PER_USER,
	engineEnvelope,
	gapMessage,
	graphEnvelope,
	parseFrame,
	pingMessage,
	pongMessage,
	readyMessage,
	resolveResume,
	trimRing,
	validateClientMessage,
	validateEngineInput,
	validateEnvelope,
	wantsEvent,
} from "../../public/js/realtime-protocol.js";

export const ROLE_CLIENT = "client";
export const ROLE_ENGINE = "engine";
// Exact frames the runtime answers without waking the hub (setWebSocketAutoResponse). Idle tabs and an idle engine keep
// their socket alive for free; the runtime records when the last auto-response happened, which the hub reads as activity.
export const PING_FRAME = JSON.stringify(pingMessage());
export const PONG_FRAME = JSON.stringify(pongMessage());

const ENGINE_MESSAGES_PER_SECOND = 50;
// Invalid frames tolerated on one connection before it is closed.
const MAX_STRIKES = 5;
const HEAD_KEY = "head";
const ENGINE_KEY = "engine";
const EVENT_PREFIX = "e:";
// Zero-padded so a key listing returns events in seq order.
const eventKey = (seq) => EVENT_PREFIX + String(seq).padStart(12, "0");

export class UserHub {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.head = 0;
		this.ring = [];
		this.engine = { online: false, at: 0 };
		// Per-connection counters. In memory only: hibernation resets them, which is harmless.
		this.windows = new Map();
		this.strikes = new Map();
		this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
		// Nothing is served until the counter and ring are loaded, so a restarted hub keeps counting where it stopped.
		this.state.blockConcurrencyWhile(() => this.load());
	}

	async load() {
		const stored = await this.state.storage.get([HEAD_KEY, ENGINE_KEY]);
		this.head = Number(stored.get(HEAD_KEY)) || 0;
		this.engine = stored.get(ENGINE_KEY) || { online: false, at: 0 };
		const events = await this.state.storage.list({ prefix: EVENT_PREFIX });
		const loaded = [...events.values()].filter((event) => validateEnvelope(event).ok);
		this.ring = trimRing(loaded, Date.now());
		const kept = new Set(this.ring.map((event) => eventKey(event.seq)));
		const stale = [...events.keys()].filter((key) => !kept.has(key));
		if (stale.length) await this.state.storage.delete(stale);
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/connect") return this.connect(request);
		if (url.pathname === "/publish" && request.method === "POST") return this.publishRequest(request);
		return new Response("Not found", { status: 404 });
	}

	// ---- Upgrade -------------------------------------------------------------------------------------------------

	connect(request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
		const role = request.headers.get("X-Hub-Role");
		if (role !== ROLE_CLIENT && role !== ROLE_ENGINE) return new Response("Unknown role", { status: 400 });
		if (role === ROLE_CLIENT && this.state.getWebSockets(ROLE_CLIENT).length >= MAX_CONNECTIONS_PER_USER) {
			return new Response("Too many connections", { status: 429, headers: { "Retry-After": "5" } });
		}
		// One engine per user: a new connection replaces the old one, which is closed before the new one counts.
		if (role === ROLE_ENGINE) {
			for (const old of this.state.getWebSockets(ROLE_ENGINE)) this.closeSocket(old, 1012, "replaced");
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server, [role]);
		// A client receives nothing until its hello names the topics it wants.
		server.serializeAttachment({ role, topics: null });
		return new Response(null, { status: 101, webSocket: client });
	}

	// ---- Socket handlers -----------------------------------------------------------------------------------------

	async webSocketMessage(ws, data) {
		const attachment = ws.deserializeAttachment() || {};
		if (this.overRate(ws, attachment.role)) return this.closeSocket(ws, 1008, "rate limit");
		const frame = parseFrame(data);
		if (!frame.ok) return this.reject(ws, frame.error === "too-large" ? 1009 : 1003, frame.error);
		if (attachment.role === ROLE_ENGINE) return this.engineMessage(ws, frame.value);
		return this.clientMessage(ws, attachment, frame.value);
	}

	webSocketClose(ws, code) {
		this.forget(ws);
		// The close handshake must be answered or the socket lingers half-open.
		try {
			ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "closed");
		} catch {
			// Already closed.
		}
		return this.afterClose(ws);
	}

	webSocketError(ws) {
		this.forget(ws);
		return this.afterClose(ws);
	}

	// An engine socket that is gone announces the engine offline at once (no 60 s wait), unless another engine socket took over.
	async afterClose(ws) {
		const role = (ws.deserializeAttachment() || {}).role;
		if (role !== ROLE_ENGINE) return;
		const others = this.state.getWebSockets(ROLE_ENGINE).filter((socket) => socket !== ws && socket.readyState === WebSocket.OPEN);
		if (!others.length && this.engine.online) await this.engineOffline("disconnected");
	}

	// ---- Browser tabs --------------------------------------------------------------------------------------------

	async clientMessage(ws, attachment, message) {
		const parsed = validateClientMessage(message);
		if (!parsed.ok) return this.strike(ws, parsed.error);
		const { value } = parsed;
		if (value.type === "ping") return ws.send(PONG_FRAME);
		if (value.type === "ack") return;
		// hello: replay what the tab missed (or tell it to refetch), then say it is caught up. No event can interleave,
		// because all of this runs before the hub handles anything else.
		ws.serializeAttachment({ ...attachment, topics: value.topics });
		const resume = resolveResume(this.ring, this.head, value.lastSeq);
		if (resume.kind === "gap") return ws.send(JSON.stringify(gapMessage(resume.seq)));
		for (const event of resume.events) {
			if (wantsEvent(value.topics, event)) ws.send(JSON.stringify(event));
		}
		ws.send(JSON.stringify(readyMessage(resume.seq, this.engine.online)));
	}

	// ---- The engine ----------------------------------------------------------------------------------------------

	async engineMessage(ws, message) {
		if (message.type === "ping") return ws.send(PONG_FRAME);
		const input = validateEngineInput(message);
		if (!input.ok) return this.strike(ws, input.error);
		const { type, data } = input.value;
		const now = Date.now();
		await this.append((seq, at) => engineEnvelope(seq, at, type, data), {
			online: type !== "engine.bye",
			at: now,
		});
		await this.scheduleSilenceCheck();
	}

	// The silence rule: the engine is the source of truth, so when it says nothing for 60 s the hub reports it offline.
	async alarm() {
		if (!this.engine.online) return;
		const idle = Date.now() - this.lastEngineActivity();
		if (idle >= ENGINE_SILENCE_MS) return this.engineOffline("silent for 60 s");
		await this.state.storage.setAlarm(Date.now() + (ENGINE_SILENCE_MS - idle));
	}

	// The newest sign of life: an engine event, or a ping the runtime auto-answered.
	lastEngineActivity() {
		let latest = this.engine.at;
		for (const ws of this.state.getWebSockets(ROLE_ENGINE)) {
			const answered = this.state.getWebSocketAutoResponseTimestamp(ws);
			if (answered && answered.getTime() > latest) latest = answered.getTime();
		}
		return latest;
	}

	async scheduleSilenceCheck() {
		if (this.engine.online) await this.state.storage.setAlarm(Date.now() + ENGINE_SILENCE_MS);
	}

	async engineOffline(reason) {
		await this.append((seq, at) => engineEnvelope(seq, at, "engine.bye", { reason }), { online: false, at: Date.now() });
		await this.state.storage.deleteAlarm();
	}

	// ---- Publishing (graph writes from the Worker, R2) -----------------------------------------------------------

	// POST /publish { event: { type, id? }, origin? } announces a graph change to every subscribed tab.
	async publishRequest(request) {
		const body = await request.json().catch(() => null);
		const event = body && body.event;
		if (!event || typeof event !== "object") return new Response("Bad event", { status: 400 });
		const probe = graphEnvelope(1, new Date().toISOString(), event, body.origin);
		if (!validateEnvelope(probe).ok) return new Response("Bad event", { status: 400 });
		const sent = await this.append((seq, at) => graphEnvelope(seq, at, event, body.origin));
		return Response.json({ seq: sent.seq }, { status: 200 });
	}

	// ---- Core: stamp, persist, fan out ---------------------------------------------------------------------------

	// Builds the event with the next seq, stores it with the counter (one atomic write, ring trimmed in the same step),
	// then sends it to every tab that asked for its topic. Storage first: a tab can only have seen what a resume can replay.
	async append(build, engineState = null) {
		const now = Date.now();
		const seq = this.head + 1;
		const event = build(seq, new Date(now).toISOString());
		const ring = trimRing([...this.ring, event], now);
		const dropped = this.ring.filter((old) => !ring.includes(old));
		const writes = { [HEAD_KEY]: seq, [eventKey(seq)]: event };
		if (engineState) writes[ENGINE_KEY] = engineState;
		await this.state.storage.transaction(async (txn) => {
			await txn.put(writes);
			if (dropped.length) await txn.delete(dropped.map((old) => eventKey(old.seq)));
		});
		this.head = seq;
		this.ring = ring;
		if (engineState) this.engine = engineState;
		this.fanOut(event);
		return event;
	}

	fanOut(event) {
		const text = JSON.stringify(event);
		for (const ws of this.state.getWebSockets(ROLE_CLIENT)) {
			const topics = (ws.deserializeAttachment() || {}).topics;
			if (!topics || !wantsEvent(topics, event)) continue;
			try {
				ws.send(text);
			} catch {
				// A socket that cannot be written to is closing; its close handler cleans up.
			}
		}
	}

	// ---- Limits --------------------------------------------------------------------------------------------------

	// Tabs send almost nothing (hello, ack, ping), so their limit is low; the engine reports every task step.
	overRate(ws, role) {
		const now = Date.now();
		const window = this.windows.get(ws) || { start: now, count: 0 };
		if (now - window.start >= 1000) {
			window.start = now;
			window.count = 0;
		}
		window.count += 1;
		this.windows.set(ws, window);
		return window.count > (role === ROLE_ENGINE ? ENGINE_MESSAGES_PER_SECOND : MAX_CLIENT_MESSAGES_PER_SECOND);
	}

	// An invalid frame is dropped; a connection that keeps sending them is closed.
	strike(ws, reason) {
		const count = (this.strikes.get(ws) || 0) + 1;
		this.strikes.set(ws, count);
		if (count >= MAX_STRIKES) this.closeSocket(ws, 1008, "invalid messages");
		return reason;
	}

	reject(ws, code, reason) {
		this.closeSocket(ws, code, reason);
	}

	closeSocket(ws, code, reason) {
		this.forget(ws);
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	forget(ws) {
		this.windows.delete(ws);
		this.strikes.delete(ws);
	}
}
