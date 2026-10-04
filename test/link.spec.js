import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createUserLink, normalizeEdgePair } from "../src/index.js";

// Mirrors LINK_RELATION_MAX in src/index.js (not exported: the Worker entry may only export handlers, functions and objects).
const LINK_RELATION_MAX = 80;

// A stand-in D1: owned holds the node ids each user owns; every statement run is recorded.
const fakeEnv = (owned = {}) => {
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

describe("/api/link route", () => {
	it("only allows POST", async () => {
		const response = await SELF.fetch("http://example.com/api/link");
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it("requires sign-in", async () => {
		const response = await SELF.fetch("http://example.com/api/link", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://example.com" },
			body: JSON.stringify({ source: "node_a", target: "node_b" }),
		});
		expect(response.status).toBe(401);
	});
});
