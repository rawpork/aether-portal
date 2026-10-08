import { beforeEach, describe, expect, it } from "vitest";
import {
	ACK_DELAY_MS,
	DEAD_AFTER_MS,
	HIDDEN_CLOSE_MS,
	KEEPALIVE_MS,
	MAX_FAILURES,
	STABLE_AFTER_MS,
	createRealtimeClient,
	realtimeUrl,
} from "../public/js/realtime-client.js";
import { REFRESH_TARGETS, createRefreshCoalescer, mountRealtimeRefresh, refreshTargetsFor } from "../public/js/engine/realtime-refresh.js";

window.__aetherRealtimeNoBoot = true;
const { bootRealtime } = await import("../public/js/realtime-boot.js");

const AT = "2026-10-07T12:00:00.000Z";
const URL_ = "wss://portal.test/api/realtime";

// A WebSocket the test drives by hand.
class FakeSocket {
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		this.closedWith = null;
		FakeSocket.instances.push(this);
	}
	send(text) {
		this.sent.push(JSON.parse(text));
	}
	close(code = 1000, reason = "") {
		this.closedWith = { code, reason };
		this.readyState = 3;
	}
	// Test helpers
	open() {
		this.readyState = 1;
		this.onopen && this.onopen({});
	}
	receive(message) {
		this.onmessage({ data: typeof message === "string" ? message : JSON.stringify(message) });
	}
	drop(code = 1006) {
		this.readyState = 3;
		this.onclose && this.onclose({ code });
	}
}

// Timers and the clock under the test's control.
function makeClock() {
	const clock = { time: 1_000_000, timers: [], nextId: 1 };
	clock.setTimer = (fn, ms) => {
		const id = clock.nextId++;
		clock.timers.push({ id, fn, at: clock.time + ms });
		return id;
	};
	clock.clearTimer = (id) => {
		clock.timers = clock.timers.filter((timer) => timer.id !== id);
	};
	clock.now = () => clock.time;
	clock.advance = (ms) => {
		const target = clock.time + ms;
		for (;;) {
			const due = clock.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			clock.timers = clock.timers.filter((timer) => timer !== due);
			clock.time = due.at;
			due.fn();
		}
		clock.time = target;
	};
	clock.pending = () => clock.timers.map((timer) => timer.at - clock.time);
	return clock;
}

const graphEvent = (seq, type = "node.updated", extra = {}) => ({ v: 1, seq, at: AT, topic: "graph", type, ...extra });
const engineEvent = (seq, type, data) => ({ v: 1, seq, at: AT, topic: "engine", type, data });
const ready = (seq) => ({ v: 1, type: "ready", seq });
const gap = (seq) => ({ v: 1, type: "gap", seq });

let clock;
let doc;
beforeEach(() => {
	FakeSocket.instances = [];
	clock = makeClock();
	doc = new EventTarget();
	doc.visibilityState = "visible";
});

function make(options = {}) {
	const win = new EventTarget();
	const client = createRealtimeClient({
		url: URL_,
		topics: ["graph"],
		origin: "tab_me",
		WebSocketImpl: FakeSocket,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		now: clock.now,
		random: () => 1,
		doc,
		win,
		...options,
	});
	return { client, win };
}
const socket = (index = FakeSocket.instances.length - 1) => FakeSocket.instances[index];
const hide = () => {
	doc.visibilityState = "hidden";
	doc.dispatchEvent(new Event("visibilitychange"));
};
const show = () => {
	doc.visibilityState = "visible";
	doc.dispatchEvent(new Event("visibilitychange"));
};

describe("realtimeUrl", () => {
	it("follows the page's scheme and host", () => {
		expect(realtimeUrl({ protocol: "https:", host: "portal.test" })).toBe("wss://portal.test/api/realtime");
		expect(realtimeUrl({ protocol: "http:", host: "localhost:8787" })).toBe("ws://localhost:8787/api/realtime");
	});
});

