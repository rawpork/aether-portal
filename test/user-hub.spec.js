import { env, SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintEngineToken, mintEnginePushToken, verifyEnginePushToken } from "../src/engine-token.js";
import { PING_FRAME } from "../src/realtime/user-hub.js";
import { signSession } from "../src/index.js";
import {
	MAX_CONNECTIONS_PER_USER,
	RING_MAX_EVENTS,
	ackMessage,
	helloMessage,
	validateEnvelope,
} from "../public/js/realtime-protocol.js";

let counter = 0;
const freshStub = () => env.USER_HUB.get(env.USER_HUB.idFromName("hub_user_" + ++counter + "_" + Math.random().toString(36).slice(2)));

// Opens a socket to a hub the way the Worker does, and collects what arrives.
async function open(stub, role = "client") {
	const response = await stub.fetch("https://user-hub/connect", { headers: { Upgrade: "websocket", "X-Hub-Role": role } });
	expect(response.status).toBe(101);
	const ws = response.webSocket;
	ws.accept();
	const socket = { ws, messages: [], closed: null, waiters: [] };
	ws.addEventListener("message", (event) => {
		socket.messages.push(JSON.parse(event.data));
		socket.waiters.splice(0).forEach((wake) => wake());
	});
	ws.addEventListener("close", (event) => {
		socket.closed = { code: event.code, reason: event.reason };
		socket.waiters.splice(0).forEach((wake) => wake());
	});
	socket.send = (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message));
	// Resolves once `count` messages have arrived (or the socket closed), then returns them all.
	socket.until = async (count) => {
		for (let i = 0; i < 200 && socket.messages.length < count && !socket.closed; i++) {
			await new Promise((resolve) => {
				socket.waiters.push(resolve);
				setTimeout(resolve, 25);
			});
		}
		return socket.messages;
	};
	socket.untilClosed = async () => {
		for (let i = 0; i < 200 && !socket.closed; i++) await new Promise((resolve) => (socket.waiters.push(resolve), setTimeout(resolve, 25)));
		return socket.closed;
	};
	return socket;
}

const publish = (stub, event, origin) =>
	stub.fetch("https://user-hub/publish", { method: "POST", body: JSON.stringify({ event, origin }) });
const types = (messages) => messages.map((message) => message.type);

// A tab that has said hello for `topics` from the start.
async function tab(stub, topics = ["graph", "engine"], lastSeq = 0) {
	const socket = await open(stub);
	socket.send(helloMessage(lastSeq, topics));
	await socket.until(1);
	return socket;
}

describe("UserHub instantiation", () => {
	it("starts empty, counting from zero", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, (hub) => {
			expect(hub.head).toBe(0);
			expect(hub.ring).toEqual([]);
			expect(hub.engine.online).toBe(false);
		});
	});

	it("is a separate hub per user", async () => {
		const a = freshStub();
		const b = freshStub();
		const watcher = await tab(a);
		await publish(b, { type: "node.created" });
		await publish(a, { type: "node.deleted", id: "n1" });
		const messages = await watcher.until(2);
		expect(messages.map((m) => m.type)).toEqual(["ready", "node.deleted"]);
	});
});

describe("WebSocket upgrade", () => {
	it("refuses a request that is not an upgrade", async () => {
		const response = await freshStub().fetch("https://user-hub/connect", { headers: { "X-Hub-Role": "client" } });
		expect(response.status).toBe(426);
	});

	it("refuses an unknown role", async () => {
		const response = await freshStub().fetch("https://user-hub/connect", { headers: { Upgrade: "websocket", "X-Hub-Role": "admin" } });
		expect(response.status).toBe(400);
	});

	it("caps a user's tabs, and a slot frees when one closes", async () => {
		const stub = freshStub();
		const sockets = [];
		for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) sockets.push(await open(stub));
		const refused = await stub.fetch("https://user-hub/connect", { headers: { Upgrade: "websocket", "X-Hub-Role": "client" } });
		expect(refused.status).toBe(429);
		sockets[0].ws.close(1000, "bye");
		await sockets[0].untilClosed();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await open(stub)).ws).toBeTruthy();
	});

	it("does not count the engine against the tab cap", async () => {
		const stub = freshStub();
		for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) await open(stub);
		expect((await open(stub, "engine")).ws).toBeTruthy();
	});

	it("keeps one engine: a new connection replaces the old", async () => {
		const stub = freshStub();
		const first = await open(stub, "engine");
		await open(stub, "engine");
		expect((await first.untilClosed()).code).toBe(1012);
	});
});

