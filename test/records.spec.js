import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migration from "../migrations/0019_records.sql?raw";
import { clampLimit, getRecord, searchRecords, toMatchQuery, toOrQuery, upsertRecord } from "../src/records.js";

// Splits the migration into statements; a trigger runs to its END; line.
function statements(sql) {
	const out = [];
	let current = [];
	let trigger = false;
	for (const line of sql.split("\n")) {
		if (!current.length && (!line.trim() || line.trim().startsWith("--"))) continue;
		current.push(line);
		if (/^\s*CREATE TRIGGER/i.test(current[0])) trigger = true;
		const done = trigger ? /^\s*END;\s*$/.test(line) : line.trim().endsWith(";");
		if (done) { out.push(current.join(" ")); current = []; trigger = false; }
	}
	return out;
}

beforeAll(async () => {
	// The test database has no migrations applied: the tables the triggers read, then the migration itself.
	for (const sql of [
		"CREATE TABLE IF NOT EXISTS saved_nodes (id TEXT PRIMARY KEY, url TEXT, title TEXT, description TEXT, category TEXT, user_note TEXT, research TEXT, user_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		"CREATE TABLE IF NOT EXISTS node_tags (node_id TEXT NOT NULL, tag TEXT NOT NULL, user_id TEXT, PRIMARY KEY (node_id, tag))",
		"CREATE TABLE IF NOT EXISTS sites (slug TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, draft_html TEXT, status TEXT NOT NULL DEFAULT 'draft', outcome_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
	]) await env.DB.prepare(sql).run();
	await env.DB.prepare("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('old1', 'https://old.test', 'Existing sourdough note', 'Backfilled before the migration', 'general', 'u1')").run();
	for (const sql of statements(migration)) await env.DB.prepare(sql).run();
});

describe("query building", () => {
	it("quotes every word so operators are plain text, and makes the last a prefix", () => {
		expect(toMatchQuery('sour* AND "dough" NOT')).toBe('"sour" "and" "dough" "not"*');
		expect(toMatchQuery("   ")).toBe(null);
		expect(toMatchQuery(null)).toBe(null);
	});
	it("builds the any-word form only for multi-word queries", () => {
		expect(toOrQuery("mission control")).toBe('"mission"* OR "control"*');
		expect(toOrQuery("mission")).toBe(null);
		expect(toOrQuery("   ")).toBe(null);
	});
	it("keeps the limit between 1 and 50, defaulting to 10", () => {
		expect([clampLimit(undefined), clampLimit(0), clampLimit(7), clampLimit(500)]).toEqual([10, 10, 7, 50]);
	});
});

describe("records index", () => {
	it("backfills existing cards and indexes new saves through the triggers", async () => {
		expect((await searchRecords(env, "u1", { query: "sourdough" })).records.map(r => r.id)).toEqual(["old1"]);
		await env.DB.prepare("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('n1', 'https://a.test', 'Quarterly pricing review', 'Competitor price points for the bakery', 'research', 'u1')").run();
		const hit = await searchRecords(env, "u1", { query: "pricing bak" });
		expect(hit.records.map(r => [r.id, r.type, r.body_ref])).toEqual([["n1", "card", "saved_nodes:n1"]]);
	});

	it("follows edits, tags and deletes", async () => {
		await env.DB.prepare("UPDATE saved_nodes SET title = 'Renamed zebra plan' WHERE id = 'n1'").run();
		expect((await searchRecords(env, "u1", { query: "zebra" })).count).toBe(1);
		expect((await searchRecords(env, "u1", { query: "pricing" })).records.map(r => r.id)).toEqual([]);
		await env.DB.prepare("INSERT INTO node_tags (node_id, tag, user_id) VALUES ('n1', 'xylophone', 'u1')").run();
		expect((await searchRecords(env, "u1", { query: "xylophone" })).records.map(r => r.id)).toEqual(["n1"]);
		await env.DB.prepare("DELETE FROM saved_nodes WHERE id = 'n1'").run();
		expect((await searchRecords(env, "u1", { query: "zebra" })).count).toBe(0);
	});

	it("files outcomes and websites as deliverables", async () => {
		await env.DB.prepare("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('o1', 'aether:outcome', 'Launch plan', 'Plan', 'outcome', 'u1')").run();
		await env.DB.prepare("INSERT INTO sites (slug, user_id, title, draft_html, outcome_id) VALUES ('bakery-site', 'u1', 'Bakery waitlist', '<p>x</p>', 'o1')").run();
		const found = await searchRecords(env, "u1", { query: "", type: "deliverable" });
		expect(found.records.map(r => r.id).sort()).toEqual(["o1", "site:bakery-site"]);
		expect((await searchRecords(env, "u1", { query: "waitlist", project_id: "o1" })).records[0].body_ref).toBe("/s/bakery-site");
		await env.DB.prepare("UPDATE sites SET title = 'Bakery signup' WHERE slug = 'bakery-site'").run();
		expect((await searchRecords(env, "u1", { query: "signup" })).count).toBe(1);
	});

	it("never shows one user another's records", async () => {
		await env.DB.prepare("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('p1', 'https://p.test', 'Private quokka diary', 'Secret', 'general', 'u2')").run();
		expect((await searchRecords(env, "u1", { query: "quokka" })).count).toBe(0);
		expect(await getRecord(env, "u1", "p1")).toBe(null);
		expect((await getRecord(env, "u2", "p1")).title).toBe("Private quokka diary");
	});

	it("get_record returns the record and the body it points at", async () => {
		const record = await getRecord(env, "u1", "old1");
		expect(record.body).toContain("Backfilled before the migration");
		expect(record.body).toContain("https://old.test");
	});
});