describe("handshake", () => {
	it("opens the socket on start and says hello with the last seq and its topics once open", () => {
		const { client } = make({ topics: ["graph", "engine"], lastSeq: 41 });
		expect(client.state).toBe("idle");
		client.start();
		expect(socket().url).toBe(URL_);
		expect(client.state).toBe("connecting");
		expect(socket().sent).toEqual([]);
		socket().open();
		expect(client.state).toBe("syncing");
		expect(socket().sent).toEqual([{ v: 1, type: "hello", lastSeq: 41, topics: ["graph", "engine"] }]);
	});

	it("is live only after the hub's ready, and reports the seq it is current at", () => {
		const { client } = make();
		const seen = [];
		client.on("ready", (detail) => seen.push(detail));
		const states = [];
		client.on("state", (state) => states.push(state));
		client.start();
		socket().open();
		expect(client.state).toBe("syncing");
		socket().receive(ready(12));
		expect(client.state).toBe("live");
		expect(seen).toEqual([{ seq: 12 }]);
		expect(client.lastSeq).toBe(12);
		expect(states).toEqual(["connecting", "syncing", "live"]);
	});

	it("delivers replayed events before ready, in order", () => {
		const { client } = make();
		const order = [];
		client.on("*", (event) => order.push("event " + event.seq));
		client.on("ready", () => order.push("ready"));
		client.start();
		socket().open();
		socket().receive(graphEvent(8));
		socket().receive(graphEvent(9));
		socket().receive(ready(9));
		expect(order).toEqual(["event 8", "event 9", "ready"]);
	});

	it("sends one ack with the newest seq after a quiet moment, not one per event", () => {
		const { client } = make();
		client.start();
		socket().open();
		socket().receive(ready(0));
		for (const seq of [1, 2, 3]) socket().receive(graphEvent(seq));
		expect(socket().sent.filter((m) => m.type === "ack")).toEqual([]);
		clock.advance(ACK_DELAY_MS);
		expect(socket().sent.filter((m) => m.type === "ack")).toEqual([{ v: 1, type: "ack", seq: 3 }]);
	});

	it("ignores frames that are not valid server messages", () => {
		const { client } = make();
		const events = [];
		client.on("*", (event) => events.push(event));
		client.start();
		socket().open();
		socket().receive("not json");
		socket().receive({ v: 2, type: "ready", seq: 1 });
		socket().receive({ v: 1, type: "node.updated" });
		socket().receive({ ...graphEvent(1), topic: "chat" });
		socket().receive({ ...graphEvent(1), type: "agent.state" });
		expect(events).toEqual([]);
		expect(client.state).toBe("syncing");
		expect(client.lastSeq).toBe(0);
	});
});

describe("event dispatch", () => {
	it("calls handlers by type, by topic and for everything, and unsubscribes", () => {
		const { client } = make({ topics: ["graph", "engine"] });
		const log = [];
		client.on("node.updated", (event) => log.push("type " + event.id));
		const off = client.on("topic:graph", (event) => log.push("topic " + event.type));
		client.on("topic:engine", (event) => log.push("engine " + event.type));
		client.on("*", (event) => log.push("all " + event.seq));
		client.start();
		socket().open();
		socket().receive(graphEvent(1, "node.updated", { id: "n1" }));
		socket().receive(engineEvent(2, "agent.state", { agent_id: "a", state: "HALTED" }));
		expect(log).toEqual(["type n1", "topic node.updated", "all 1", "engine agent.state", "all 2"]);
		off();
		socket().receive(graphEvent(3, "link.created"));
		expect(log.slice(5)).toEqual(["all 3"]);
	});

	it("applies each seq once: a repeat or an older event is dropped", () => {
		const { client } = make();
		const seqs = [];
		client.on("*", (event) => seqs.push(event.seq));
		client.start();
		socket().open();
		for (const seq of [1, 2, 2, 1, 3]) socket().receive(graphEvent(seq));
		expect(seqs).toEqual([1, 2, 3]);
	});

	it("keeps going when a handler throws", () => {
		const { client } = make();
		const seen = [];
		client.on("*", () => {
			throw new Error("boom");
		});
		client.on("*", (event) => seen.push(event.seq));
		client.start();
		socket().open();
		socket().receive(graphEvent(1));
		expect(seen).toEqual([1]);
	});
});

describe("origin filtering", () => {
	it("does not dispatch this tab's own events, but still counts their seq and acks them", () => {
		const { client } = make();
		const seen = [];
		client.on("*", (event) => seen.push(event.seq));
		client.start();
		socket().open();
		socket().receive(ready(0));
		socket().receive(graphEvent(1, "node.updated", { origin: "tab_me" }));
		socket().receive(graphEvent(2, "node.updated", { origin: "tab_other" }));
		socket().receive(graphEvent(3, "node.updated"));
		socket().receive(graphEvent(4, "node.updated", { origin: "tab_me" }));
		expect(seen).toEqual([2, 3]);
		expect(client.lastSeq).toBe(4);
		clock.advance(ACK_DELAY_MS);
		expect(socket().sent.at(-1)).toEqual({ v: 1, type: "ack", seq: 4 });
	});

	it("dispatches everything when the client has no origin of its own", () => {
		const { client } = make({ origin: null });
		const seen = [];
		client.on("*", (event) => seen.push(event.seq));
		client.start();
		socket().open();
		socket().receive(graphEvent(1, "node.updated", { origin: "tab_me" }));
		expect(seen).toEqual([1]);
	});
});