describe("hello, ready and gap", () => {
	it("answers a first hello on a fresh hub with ready at seq 0", async () => {
		const socket = await tab(freshStub());
		expect(socket.messages).toEqual([{ v: 1, type: "ready", seq: 0 }]);
	});

	it("tells a tab in its ready whether the engine is online, even after engine.hello left the ring", async () => {
		const stub = freshStub();
		expect((await tab(stub, ["engine"])).messages).toEqual([{ v: 1, type: "ready", seq: 0 }]);
		const engine = await open(stub, "engine");
		engine.send({ v: 1, topic: "engine", type: "engine.hello", data: { version: "1.0.0" } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		// A tab that is already current (lastSeq at the head) gets no replay, so ready is the only place it can learn this.
		const late = await open(stub);
		late.send(helloMessage(1, ["engine"]));
		expect(await late.until(1)).toEqual([{ v: 1, type: "ready", seq: 1, engine: true }]);
		engine.ws.close(1000, "bye");
		await new Promise((resolve) => setTimeout(resolve, 100));
		const after = await open(stub);
		after.send(helloMessage(2, ["engine"]));
		expect(await after.until(1)).toEqual([{ v: 1, type: "ready", seq: 2 }]);
	});

	it("sends nothing before hello", async () => {
		const stub = freshStub();
		const socket = await open(stub);
		await publish(stub, { type: "node.created" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(socket.messages).toEqual([]);
	});

	it("replays what a reconnecting tab missed, in order, then ready", async () => {
		const stub = freshStub();
		for (const type of ["node.created", "node.updated", "link.created", "group.updated"]) await publish(stub, { type });
		const socket = await open(stub);
		socket.send(helloMessage(2, ["graph"]));
		const messages = await socket.until(3);
		expect(messages.map((m) => (m.type === "ready" ? "ready" : m.seq))).toEqual([3, 4, "ready"]);
		expect(messages.slice(0, 2).every((m) => validateEnvelope(m).ok)).toBe(true);
		expect(messages[2]).toEqual({ v: 1, type: "ready", seq: 4 });
	});

	it("replays only the topics asked for", async () => {
		const stub = freshStub();
		await publish(stub, { type: "node.created" });
		const engine = await open(stub, "engine");
		engine.send({ v: 1, topic: "engine", type: "engine.hello", data: { version: "1.0.0" } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const socket = await open(stub);
		socket.send(helloMessage(0 + 1, ["engine"]));
		const messages = await socket.until(2);
		expect(types(messages)).toEqual(["engine.hello", "ready"]);
	});

	it("is current, with no replay, when lastSeq equals the head", async () => {
		const stub = freshStub();
		await publish(stub, { type: "node.created" });
		const socket = await open(stub);
		socket.send(helloMessage(1, ["graph"]));
		expect(await socket.until(1)).toEqual([{ v: 1, type: "ready", seq: 1 }]);
	});

	it("says gap when the ring no longer holds what the tab missed", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, async (hub) => {
			for (let i = 0; i < RING_MAX_EVENTS + 5; i++) await hub.append((seq, at) => ({ v: 1, seq, at, topic: "graph", type: "node.updated" }));
		});
		const socket = await open(stub);
		socket.send(helloMessage(3, ["graph"]));
		expect(await socket.until(1)).toEqual([{ v: 1, type: "gap", seq: RING_MAX_EVENTS + 5 }]);
	});

	it("says gap to a first connection (lastSeq 0) on a hub that already has history beyond the ring", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, async (hub) => {
			for (let i = 0; i < RING_MAX_EVENTS + 1; i++) await hub.append((seq, at) => ({ v: 1, seq, at, topic: "graph", type: "node.updated" }));
		});
		const socket = await open(stub);
		socket.send(helloMessage(0, ["graph"]));
		expect((await socket.until(1))[0].type).toBe("gap");
	});

	it("says gap when the tab is ahead of a hub that lost its counter", async () => {
		const socket = await open(freshStub());
		socket.send(helloMessage(99, ["graph"]));
		expect(await socket.until(1)).toEqual([{ v: 1, type: "gap", seq: 0 }]);
	});

	it("lets a tab carry on from a gap's seq with no further gap", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, async (hub) => {
			for (let i = 0; i < RING_MAX_EVENTS + 5; i++) await hub.append((seq, at) => ({ v: 1, seq, at, topic: "graph", type: "node.updated" }));
		});
		const socket = await open(stub);
		socket.send(helloMessage(1, ["graph"]));
		const [gap] = await socket.until(1);
		socket.send(helloMessage(gap.seq, ["graph"]));
		expect((await socket.until(2))[1]).toEqual({ v: 1, type: "ready", seq: gap.seq });
	});
});

