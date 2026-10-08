import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import records from "../migrations/0019_records.sql?raw";
import conversations from "../migrations/0020_conversations.sql?raw";
import complete from "../migrations/0021_records_complete.sql?raw";
import { appendMessages, refileThreads } from "../src/conversations.js";
import { recordStats, reindexAccount, searchRecords } from "../src/records.js";

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

const run = sql => env.DB.prepare(sql).run();
const ids = async (query, extra = {}) => (await searchRecords(env, "u1", { query, ...extra })).records.map(r => r.id).sort();

beforeAll(async () => {
	for (const sql of [
		"CREATE TABLE IF NOT EXISTS saved_nodes (id TEXT PRIMARY KEY, url TEXT, title TEXT, description TEXT, synopsis TEXT, category TEXT, user_note TEXT, research TEXT, site_name TEXT, user_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		"CREATE TABLE IF NOT EXISTS node_tags (node_id TEXT NOT NULL, tag TEXT NOT NULL, user_id TEXT, PRIMARY KEY (node_id, tag))",
		"CREATE TABLE IF NOT EXISTS node_groups (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
		"CREATE TABLE IF NOT EXISTS sites (slug TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, draft_html TEXT, status TEXT NOT NULL DEFAULT 'draft', outcome_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		"INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('legacy1', 'https://old.test', 'Legacy bookmark', 'Saved before the sweep existed', 'general', 'u1')",
		"INSERT INTO node_groups (id, user_id, name) VALUES ('g0', 'u1', 'Pre-existing travel group')",
	]) await run(sql);
	for (const sql of [...statements(records), ...statements(conversations), ...statements(complete)]) await run(sql);
});

describe("every write is searchable in the same request", () => {
	it("files a card with its description, note and site, and finds it by any of them at once", async () => {
		await run("INSERT INTO saved_nodes (id, url, title, description, synopsis, category, user_note, site_name, user_id) VALUES ('c1', 'https://github.com/x/y', 'Edge router', 'A tiny router for workers', 'Fast', 'dev_tools', 'remember zebrafish benchmarks', 'GitHub', 'u1')");
		for (const word of ["router", "tiny", "zebrafish", "github", "dev_tools"]) expect(await ids(word), word).toContain("c1");
	});

	it("follows edits to the note and synopsis, and to tags", async () => {
		await run("UPDATE saved_nodes SET user_note = 'now about narwhal pricing' WHERE id = 'c1'");
		expect(await ids("narwhal")).toEqual(["c1"]);
		expect(await ids("zebrafish")).toEqual([]);
		await run("INSERT INTO node_tags (node_id, tag, user_id) VALUES ('c1', 'quokka', 'u1')");
		expect(await ids("quokka")).toEqual(["c1"]);
		expect(await ids("github")).toContain("c1");
		await run("DELETE FROM node_tags WHERE node_id = 'c1' AND tag = 'quokka'");
		expect(await ids("quokka")).toEqual([]);
		expect(await ids("github")).toContain("c1");
	});

	it("uses the synopsis when there is no description", async () => {
		await run("INSERT INTO saved_nodes (id, url, title, synopsis, category, user_id) VALUES ('c2', 'https://a.test', 'Untitled save', 'Only a synopsis about platypus habitats', 'general', 'u1')");
		expect(await ids("platypus")).toEqual(["c2"]);
	});

	it("files groups, follows renames and deletes", async () => {
		await run("INSERT INTO node_groups (id, user_id, name) VALUES ('g1', 'u1', 'Marmot research')");
		expect(await ids("marmot")).toEqual(["group:g1"]);
		await run("UPDATE node_groups SET name = 'Alpaca research' WHERE id = 'g1'");
		expect(await ids("marmot")).toEqual([]);
		expect(await ids("alpaca")).toEqual(["group:g1"]);
		await run("DELETE FROM node_groups WHERE id = 'g1'");
		expect(await ids("alpaca")).toEqual([]);
	});

	it("files an outcome and a website as deliverables", async () => {
		await run("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('o1', 'aether:outcome', 'Launch plan for tapir cafe', 'Plan', 'outcome', 'u1')");
		await run("INSERT INTO sites (slug, user_id, title, draft_html, outcome_id) VALUES ('tapir-site', 'u1', 'Tapir cafe site', '<p>x</p>', 'o1')");
		expect(await ids("tapir", { type: "deliverable" })).toEqual(["o1", "site:tapir-site"]);
	});
});

describe("account sweep", () => {
	it("pulls in what predates the triggers, and counts it by type", async () => {
		const stats = await recordStats(env, "u1");
		expect(stats.by_type.card).toBeGreaterThanOrEqual(3);
		expect(await ids("legacy")).toEqual(["legacy1"]);
		expect(await ids("pre-existing travel")).toEqual(["group:g0"]);
	});

	it("repairs a broken index, drops orphans, refiles conversations, and reports a consistent index", async () => {
		await appendMessages(env, "u1", "project:bp_9", { messages: [{ role: "user", content: "Discuss the ocelot rollout" }, { role: "assistant", content: "Start Monday." }], title: "Ocelot project" });
		// Break things on purpose: an orphan record, a record the index lost, and a stale conversation summary.
		await run("INSERT INTO records (id, user_id, type, title, summary, body_ref, tags) VALUES ('ghost', 'u1', 'card', 'Ghost card', 'gone', 'saved_nodes:nope', '')");
		await run("UPDATE records SET summary = 'stale' WHERE id = 'thread:project:bp_9'");
		await run("INSERT INTO records_fts (records_fts) VALUES ('delete-all')");
		const done = await reindexAccount(env, "u1", refileThreads);
		expect(done.index_consistent).toBe(true);
		expect(done.conversations_refiled).toBeGreaterThanOrEqual(1);
		expect(await ids("ghost")).toEqual([]);
		expect(await ids("narwhal")).toEqual(["c1"]);
		expect(await ids("ocelot")).toEqual(["thread:project:bp_9"]);
		expect(done.total).toBe(Object.values(done.by_type).reduce((a, b) => a + b, 0));
	});

	it("keeps users apart", async () => {
		expect((await recordStats(env, "u2")).total).toBe(0);
		expect((await searchRecords(env, "u2", { query: "narwhal" })).count).toBe(0);
	});

	it("the sweep and stats routes need a session or an engine token", async () => {
		expect((await SELF.fetch("https://example.com/api/records/reindex", { method: "POST" })).status).toBe(401);
		expect((await SELF.fetch("https://example.com/api/records/stats")).status).toBe(401);
	});
});