describe("gap and resync", () => {
	it("tells the page to refetch, then says hello again from the gap's seq and goes live on ready", () => {
		const { client } = make();
		const log = [];
		client.on("gap", (detail) => log.push("gap " + detail.seq));
		client.on("ready", (detail) => log.push("ready " + detail.seq));
		client.on("*", (event) => log.push("event " + event.seq));
		client.start();
		socket().open();
		socket().receive(gap(500));
		expect(log).toEqual(["gap 500"]);
		expect(client.state).toBe("syncing");
		expect(socket().sent.at(-1)).toEqual({ v: 1, type: "hello", lastSeq: 500, topics: ["graph"] });
		socket().receive(ready(500));
		socket().receive(graphEvent(501));
		expect(log).toEqual(["gap 500", "ready 500", "event 501"]);
		expect(client.state).toBe("live");
	});

	it("does not replay what the gap made stale", () => {
		const { client } = make();
		const seen = [];
		client.on("*", (event) => seen.push(event.seq));
		client.start();
		socket().open();
		socket().receive(gap(500));
		socket().receive(graphEvent(499));
		expect(seen).toEqual([]);
	});

	it("resumes a dropped connection from the newest seq it saw", () => {
		const { client } = make();
		client.start();
		socket().open();
		socket().receive(ready(0));
		socket().receive(graphEvent(7));
		socket().drop();
		clock.advance(1000);
		expect(FakeSocket.instances).toHaveLength(2);
		socket().open();
		expect(socket().sent[0]).toEqual({ v: 1, type: "hello", lastSeq: 7, topics: ["graph"] });
	});
});

describe("reconnect backoff", () => {
	it("waits 1 s, 2 s, 4 s, 8 s, 16 s between failed attempts (jitter at its top)", () => {
		const { client } = make();
		client.start();
		const delays = [];
		client.on("reconnecting", (detail) => delays.push(detail.delay));
		for (let i = 0; i < 5; i++) {
			socket().drop();
			const wait = clock.pending()[0];
			clock.advance(wait);
		}
		expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
		expect(FakeSocket.instances).toHaveLength(6);
	});

	it("jitters between half and the whole step", () => {
		const { client } = make({ random: () => 0 });
		client.start();
		socket().drop();
		expect(clock.pending()).toEqual([500]);
		clock.advance(500);
		socket().drop();
		expect(clock.pending()).toEqual([1000]);
		expect(client.state).toBe("waiting");
	});

	it("gives up after repeated failures with a fallback event, and stops trying", () => {
		const { client } = make();
		const fallbacks = [];
		client.on("fallback", (detail) => fallbacks.push(detail));
		client.start();
		for (let i = 0; i < MAX_FAILURES; i++) {
			socket().drop();
			if (client.state === "waiting") clock.advance(clock.pending()[0]);
		}
		expect(client.state).toBe("fallback");
		expect(fallbacks).toEqual([{ failures: MAX_FAILURES }]);
		expect(FakeSocket.instances).toHaveLength(MAX_FAILURES);
		expect(clock.pending()).toEqual([]);
	});

	it("does not count a connection that reached ready toward the fallback", () => {
		const { client } = make();
		client.start();
		for (let i = 0; i < MAX_FAILURES + 3; i++) {
			socket().open();
			socket().receive(ready(i));
			socket().drop();
			clock.advance(clock.pending()[0]);
		}
		expect(client.state).not.toBe("fallback");
	});

	it("starts the backoff over after a stable session, but keeps climbing after one that drops at once", () => {
		const { client } = make();
		client.start();
		const delays = [];
		client.on("reconnecting", (detail) => delays.push(detail.delay));
		// Flapping: ready then dropped straight away, three times.
		for (let i = 0; i < 3; i++) {
			socket().open();
			socket().receive(ready(i));
			socket().drop();
			clock.advance(clock.pending()[0]);
		}
		expect(delays).toEqual([1000, 2000, 4000]);
		// A session that held.
		socket().open();
		socket().receive(ready(9));
		clock.advance(STABLE_AFTER_MS);
		socket().drop();
		expect(delays.at(-1)).toBe(1000);
	});

	it("treats a socket that throws on construction as a failed attempt", () => {
		class Broken {
			constructor() {
				throw new Error("blocked");
			}
		}
		const { client } = make({ WebSocketImpl: Broken });
		client.start();
		expect(client.state).toBe("waiting");
		expect(clock.pending()).toEqual([1000]);
	});
});