describe("ring buffer storage", () => {
	it("persists events and the counter, and a restarted hub keeps counting", async () => {
		const stub = freshStub();
		await publish(stub, { type: "node.created" });
		await publish(stub, { type: "node.updated", id: "n7" }, "tab_1");
		await runInDurableObject(stub, async (hub, state) => {
			expect(await state.storage.get("head")).toBe(2);
			const stored = await state.storage.list({ prefix: "e:" });
			expect([...stored.values()].map((event) => event.seq)).toEqual([1, 2]);
			// A fresh instance reading the same storage, as after eviction.
			hub.head = 0;
			hub.ring = [];
			await hub.load();
			expect(hub.head).toBe(2);
			expect(hub.ring.map((event) => event.seq)).toEqual([1, 2]);
			expect(hub.ring[1]).toMatchObject({ topic: "graph", type: "node.updated", id: "n7", origin: "tab_1" });
		});
		const response = await publish(stub, { type: "node.deleted", id: "n7" });
		expect(await response.json()).toEqual({ seq: 3 });
	});

	it("trims storage to 200 events", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, async (hub, state) => {
			for (let i = 0; i < RING_MAX_EVENTS + 20; i++) await hub.append((seq, at) => ({ v: 1, seq, at, topic: "graph", type: "node.updated" }));
			const stored = await state.storage.list({ prefix: "e:" });
			expect(stored.size).toBe(RING_MAX_EVENTS);
			expect(hub.ring[0].seq).toBe(21);
			expect(await state.storage.get("head")).toBe(RING_MAX_EVENTS + 20);
		});
	});

	it("drops events older than ten minutes when the hub loads", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, async (hub, state) => {
			const old = { v: 1, seq: 1, at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), topic: "graph", type: "node.created" };
			const recent = { v: 1, seq: 2, at: new Date().toISOString(), topic: "graph", type: "node.updated" };
			await state.storage.put({ head: 2, "e:000000000001": old, "e:000000000002": recent });
			await hub.load();
			expect(hub.ring.map((event) => event.seq)).toEqual([2]);
			expect((await state.storage.list({ prefix: "e:" })).size).toBe(1);
		});
	});
});

