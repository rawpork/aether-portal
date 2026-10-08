import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { publishGraphEvent } from "../src/graph-events.js";
import { signSession } from "../src/index.js";
import { helloMessage, validateEnvelope } from "../public/js/realtime-protocol.js";

const sessionFor = async (id) => "aether_session=" + (await signSession(id, env.SESSION_SECRET));

// A tab connected through the real route, collecting the hub's messages.
async function connectTab(userId, topics = ["graph"]) {
	const response = await SELF.fetch("http://example.com/api/realtime", {
		headers: { Upgrade: "websocket", Cookie: await sessionFor(userId), Origin: "http://example.com" },
	});
	expect(response.status).toBe(101);
	const ws = response.webSocket;
	ws.accept();
	const tab = { ws, messages: [], waiters: [] };
	ws.addEventListener("message", (event) => {
		tab.messages.push(JSON.parse(event.data));
		tab.waiters.splice(0).forEach((wake) => wake());
	});
	tab.until = async (count) => {
		for (let i = 0; i < 200 && tab.messages.length < count; i++) {
			await new Promise((resolve) => (tab.waiters.push(resolve), setTimeout(resolve, 25)));
		}
		return tab.messages;
	};
	ws.send(JSON.stringify(helloMessage(0, topics)));
	await tab.until(1);
	return tab;
}

const hubStub = (userId) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));
const sse = async (userId) => {
	const response = await env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName(userId)).fetch("https://graph-events/subscribe");
	return response.body.getReader();
};
const readSse = async (reader, text) => {
	let seen = "";
	for (let i = 0; i < 6 && !seen.includes(text); i++) {
		const { value, done } = await reader.read();
		if (done) break;
		seen += new TextDecoder().decode(value);
	}
	return seen;
};
const publishDirect = (userId, type) =>
	hubStub(userId).fetch("https://user-hub/publish", { method: "POST", body: JSON.stringify({ event: { type } }) }).then((r) => r.json());

describe("publishGraphEvent dual publish", () => {
	it("delivers the same event to a WebSocket tab and an SSE stream", async () => {
		const user = "user_r2_parity";
		const tab = await connectTab(user);
		const stream = await sse(user);
		await readSse(stream, "connected");
		await publishGraphEvent(env, user, { type: "node.updated", id: "node_p1" }, "tab_77");

		const [, event] = await tab.until(2);
		expect(validateEnvelope(event).ok).toBe(true);
		expect(event).toMatchObject({ v: 1, seq: 1, topic: "graph", type: "node.updated", id: "node_p1", origin: "tab_77" });
		const text = await readSse(stream, "node_p1");
		expect(text).toContain("event: node.updated");
		expect(text).toContain('"id":"node_p1"');
		expect(text).toContain('"origin":"tab_77"');
		await stream.cancel();
		tab.ws.close(1000, "done");
	});

	it("delivers every graph event type the Worker can announce", async () => {
		const user = "user_r2_types";
		const tab = await connectTab(user);
		const types = ["node.created", "node.updated", "node.deleted", "link.created", "link.updated", "link.deleted", "group.updated", "settings.updated", "graph.changed"];
		for (const type of types) await publishGraphEvent(env, user, { type });
		const messages = (await tab.until(types.length + 1)).slice(1);
		expect(messages.map((m) => m.type)).toEqual(types);
		expect(messages.map((m) => m.seq)).toEqual(types.map((_, i) => i + 1));
		tab.ws.close(1000, "done");
	});

	it("keeps the event on one user's hub", async () => {
		const mine = await connectTab("user_r2_iso_a");
		const theirs = await connectTab("user_r2_iso_b");
		await publishGraphEvent(env, "user_r2_iso_a", { type: "node.created" });
		await mine.until(2);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(theirs.messages).toHaveLength(1);
		mine.ws.close(1000, "done");
		theirs.ws.close(1000, "done");
	});

	it("still reaches the SSE stream when REALTIME is off, and skips the hub", async () => {
		const user = "user_r2_off";
		const stream = await sse(user);
		await readSse(stream, "connected");
		await publishGraphEvent({ ...env, REALTIME: "off" }, user, { type: "link.created" });
		expect(await readSse(stream, "link.created")).toContain("event: link.created");
		// The hub saw nothing: its first event is still seq 1.
		expect((await publishDirect(user, "graph.changed")).seq).toBe(1);
		await stream.cancel();
	});

	it("still reaches the hub when the SSE binding is absent, and reports a failing transport", async () => {
		const user = "user_r2_nosse";
		const tab = await connectTab(user);
		const { GRAPH_EVENTS, ...withoutStream } = env;
		await publishGraphEvent(withoutStream, user, { type: "group.updated" });
		expect((await tab.until(2))[1].type).toBe("group.updated");
		const broken = { ...env, GRAPH_EVENTS: { get: () => ({ fetch: () => Promise.reject(new Error("sse down")) }), idFromName: (x) => x } };
		await expect(publishGraphEvent(broken, user, { type: "node.created" })).rejects.toThrow("sse down");
		// The failing SSE side did not stop the hub.
		expect((await tab.until(3))[2].type).toBe("node.created");
		tab.ws.close(1000, "done");
	});

	it("does nothing without a user", async () => {
		await expect(publishGraphEvent(env, "", { type: "node.created" })).resolves.toBeUndefined();
	});
});