describe("keepalive", () => {
	it("pings every 30 s while open", () => {
		const { client } = make();
		client.start();
		socket().open();
		socket().receive(ready(0));
		clock.advance(KEEPALIVE_MS);
		expect(socket().sent.at(-1)).toEqual({ v: 1, type: "ping" });
		socket().receive({ v: 1, type: "pong" });
		clock.advance(KEEPALIVE_MS);
		expect(socket().sent.filter((m) => m.type === "ping")).toHaveLength(2);
	});

	it("drops a socket that has been silent too long and reconnects", () => {
		const { client } = make();
		client.start();
		socket().open();
		socket().receive(ready(0));
		// Pings go out at 30 s and 60 s unanswered; at 90 s the silence (> 75 s) condemns the socket.
		clock.advance(KEEPALIVE_MS * 2);
		expect(client.state).toBe("live");
		clock.advance(KEEPALIVE_MS);
		expect(KEEPALIVE_MS * 3).toBeGreaterThan(DEAD_AFTER_MS);
		expect(FakeSocket.instances[0].closedWith).not.toBeNull();
		expect(client.state).toBe("waiting");
		clock.advance(1000);
		expect(FakeSocket.instances).toHaveLength(2);
	});
});

describe("page visibility", () => {
	it("closes after a long hidden period and resumes at once when shown", () => {
		const { client } = make();
		client.start();
		socket().open();
		socket().receive(ready(0));
		socket().receive(graphEvent(5));
		hide();
		clock.advance(HIDDEN_CLOSE_MS - 1);
		expect(client.state).toBe("live");
		clock.advance(1);
		expect(client.state).toBe("sleeping");
		expect(FakeSocket.instances[0].closedWith.code).toBe(1000);
		clock.advance(120000);
		expect(FakeSocket.instances).toHaveLength(1);
		show();
		expect(FakeSocket.instances).toHaveLength(2);
		socket().open();
		expect(socket().sent[0]).toMatchObject({ type: "hello", lastSeq: 5 });
	});

	it("stays connected if the tab is shown again before the hidden period ends", () => {
		const { client } = make();
		client.start();
		socket().open();
		socket().receive(ready(0));
		hide();
		clock.advance(HIDDEN_CLOSE_MS / 2);
		show();
		for (let i = 0; i < 4; i++) {
			clock.advance(KEEPALIVE_MS);
			socket().receive({ v: 1, type: "pong" });
		}
		expect(client.state).toBe("live");
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("cuts a pending backoff short when the tab is shown, and when the network returns", () => {
		const { client, win } = make();
		client.start();
		socket().drop();
		expect(client.state).toBe("waiting");
		show();
		expect(FakeSocket.instances).toHaveLength(2);
		socket().drop();
		win.dispatchEvent(new Event("online"));
		expect(FakeSocket.instances).toHaveLength(3);
	});

	it("waits for the first view when started in a hidden tab", () => {
		doc.visibilityState = "hidden";
		const { client } = make();
		client.start();
		expect(FakeSocket.instances).toHaveLength(0);
		expect(client.state).toBe("sleeping");
		show();
		expect(FakeSocket.instances).toHaveLength(1);
	});
});

describe("stop", () => {
	it("closes the socket, cancels timers and ignores later events and visibility", () => {
		const { client, win } = make();
		const seen = [];
		client.on("*", (event) => seen.push(event));
		client.start();
		socket().open();
		socket().receive(ready(0));
		client.stop();
		expect(client.state).toBe("stopped");
		expect(FakeSocket.instances[0].closedWith.code).toBe(1000);
		expect(clock.pending()).toEqual([]);
		show();
		win.dispatchEvent(new Event("online"));
		clock.advance(60000);
		expect(FakeSocket.instances).toHaveLength(1);
		expect(seen).toEqual([]);
	});

	it("can be started again", () => {
		const { client } = make();
		client.start();
		client.stop();
		client.start();
		expect(FakeSocket.instances).toHaveLength(2);
		expect(client.state).toBe("connecting");
	});

	it("does not reconnect after a stop that races a drop", () => {
		const { client } = make();
		client.start();
		const first = socket();
		client.stop();
		first.drop();
		clock.advance(60000);
		expect(FakeSocket.instances).toHaveLength(1);
	});
});

describe("bootRealtime (DOM integration)", () => {
	const page = (metas) => {
		document.head.innerHTML = metas;
		delete window.AetherRealtime;
		window.AetherLiveClientId = "tab_dom";
	};

	it("stays off unless the page asks for it", () => {
		page('<meta name="aether-realtime" content="">');
		expect(bootRealtime(window, document, { WebSocketImpl: FakeSocket })).toBeNull();
		page("");
		expect(bootRealtime(window, document, { WebSocketImpl: FakeSocket })).toBeNull();
		expect(FakeSocket.instances).toHaveLength(0);
	});

	it("stays off where WebSocket does not exist", () => {
		page('<meta name="aether-realtime" content="1">');
		const saved = window.WebSocket;
		window.WebSocket = undefined;
		try {
			expect(bootRealtime(window, document)).toBeNull();
		} finally {
			window.WebSocket = saved;
		}
	});

	it("connects with the page's topics and origin, and turns hub messages into window events", () => {
		page('<meta name="aether-realtime" content="1"><meta name="aether-realtime-topics" content="graph, engine">');
		const client = bootRealtime(window, document, { WebSocketImpl: FakeSocket });
		expect(window.AetherRealtime).toBe(client);
		expect(socket().url).toMatch(/^wss?:\/\/.+\/api\/realtime$/);
		socket().open();
		expect(socket().sent[0]).toMatchObject({ type: "hello", topics: ["graph", "engine"] });

		const log = [];
		for (const name of ["event", "gap", "ready", "fallback"]) {
			window.addEventListener("aether-realtime-" + name, (event) => log.push([name, event.detail]));
		}
		socket().receive(ready(3));
		socket().receive(graphEvent(4, "node.created", { origin: "tab_dom" }));
		socket().receive(graphEvent(5, "node.deleted", { id: "n9", origin: "tab_other" }));
		socket().receive(gap(50));
		expect(log).toEqual([
			["ready", { seq: 3 }],
			["event", graphEvent(5, "node.deleted", { id: "n9", origin: "tab_other" })],
			["gap", { seq: 50 }],
		]);
		client.stop();
	});
});

describe("Mission Control refresh mapping", () => {
	it("maps every engine event type to the refreshers it wakes", () => {
		expect(refreshTargetsFor("agent.state")).toEqual(["breaker", "workforce", "banner"]);
		expect(refreshTargetsFor("task.awaiting")).toContain("banner");
		expect(refreshTargetsFor("graph.changed")).toEqual([]);
		for (const targets of Object.values(REFRESH_TARGETS)) expect(targets.length).toBeGreaterThan(0);
	});

	it("runs a refresher now when quiet, and a burst gets one trailing run", () => {
		const calls = [];
		const schedule = createRefreshCoalescer({ monitor: () => calls.push("monitor"), banner: () => calls.push("banner") }, { setTimer: clock.setTimer, now: clock.now });
		schedule(["monitor", "banner"]);
		expect(calls).toEqual(["monitor", "banner"]);
		for (let i = 0; i < 20; i++) schedule(["monitor"]);
		expect(calls).toHaveLength(2);
		clock.advance(500);
		expect(calls).toEqual(["monitor", "banner", "monitor"]);
	});

	it("survives a refresher that throws or rejects, and ignores unknown names", () => {
		const calls = [];
		const schedule = createRefreshCoalescer(
			{ a: () => { throw new Error("x"); }, b: () => Promise.reject(new Error("y")), c: () => calls.push("c") },
			{ setTimer: clock.setTimer, now: clock.now },
		);
		expect(() => schedule(["a", "b", "nope", "c"])).not.toThrow();
		expect(calls).toEqual(["c"]);
	});

	it("reacts to engine events on the window, ignores graph events, and refreshes everything on a gap", () => {
		const win = new EventTarget();
		const calls = [];
		const handlers = Object.fromEntries(["connection", "breaker", "workforce", "monitor", "banner"].map((name) => [name, () => calls.push(name)]));
		const mounted = mountRealtimeRefresh(win, handlers, { setTimer: clock.setTimer, now: clock.now });
		win.dispatchEvent(new CustomEvent("aether-realtime-event", { detail: engineEvent(1, "agent.state", { agent_id: "a", state: "HALTED" }) }));
		expect(calls).toEqual(["breaker", "workforce", "banner"]);
		win.dispatchEvent(new CustomEvent("aether-realtime-event", { detail: graphEvent(2) }));
		expect(calls).toHaveLength(3);
		clock.advance(1000);
		calls.length = 0;
		win.dispatchEvent(new CustomEvent("aether-realtime-gap", { detail: { seq: 9 } }));
		expect(calls.sort()).toEqual(["banner", "breaker", "connection", "monitor", "workforce"]);
		mounted.stop();
		clock.advance(1000);
		calls.length = 0;
		win.dispatchEvent(new CustomEvent("aether-realtime-gap", { detail: { seq: 10 } }));
		expect(calls).toEqual([]);
	});
});