describe("fanout", () => {
	it("sends a published graph event to every subscribed tab with the next seq", async () => {
		const stub = freshStub();
		const [one, two] = [await tab(stub, ["graph"]), await tab(stub, ["graph"])];
		await publish(stub, { type: "link.created" }, "tab_9");
		for (const socket of [one, two]) {
			const [, event] = await socket.until(2);
			expect(event).toMatchObject({ v: 1, seq: 1, topic: "graph", type: "link.created", origin: "tab_9" });
			expect(validateEnvelope(event).ok).toBe(true);
		}
	});

	it("routes validated engine events to tabs, stamped by the hub", async () => {
		const stub = freshStub();
		const watcher = await tab(stub, ["engine"]);
		const engine = await open(stub, "engine");
		engine.send({ v: 1, topic: "engine", type: "agent.state", data: { agent_id: "master-brain", state: "HALTED", reason: "Paused" } });
		engine.send({ v: 1, topic: "engine", type: "task.step", data: { task_id: "t1", agent_id: "a1", status: "running", completed_steps: 1, total_steps: 4 } });
		engine.send({ v: 1, topic: "engine", type: "task.awaiting", data: { task_id: "t1", agent_id: "a1", question: "Deploy?" } });
		const messages = await watcher.until(4);
		expect(types(messages)).toEqual(["ready", "agent.state", "task.step", "task.awaiting"]);
		expect(messages.slice(1).map((m) => m.seq)).toEqual([1, 2, 3]);
		expect(messages[1].data).toEqual({ agent_id: "master-brain", state: "HALTED", reason: "Paused" });
		expect(messages.slice(1).every((m) => validateEnvelope(m).ok)).toBe(true);
	});

	it("keeps graph and engine events to the tabs that asked for them", async () => {
		const stub = freshStub();
		const graphOnly = await tab(stub, ["graph"]);
		const engineOnly = await tab(stub, ["engine"]);
		await publish(stub, { type: "node.created" });
		const engine = await open(stub, "engine");
		engine.send({ v: 1, topic: "engine", type: "engine.hello", data: { version: "1.0.0" } });
		expect(types(await graphOnly.until(2))).toEqual(["ready", "node.created"]);
		expect(types(await engineOnly.until(2))).toEqual(["ready", "engine.hello"]);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(graphOnly.messages).toHaveLength(2);
		expect(engineOnly.messages).toHaveLength(2);
	});

	it("never echoes engine or graph events back to the engine socket", async () => {
		const stub = freshStub();
		const engine = await open(stub, "engine");
		await publish(stub, { type: "node.created" });
		engine.send({ v: 1, topic: "engine", type: "engine.hello", data: { version: "1.0.0" } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(engine.messages).toEqual([]);
	});

	it("refuses to publish a malformed graph event", async () => {
		const stub = freshStub();
		expect((await publish(stub, { type: "<script>" })).status).toBe(400);
		expect((await publish(stub, { type: "agent.state" })).status).toBe(400);
		const bare = await stub.fetch("https://user-hub/publish", { method: "POST", body: "null" });
		expect(bare.status).toBe(400);
	});
});

describe("message hygiene", () => {
	it("answers ping with pong", async () => {
		const socket = await open(freshStub());
		socket.send(JSON.stringify({ v: 1, type: "ping", extra: 1 }));
		expect(await socket.until(1)).toEqual([{ v: 1, type: "pong" }]);
	});

	it("auto-answers the exact ping frame without waking the hub", async () => {
		const socket = await open(freshStub());
		socket.send(PING_FRAME);
		expect(await socket.until(1)).toEqual([{ v: 1, type: "pong" }]);
	});

	it("accepts ack silently", async () => {
		const socket = await tab(freshStub());
		socket.send(ackMessage(0));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(socket.messages).toHaveLength(1);
	});

	it("does not let a tab write: engine events and data verbs are invalid from a tab", async () => {
		const stub = freshStub();
		const watcher = await tab(stub, ["engine"]);
		const rogue = await open(stub);
		rogue.send({ v: 1, topic: "engine", type: "agent.state", data: { agent_id: "x", state: "HALTED" } });
		rogue.send({ v: 1, type: "create", node: {} });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(watcher.messages).toEqual([{ v: 1, type: "ready", seq: 0 }]);
		expect(await stub.fetch("https://user-hub/nothing").then((r) => r.status)).toBe(404);
	});

	it("drops invalid engine events and closes a connection that keeps sending them", async () => {
		const stub = freshStub();
		const watcher = await tab(stub, ["engine"]);
		const engine = await open(stub, "engine");
		for (let i = 0; i < 5; i++) engine.send({ v: 1, topic: "engine", type: "task.choice", data: { task_id: "t", option: "yes", transcript: "secret" } });
		expect((await engine.untilClosed()).code).toBe(1008);
		expect(watcher.messages).toEqual([{ v: 1, type: "ready", seq: 0 }]);
	});

	it("closes on a frame over 4 KB, on non-JSON, and on binary data", async () => {
		const big = await open(freshStub());
		big.send(JSON.stringify({ v: 1, type: "ping", pad: "x".repeat(5000) }));
		expect((await big.untilClosed()).code).toBe(1009);
		const junk = await open(freshStub());
		junk.send("not json");
		expect((await junk.untilClosed()).code).toBe(1003);
		const binary = await open(freshStub());
		binary.ws.send(new Uint8Array([1, 2, 3]));
		expect((await binary.untilClosed()).code).toBe(1003);
	});

	it("closes a tab that floods the hub", async () => {
		const socket = await open(freshStub());
		for (let i = 0; i < 30; i++) socket.send(JSON.stringify({ v: 1, type: "ack", seq: 0 }));
		expect((await socket.untilClosed()).code).toBe(1008);
	});
});

describe("engine presence", () => {
	const hello = { v: 1, topic: "engine", type: "engine.hello", data: { version: "1.0.0" } };

	it("announces engine.bye the moment the engine's socket closes", async () => {
		const stub = freshStub();
		const watcher = await tab(stub, ["engine"]);
		const engine = await open(stub, "engine");
		engine.send(hello);
		await watcher.until(2);
		engine.ws.close(1000, "bye");
		const messages = await watcher.until(3);
		expect(messages[2]).toMatchObject({ type: "engine.bye", data: { reason: "disconnected" } });
	});

	it("does not announce engine.bye when a new engine connection replaced the old", async () => {
		const stub = freshStub();
		const watcher = await tab(stub, ["engine"]);
		const first = await open(stub, "engine");
		first.send(hello);
		await watcher.until(2);
		const second = await open(stub, "engine");
		await first.untilClosed();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(types(watcher.messages)).toEqual(["ready", "engine.hello"]);
		second.ws.close(1000, "done");
	});

	it("announces engine.bye after 60 s of silence, and not before", async () => {
		const stub = freshStub();
		const watcher = await tab(stub, ["engine"]);
		const engine = await open(stub, "engine");
		engine.send(hello);
		await watcher.until(2);
		// Not yet silent: the alarm re-arms and says nothing.
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(types(watcher.messages)).toEqual(["ready", "engine.hello"]);
		// Pretend the last sign of life was a minute ago.
		await runInDurableObject(stub, (hub) => {
			hub.engine = { online: true, at: Date.now() - 61000 };
		});
		await runDurableObjectAlarm(stub);
		const messages = await watcher.until(3);
		expect(messages[2]).toMatchObject({ type: "engine.bye", data: { reason: "silent for 60 s" } });
		await runInDurableObject(stub, (hub) => expect(hub.engine.online).toBe(false));
	});

	it("reports the engine online again after a new hello", async () => {
		const stub = freshStub();
		await runInDurableObject(stub, async (hub) => {
			await hub.engineOffline("test");
			expect(hub.engine.online).toBe(false);
		});
		const engine = await open(stub, "engine");
		engine.send(hello);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await runInDurableObject(stub, (hub) => expect(hub.engine.online).toBe(true));
	});
});

describe("engine:push tokens", () => {
	const secret = "test-engine-secret";
	const now = Date.UTC(2026, 9, 7, 12);

	it("verify a fresh token for its user", async () => {
		const token = await mintEnginePushToken("user_7", secret, now);
		expect(await verifyEnginePushToken(token, secret, now + 1000)).toEqual({ userId: "user_7" });
	});

	it("refuse a wrong secret, an expired token, and a tampered one", async () => {
		const token = await mintEnginePushToken("user_7", secret, now);
		expect(await verifyEnginePushToken(token, "other", now)).toBeNull();
		expect(await verifyEnginePushToken(token, secret, now + 301 * 1000)).toBeNull();
		const [header, claims, signature] = token.split(".");
		const forged = btoa(JSON.stringify({ ...JSON.parse(atob(claims)), sub: "portal:user_8" })).replace(/=+$/, "");
		expect(await verifyEnginePushToken([header, forged, signature].join("."), secret, now)).toBeNull();
	});

	it("refuse a token that lives longer than five minutes", async () => {
		expect(await verifyEnginePushToken(await mintEnginePushToken("u", secret, now, 301), secret, now)).toBeNull();
	});

	it("refuse the portal's ordinary engine token", async () => {
		const { token } = await mintEngineToken("user_7", secret, now);
		expect(await verifyEnginePushToken(token, secret, now)).toBeNull();
	});

	it("refuse junk", async () => {
		for (const token of [null, "", "a.b", "a.b.c", "....", undefined]) expect(await verifyEnginePushToken(token, secret, now)).toBeNull();
		expect(await verifyEnginePushToken("a.b.c", "", now)).toBeNull();
	});
});

describe("Worker routes", () => {
	const upgrade = { Upgrade: "websocket" };
	const sessionFor = async (id) => "aether_session=" + (await signSession(id, env.SESSION_SECRET));

	it("/api/realtime requires sign-in, an upgrade, and our own Origin", async () => {
		expect((await SELF.fetch("http://example.com/api/realtime", { headers: upgrade })).status).toBe(401);
		const cookie = await sessionFor("user_route_a");
		expect((await SELF.fetch("http://example.com/api/realtime", { headers: { Cookie: cookie } })).status).toBe(426);
		expect((await SELF.fetch("http://example.com/api/realtime", { headers: { ...upgrade, Cookie: cookie } })).status).toBe(403);
		expect((await SELF.fetch("http://example.com/api/realtime", { headers: { ...upgrade, Cookie: cookie, Origin: "http://evil.example" } })).status).toBe(403);
	});

	it("/api/realtime allows only GET", async () => {
		const response = await SELF.fetch("http://example.com/api/realtime", { method: "POST" });
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});

	it("/api/realtime upgrades a signed-in tab from our own origin, and it can say hello", async () => {
		const response = await SELF.fetch("http://example.com/api/realtime", {
			headers: { ...upgrade, Cookie: await sessionFor("user_route_b"), Origin: "http://example.com" },
		});
		expect(response.status).toBe(101);
		const ws = response.webSocket;
		ws.accept();
		const first = new Promise((resolve) => ws.addEventListener("message", (event) => resolve(JSON.parse(event.data))));
		ws.send(JSON.stringify(helloMessage(0, ["graph"])));
		expect(await first).toEqual({ v: 1, type: "ready", seq: 0 });
		ws.close(1000, "done");
	});

	it("/api/engine/connect needs an engine:push token, not a session or an ordinary engine token", async () => {
		const secret = env.ENGINE_JWT_SECRET || "route-test-secret";
		const url = "http://example.com/api/engine/connect";
		expect((await SELF.fetch(url, { headers: upgrade })).status).toBe(401);
		expect((await SELF.fetch(url, { headers: { ...upgrade, Cookie: await sessionFor("user_route_c") } })).status).toBe(401);
		if (env.ENGINE_JWT_SECRET) {
			const { token } = await mintEngineToken("user_route_c", secret);
			expect((await SELF.fetch(url, { headers: { ...upgrade, Authorization: "Bearer " + token } })).status).toBe(401);
			const push = await mintEnginePushToken("user_route_c", secret);
			const response = await SELF.fetch(url, { headers: { ...upgrade, Authorization: "Bearer " + push } });
			expect(response.status).toBe(101);
			response.webSocket.accept();
			response.webSocket.close(1000, "done");
		}
	});

	it("an engine:push token does not open a tab socket or read the graph", async () => {
		const secret = env.ENGINE_JWT_SECRET || "route-test-secret";
		const push = await mintEnginePushToken("user_route_d", secret);
		const headers = { Authorization: "Bearer " + push };
		expect((await SELF.fetch("http://example.com/api/realtime", { headers: { ...upgrade, ...headers, Origin: "http://example.com" } })).status).toBe(401);
		expect((await SELF.fetch("http://example.com/api/graph", { headers })).status).toBe(401);
	});

	it("REALTIME=off is a 404 for both routes", async () => {
		const { connectRealtime } = await import("../src/index.js").then((module) => ({ connectRealtime: module.default.route }));
		const off = { ...env, REALTIME: "off" };
		for (const path of ["/api/realtime", "/api/engine/connect"]) {
			const response = await connectRealtime.call(
				{},
				new Request("http://example.com" + path, { headers: upgrade }),
				off,
				{ waitUntil() {} },
			);
			expect(response.status).toBe(404);
		}
	});
});