describe("a REST mutation announces itself through the hub", () => {
	it("a successful write reaches a connected tab, carrying the writer's tab id; a refused write announces nothing", async () => {
		const user = "user_r2_rest";
		// The test database has no migrations applied; the settings write needs only this much of the users table.
		await env.DB.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, connection_depth TEXT)");
		const tab = await connectTab(user);
		const refused = await SELF.fetch("http://example.com/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: await sessionFor(user), Origin: "http://evil.example" },
			body: JSON.stringify({ connection_depth: "abstract" }),
		});
		expect(refused.ok).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(tab.messages).toHaveLength(1);

		const written = await SELF.fetch("http://example.com/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: await sessionFor(user), Origin: "http://example.com", "X-Aether-Client": "tab_writer" },
			body: JSON.stringify({ connection_depth: "abstract" }),
		});
		expect(written.status).toBe(200);
		const [, event] = await tab.until(2);
		expect(event).toMatchObject({ topic: "graph", type: "settings.updated", origin: "tab_writer" });
		expect(tab.messages).toHaveLength(2);
		tab.ws.close(1000, "done");
	});
});

describe("internal publishing is not throttled", () => {
	it("takes a burst far above the per-socket message limit", async () => {
		const user = "user_r2_burst";
		const tab = await connectTab(user);
		for (let i = 0; i < 60; i++) await publishGraphEvent(env, user, { type: "node.updated", id: "n" + i });
		const messages = await tab.until(61);
		expect(messages).toHaveLength(61);
		expect(messages.at(-1).seq).toBe(60);
		tab.ws.close(1000, "done");
	});

	it("is not reachable from outside: no public route forwards to the hub's /publish", async () => {
		const user = "user_r2_closed";
		const cookie = await sessionFor(user);
		for (const path of ["/api/realtime/publish", "/publish", "/api/engine/publish"]) {
			const response = await SELF.fetch("http://example.com" + path, {
				method: "POST",
				headers: { Cookie: cookie, Origin: "http://example.com", "Content-Type": "application/json" },
				body: JSON.stringify({ event: { type: "node.created" } }),
			});
			expect(response.headers.get("Content-Type") || "", path).not.toContain("application/json; seq");
			expect(await response.clone().text(), path).not.toContain('"seq"');
		}
		// Nothing above reached the hub: its first event is still seq 1.
		expect((await publishDirect(user, "graph.changed")).seq).toBe(1);
	});

	it("lets the engine push 40 frames in a burst, where a tab would be closed at 10 a second", async () => {
		const user = "user_r2_engine";
		const tab = await connectTab(user, ["engine"]);
		const response = await hubStub(user).fetch("https://user-hub/connect", { headers: { Upgrade: "websocket", "X-Hub-Role": "engine" } });
		const engine = response.webSocket;
		engine.accept();
		for (let i = 0; i < 40; i++) {
			engine.send(JSON.stringify({ v: 1, topic: "engine", type: "task.step", data: { task_id: "t", agent_id: "a", status: "running", completed_steps: i, total_steps: 40 } }));
		}
		const messages = await tab.until(41);
		expect(messages).toHaveLength(41);
		expect(messages.slice(1).every((m) => validateEnvelope(m).ok)).toBe(true);
		engine.close(1000, "done");
		tab.ws.close(1000, "done");
	});
});
