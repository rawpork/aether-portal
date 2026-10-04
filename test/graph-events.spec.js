import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { formatSseEvent, GRAPH_EVENT_TYPES, graphEventFor } from "../src/graph-events.js";

const decoder = new TextDecoder();
// Reads from an SSE body until `text` has arrived (or gives up after a few chunks).
const readUntil = async (reader, text, chunks = 6) => {
	let seen = "";
	for (let i = 0; i < chunks && !seen.includes(text); i++) {
		const { value, done } = await reader.read();
		if (done) break;
		seen += decoder.decode(value);
	}
	return seen;
};

describe("graphEventFor", () => {
	it("names the change each graph write makes", () => {
		expect(graphEventFor("POST", "/api/node")).toEqual({ type: "node.created" });
		expect(graphEventFor("PATCH", "/api/node/node_a%20b")).toEqual({ type: "node.updated", id: "node_a b" });
		expect(graphEventFor("DELETE", "/api/node/node_a")).toEqual({ type: "node.deleted", id: "node_a" });
		expect(graphEventFor("POST", "/api/link")).toEqual({ type: "link.created" });
		expect(graphEventFor("PATCH", "/api/link")).toEqual({ type: "link.updated" });
		expect(graphEventFor("DELETE", "/api/link")).toEqual({ type: "link.deleted" });
		expect(graphEventFor("PATCH", "/api/groups/grp_1")).toEqual({ type: "group.updated" });
		expect(graphEventFor("POST", "/api/share")).toEqual({ type: "node.created" });
		expect(graphEventFor("POST", "/api/outcome/node_o/regenerate")).toEqual({ type: "node.updated" });
		expect(graphEventFor("PATCH", "/api/settings")).toEqual({ type: "settings.updated" });
	});

	it("ignores reads and requests that change nothing on the graph", () => {
		for (const [method, path] of [["GET", "/api/graph"], ["GET", "/api/node/x"], ["POST", "/api/auth/logout"], ["POST", "/api/engine/relay/api/tasks"], ["GET", "/api/events"]]) {
			expect(graphEventFor(method, path), method + " " + path).toBeNull();
		}
	});

	it("only produces types the stream accepts", () => {
		for (const [method, path] of [["POST", "/api/node"], ["DELETE", "/api/node/a"], ["DELETE", "/api/link"], ["POST", "/api/groups"], ["POST", "/api/ask"]]) {
			expect(GRAPH_EVENT_TYPES).toContain(graphEventFor(method, path).type);
		}
	});
});

describe("formatSseEvent", () => {
	it("writes one named SSE message with the event as JSON", () => {
		expect(formatSseEvent({ type: "node.deleted", id: "n1" })).toBe('event: node.deleted\ndata: {"type":"node.deleted","id":"n1"}\n\n');
	});
});

describe("GraphEvents Durable Object", () => {
	it("streams published events to every open subscriber of the same user", async () => {
		const stub = env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName("user_stream_test"));
		const first = await stub.fetch("https://graph-events/subscribe");
		const second = await stub.fetch("https://graph-events/subscribe");
		expect(first.headers.get("Content-Type")).toBe("text/event-stream");
		const readers = [first.body.getReader(), second.body.getReader()];
		for (const reader of readers) expect(await readUntil(reader, "connected")).toContain("retry:");

		const published = await stub.fetch("https://graph-events/publish", {
			method: "POST",
			body: JSON.stringify({ type: "link.created", origin: "tab_1" }),
		});
		expect(published.status).toBe(204);
		for (const reader of readers) {
			const text = await readUntil(reader, "link.created");
			expect(text).toContain("event: link.created");
			expect(text).toContain('"origin":"tab_1"');
		}
		await Promise.all(readers.map(reader => reader.cancel()));
	});

	it("keeps each user's events to that user", async () => {
		const mine = env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName("user_a_isolation"));
		const theirs = env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName("user_b_isolation"));
		const reader = (await mine.fetch("https://graph-events/subscribe")).body.getReader();
		await readUntil(reader, "connected");
		await theirs.fetch("https://graph-events/publish", { method: "POST", body: JSON.stringify({ type: "node.deleted" }) });
		await mine.fetch("https://graph-events/publish", { method: "POST", body: JSON.stringify({ type: "node.created" }) });
		const text = await readUntil(reader, "node.created");
		expect(text).not.toContain("node.deleted");
		await reader.cancel();
	});

	it("refuses unknown event types", async () => {
		const stub = env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName("user_bad_event"));
		const response = await stub.fetch("https://graph-events/publish", { method: "POST", body: JSON.stringify({ type: "<script>" }) });
		expect(response.status).toBe(400);
	});
});

describe("/api/events route", () => {
	it("requires sign-in and allows only GET", async () => {
		expect((await SELF.fetch("http://example.com/api/events")).status).toBe(401);
		const post = await SELF.fetch("http://example.com/api/events", { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("Allow")).toBe("GET");
	});
});
