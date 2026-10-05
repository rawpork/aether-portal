import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createUserLink, deleteUserLink, normalizeEdgePair, updateUserLink } from "../src/index.js";

// Mirrors LINK_RELATION_MAX in src/index.js (not exported: the Worker entry may only export handlers, functions and objects).
const LINK_RELATION_MAX = 80;

// A stand-in D1: owned holds the node ids each user owns; edges (optional) the stored links as "source|target|user",
// which decides whether an UPDATE or DELETE finds its row. Every statement run is recorded.
const fakeEnv = (owned = {}, edges = null) => {
	const calls = [];
	const DB = {
		prepare(sql) {
			return {
				bind(...args) {
					return {
						async all() {
							calls.push({ sql, args });
							const [userId, ...ids] = args;
							const mine = owned[userId] || [];
							return { results: [...new Set(ids)].filter(id => mine.includes(id)).map(id => ({ id })) };
						},
						async run() {
							calls.push({ sql, args });
							if (edges && /^(UPDATE|DELETE)/.test(sql)) {
								const [source, target, user] = args.slice(-3);
								return { meta: { changes: edges.includes(source + "|" + target + "|" + user) ? 1 : 0 } };
							}
							return { meta: { changes: 1 } };
						},
					};
				},
			};
		},
	};
	return { env: { DB }, calls };
};
const inserts = calls => calls.filter(call => call.sql.startsWith("INSERT"));

describe("normalizeEdgePair", () => {
	it("puts the smaller id first whichever order it is given in", () => {
		expect(normalizeEdgePair("node_a", "node_b")).toEqual(["node_a", "node_b"]);
		expect(normalizeEdgePair("node_b", "node_a")).toEqual(["node_a", "node_b"]);
	});
});

describe("createUserLink", () => {
	it("stores the edge with source_id < target_id and the given relationship", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] });
		const result = await createUserLink(env, "user_1", { source: "node_b", target: "node_a", relationship: "inspired by" });
		expect(result.status).toBe(200);
		expect(result.body.link).toMatchObject({ source: "node_a", target: "node_b", relation: "inspired by" });
		const [insert] = inserts(calls);
		expect(insert.sql).toContain("node_edges");
		expect(insert.args).toEqual(["node_a", "node_b", "inspired by", "user_1"]);
	});

	it("checks both nodes against the signed-in user", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] });
		await createUserLink(env, "user_1", { source: "node_a", target: "node_b" });
		expect(calls[0].sql).toContain("user_id = ?");
		expect(calls[0].args).toEqual(["user_1", "node_a", "node_b"]);
	});

	it("defaults the relationship to manual", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] });
		const result = await createUserLink(env, "user_1", { source: "node_a", target: "node_b", relationship: "  " });
		expect(result.body.link.relation).toBe("manual");
		expect(inserts(calls)[0].args[2]).toBe("manual");
	});

	it("refuses when either node belongs to someone else or does not exist", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a"], user_2: ["node_b"] });
		expect((await createUserLink(env, "user_1", { source: "node_a", target: "node_b" })).status).toBe(404);
		expect((await createUserLink(env, "user_1", { source: "node_a", target: "node_missing" })).status).toBe(404);
		expect((await createUserLink(env, "user_2", { source: "node_a", target: "node_b" })).status).toBe(404);
		expect(inserts(calls)).toEqual([]);
	});

	it("rejects missing ids, self-links and overlong relationships before touching the database", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] });
		for (const body of [null, {}, { source: "node_a" }, { source: "node_a", target: 7 }, { source: "node_a", target: "node_a" }, { source: "node_a", target: "node_b", relationship: "x".repeat(LINK_RELATION_MAX + 1) }]) {
			expect((await createUserLink(env, "user_1", body)).status, JSON.stringify(body)).toBe(400);
		}
		expect(calls).toEqual([]);
	});
});

describe("updateUserLink", () => {
	it("relabels the stored link, whichever order the pair is given in", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] }, ["node_a|node_b|user_1"]);
		const result = await updateUserLink(env, "user_1", { source: "node_b", target: "node_a", relationship: " cites " });
		expect(result).toEqual({ status: 200, body: { success: true, source: "node_a", target: "node_b", relation: "cites" } });
		const update = calls.find(call => call.sql.startsWith("UPDATE"));
		expect(update.sql).toContain("user_id = ?");
		expect(update.args).toEqual(["cites", "node_a", "node_b", "user_1"]);
	});

	it("requires a relationship", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] }, ["node_a|node_b|user_1"]);
		for (const relationship of [undefined, "", "   "]) {
			expect((await updateUserLink(env, "user_1", { source: "node_a", target: "node_b", relationship })).status).toBe(400);
		}
		expect(calls).toEqual([]);
	});

	it("refuses nodes the user does not own, and links that are not stored", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_c"], user_2: ["node_b"] }, ["node_a|node_b|user_2"]);
		expect((await updateUserLink(env, "user_1", { source: "node_a", target: "node_b", relationship: "x" })).status).toBe(404);
		expect(calls.some(call => call.sql.startsWith("UPDATE"))).toBe(false);
		const missing = await updateUserLink(env, "user_1", { source: "node_a", target: "node_c", relationship: "x" });
		expect(missing).toEqual({ status: 404, body: { error: "Link not found." } });
	});
});

