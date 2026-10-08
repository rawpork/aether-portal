import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import records from "../migrations/0019_records.sql?raw";
import conversations from "../migrations/0020_conversations.sql?raw";
import { appendMessages, deleteThread, getThread, listThreads, summarizeMessages, THREAD_KEEP_MESSAGES } from "../src/conversations.js";
import { getRecord, searchRecords } from "../src/records.js";

// Splits a migration into statements; a trigger runs to its END; line.
function statements(sql) {
	const out = [];
	let current = [];
	let trigger = false;
	for (const line of sql.split("\n")) {
		if (!current.length && (!line.trim() || line.trim().startsWith("--"))) continue;
		current.push(line);
		if (/^\s*CREATE TRIGGER/i.test(current[0])) trigger = true;
		if (trigger ? /^\s*END;\s*$/.test(line) : line.trim().endsWith(";")) { out.push(current.join(" ")); current = []; trigger = false; }
	}
	return out;
}

beforeAll(async () => {
	for (const sql of [
		"CREATE TABLE IF NOT EXISTS saved_nodes (id TEXT PRIMARY KEY, url TEXT, title TEXT, description TEXT, category TEXT, user_note TEXT, research TEXT, user_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		"CREATE TABLE IF NOT EXISTS node_tags (node_id TEXT NOT NULL, tag TEXT NOT NULL, user_id TEXT, PRIMARY KEY (node_id, tag))",
		"CREATE TABLE IF NOT EXISTS sites (slug TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, draft_html TEXT, status TEXT NOT NULL DEFAULT 'draft', outcome_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
	]) await env.DB.prepare(sql).run();
	for (const sql of [...statements(records), ...statements(conversations)]) await env.DB.prepare(sql).run();
});

const turn = (q, a) => ({ messages: [{ role: "user", content: q }, { role: "assistant", content: a }] });

describe("conversation storage", () => {
	it("saves messages in order, and loads the thread back with its title and project", async () => {
		expect(await appendMessages(env, "u1", "project:bp_1", { ...turn("What is the budget?", "Two hundred dollars."), title: "Bakery site" })).toEqual({ thread_id: "project:bp_1", saved: 2 });
		await appendMessages(env, "u1", "project:bp_1", turn("And the deadline?", "Friday."));
		const thread = await getThread(env, "u1", "project:bp_1");
		expect(thread.messages.map(m => m.role + ": " + m.content)).toEqual(["user: What is the budget?", "assistant: Two hundred dollars.", "user: And the deadline?", "assistant: Friday."]);
		expect(thread).toMatchObject({ project_id: "bp_1", title: "Bakery site", message_count: 4 });
	});

	it("files each thread in records so its discussion can be searched and read back", async () => {
		const found = await searchRecords(env, "u1", { query: "deadline", type: "conversation" });
		expect(found.records.map(r => [r.id, r.project_id, r.body_ref])).toEqual([["thread:project:bp_1", "bp_1", "conversation:project:bp_1"]]);
		const record = await getRecord(env, "u1", "thread:project:bp_1");
		expect(record.body).toContain("You: What is the budget?");
		expect(record.body).toContain("Elarion: Friday.");
		expect((await searchRecords(env, "u1", { query: "budget", project_id: "bp_1" })).count).toBe(1);
	});

	it("lists threads, filters by project, and keeps users apart", async () => {
		await appendMessages(env, "u1", "main", turn("hello", "hi"));
		expect((await listThreads(env, "u1")).threads.map(t => t.id).sort()).toEqual(["main", "project:bp_1"]);
		expect((await listThreads(env, "u1", { project_id: "bp_1" })).threads.map(t => t.id)).toEqual(["project:bp_1"]);
		expect((await listThreads(env, "u2")).threads).toEqual([]);
		expect(await getThread(env, "u2", "main")).toBe(null);
		expect((await searchRecords(env, "u2", { query: "deadline" })).count).toBe(0);
	});

	it("rejects bad thread ids and malformed messages", async () => {
		expect((await appendMessages(env, "u1", "../x", turn("a", "b"))).error).toMatch(/thread id/);
		expect((await appendMessages(env, "u1", "main", { messages: [] })).error).toMatch(/1 to/);
		expect((await appendMessages(env, "u1", "main", { messages: [{ role: "system", content: "x" }] })).error).toMatch(/role/);
		expect((await appendMessages(env, "u1", "main", { messages: [{ role: "user", content: "  " }] })).error).toMatch(/role/);
	});

	it("keeps only the newest messages of a long thread", async () => {
		for (let i = 0; i < THREAD_KEEP_MESSAGES / 2 + 5; i++) await appendMessages(env, "u3", "long", turn("q" + i, "a" + i));
		const { messages } = await getThread(env, "u3", "long", 200);
		const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE user_id = 'u3'").first();
		expect(total.n).toBe(THREAD_KEEP_MESSAGES);
		expect(messages.at(-1).content).toBe("a" + (THREAD_KEEP_MESSAGES / 2 + 4));
	});

	it("deletes a thread and its record", async () => {
		await deleteThread(env, "u1", "main");
		expect(await getThread(env, "u1", "main")).toBe(null);
		expect(await getRecord(env, "u1", "thread:main")).toBe(null);
	});

	it("summarises the latest messages for the index", () => {
		expect(summarizeMessages([{ role: "user", content: "a  b" }, { role: "assistant", content: "c" }])).toBe("You: a b | Elarion: c");
	});
});

describe("conversation routes", () => {
	it("need a signed-in session or an engine token", async () => {
		for (const [method, path] of [["GET", "/api/conversations"], ["GET", "/api/conversations/main"], ["POST", "/api/conversations/main"], ["DELETE", "/api/conversations/main"]]) {
			expect((await SELF.fetch("https://example.com" + path, { method })).status, method + " " + path).toBe(401);
		}
	});
});