describe("AND then OR search", () => {
	it("requires every word first, and falls back to any word when that finds nothing", async () => {
		await env.DB.prepare("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('m1', 'https://m.test', 'Mission planning guide', 'Steps', 'general', 'u1'), ('m2', 'https://c.test', 'Control panel notes', 'Dials', 'general', 'u1')").run();
		const both = await searchRecords(env, "u1", { query: "mission control" });
		expect(both.mode).toBe("or");
		expect(both.records.map(r => r.id).sort()).toEqual(["m1", "m2"]);
		await env.DB.prepare("INSERT INTO saved_nodes (id, url, title, description, category, user_id) VALUES ('m3', 'https://mc.test', 'Mission Control rollout', 'Plan', 'general', 'u1')").run();
		const strict = await searchRecords(env, "u1", { query: "mission control" });
		expect(strict.mode).toBe("and");
		expect(strict.records.map(r => r.id)).toEqual(["m3"]);
		expect((await searchRecords(env, "u1", { query: "mission" })).mode).toBe("and");
		expect((await searchRecords(env, "u1", { query: "zzzz yyyy" })).count).toBe(0);
		expect((await searchRecords(env, "u1", { query: "zzzz" })).mode).toBe("and");
		expect((await searchRecords(env, "u1", { query: "" })).mode).toBe("recent");
		expect((await searchRecords(env, "u2", { query: "mission control" })).count).toBe(0);
	});
});

describe("blueprint records", () => {
	it("upserts a blueprint, keeps it searchable after an update, and refuses someone else's id or a bad type", async () => {
		expect(await upsertRecord(env, "u1", { id: "bp_1", type: "blueprint", title: "Landing page plan", summary: "Waitlist form", project_id: "bp_1", tags: ["Web", "launch"] })).toEqual({ id: "bp_1", type: "blueprint" });
		expect((await searchRecords(env, "u1", { query: "waitlist", type: "blueprint" })).records[0]).toMatchObject({ id: "bp_1", tags: "web launch", project_id: "bp_1" });
		await upsertRecord(env, "u1", { id: "bp_1", type: "blueprint", title: "Landing page plan v2", summary: "Mailing list" });
		expect((await searchRecords(env, "u1", { query: "waitlist" })).count).toBe(0);
		expect((await searchRecords(env, "u1", { query: "mailing" })).count).toBe(1);
		expect((await upsertRecord(env, "u2", { id: "bp_1", type: "blueprint", title: "Mine now" })).status).toBe(403);
		expect((await upsertRecord(env, "u1", { id: "x", type: "card", title: "t" })).error).toMatch(/type must be/);
		expect((await upsertRecord(env, "u1", { type: "note", title: "t" })).error).toMatch(/id is required/);
	});
});

describe("records routes", () => {
	it("need a signed-in session or an engine token", async () => {
		for (const [method, path] of [["GET", "/api/records/search?q=x"], ["GET", "/api/records/old1"], ["POST", "/api/records"]]) {
			expect((await SELF.fetch("https://example.com" + path, { method })).status, path).toBe(401);
		}
		expect((await SELF.fetch("https://example.com/api/records/search", { headers: { Authorization: "Bearer not-a-token" } })).status).toBe(401);
	});
});