describe("deleteUserLink", () => {
	it("deletes the user's stored link", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_b"] }, ["node_a|node_b|user_1"]);
		const result = await deleteUserLink(env, "user_1", { source: "node_b", target: "node_a" });
		expect(result).toEqual({ status: 200, body: { success: true, deleted: { source: "node_a", target: "node_b" } } });
		const remove = calls.find(call => call.sql.startsWith("DELETE"));
		expect(remove.sql).toContain("user_id = ?");
		expect(remove.args).toEqual(["node_a", "node_b", "user_1"]);
	});

	it("refuses another user's nodes and reports a missing link", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a", "node_c"], user_2: ["node_b"] }, ["node_a|node_b|user_2"]);
		expect((await deleteUserLink(env, "user_1", { source: "node_a", target: "node_b" })).status).toBe(404);
		expect(calls.some(call => call.sql.startsWith("DELETE"))).toBe(false);
		expect((await deleteUserLink(env, "user_1", { source: "node_a", target: "node_c" })).body.error).toBe("Link not found.");
	});

	it("rejects missing ids and self-links before touching the database", async () => {
		const { env, calls } = fakeEnv({ user_1: ["node_a"] });
		for (const body of [null, {}, { source: "node_a" }, { source: "node_a", target: "node_a" }]) {
			expect((await deleteUserLink(env, "user_1", body)).status, JSON.stringify(body)).toBe(400);
		}
		expect(calls).toEqual([]);
	});
});

describe("/api/link route", () => {
	it("allows POST, PATCH and DELETE only", async () => {
		const response = await SELF.fetch("http://example.com/api/link");
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST, PATCH, DELETE");
	});

	it("requires sign-in for every method", async () => {
		for (const method of ["POST", "PATCH", "DELETE"]) {
			const response = await SELF.fetch("http://example.com/api/link", {
				method,
				headers: { "Content-Type": "application/json", Origin: "http://example.com" },
				body: JSON.stringify({ source: "node_a", target: "node_b", relationship: "x" }),
			});
			expect(response.status, method).toBe(401);
		}
	});
});

describe("createProjectOutcome", () => {
	it("stores an accepted Outcome Node and links only the sources the user owns", async () => {
		const { createProjectOutcome } = await import("../src/index.js");
		const statements = [];
		const DB = {
			prepare(sql) {
				return {
					bind(...args) {
						return {
							sql, args,
							async all() { return { results: args.slice(1).filter((id) => id === "n1").map((id) => ({ id })) }; },
						};
					},
				};
			},
			async batch(list) { statements.push(...list); return []; },
		};
		const result = await createProjectOutcome({ DB }, "user_1", { title: "  Launch   plan ", goal: "Ship it", steps: [{ title: "Ingest", detail: "Read the docs" }, { title: "" }], report: "# Report", source_ids: ["n1", "n_other", "n1"] });
		expect(result.status).toBe(201);
		expect(result.body).toMatchObject({ success: true, linked: 1 });
		const insert = statements.find((s) => s.sql.startsWith("INSERT INTO saved_nodes"));
		expect(insert.sql).toContain("'outcome', 'reference', 'accepted'");
		expect(insert.args[1]).toBe("user_1");
		expect(insert.args[3]).toBe("Launch plan");
		expect(JSON.parse(insert.args[5])).toMatchObject({ template: "project", goal: "Ship it", steps: [{ title: "Ingest", detail: "Read the docs", inputs: [] }] });
		const links = statements.filter((s) => s.sql.includes("outcome_inputs"));
		expect(links.map((s) => s.args[1])).toEqual(["n1"]);
		expect((await createProjectOutcome({ DB }, "user_1", { title: " " })).status).toBe(400);
	});

	it("is a signed-in POST route", async () => {
		expect((await SELF.fetch("http://example.com/api/outcomes")).status).toBe(405);
		const response = await SELF.fetch("http://example.com/api/outcomes", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://example.com" }, body: "{}" });
		expect(response.status).toBe(401);
	});
});
