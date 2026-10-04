import { describe, it, expect } from "vitest";
import { buildOnboardingSeed, ONBOARDING_RELATION, onboardingVideoUrl, seedOnboardingGraph } from "../src/onboarding.js";

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// A stand-in D1: claimable says whether the onboarded_at claim succeeds; failBatch makes the inserts throw.
const fakeEnv = ({ claimable = true, failBatch = false, videoUrl } = {}) => {
	const runs = [];
	let batched = null;
	const statement = sql => ({
		bind: (...args) => ({
			sql,
			args,
			async run() {
				runs.push({ sql, args });
				return { meta: { changes: sql.includes("onboarded_at IS NULL") ? (claimable ? 1 : 0) : 1 } };
			},
		}),
	});
	const DB = {
		prepare: statement,
		async batch(list) {
			if (failBatch) throw new Error("D1 down");
			batched = list;
			return list.map(() => ({ meta: { changes: 1 } }));
		},
	};
	return { env: { DB, ONBOARDING_VIDEO_URL: videoUrl }, runs, batched: () => batched };
};

describe("onboardingVideoUrl", () => {
	it("accepts YouTube links only", () => {
		expect(onboardingVideoUrl({ ONBOARDING_VIDEO_URL: VIDEO })).toBe(VIDEO);
		expect(onboardingVideoUrl({ ONBOARDING_VIDEO_URL: " https://youtu.be/dQw4w9WgXcQ " })).toBe("https://youtu.be/dQw4w9WgXcQ");
		for (const value of [undefined, "", "https://example.com/video", "http://www.youtube.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)"]) {
			expect(onboardingVideoUrl({ ONBOARDING_VIDEO_URL: value }), String(value)).toBeNull();
		}
	});
});

describe("buildOnboardingSeed", () => {
	it("builds the three tutorial nodes, wired undirected with the smaller id first", () => {
		let n = 0;
		const { nodes, edges } = buildOnboardingSeed({ makeId: () => "node_" + (9 - n++) });
		expect(nodes.map(node => node.title)).toEqual(["Welcome to Aether Portal", "How to Import Links & Media", "Spatial ThumbWheel Guide"]);
		expect(edges).toHaveLength(3);
		for (const edge of edges) expect(edge.source_id < edge.target_id).toBe(true);
		const ids = new Set(nodes.map(node => node.id));
		for (const edge of edges) expect(ids.has(edge.source_id) && ids.has(edge.target_id)).toBe(true);
	});

	it("makes the import guide a video node when a walkthrough is set", () => {
		const withVideo = buildOnboardingSeed({ videoUrl: VIDEO }).nodes[1];
		expect(withVideo).toMatchObject({ url: VIDEO, category: "video" });
		const without = buildOnboardingSeed().nodes[1];
		expect(without).toMatchObject({ url: "", category: "note" });
	});
});

describe("seedOnboardingGraph", () => {
	it("claims onboarded_at, then inserts the nodes and tutorial edges for the user", async () => {
		const { env, runs, batched } = fakeEnv({ videoUrl: VIDEO });
		expect(await seedOnboardingGraph(env, "user_1")).toBe(true);
		expect(runs[0].sql).toContain("onboarded_at IS NULL");
		expect(runs[0].args).toEqual(["user_1"]);
		const statements = batched();
		const nodeRows = statements.filter(item => item.sql.includes("saved_nodes"));
		const edgeRows = statements.filter(item => item.sql.includes("node_edges"));
		expect(nodeRows).toHaveLength(3);
		expect(edgeRows).toHaveLength(3);
		for (const row of nodeRows) expect(row.args[1]).toBe("user_1");
		expect(nodeRows[1].args[2]).toBe(VIDEO);
		for (const row of edgeRows) expect(row.args.slice(2)).toEqual([ONBOARDING_RELATION, "user_1"]);
	});

	it("does nothing once the user is onboarded", async () => {
		const { env, batched } = fakeEnv({ claimable: false });
		expect(await seedOnboardingGraph(env, "user_1")).toBe(false);
		expect(batched()).toBeNull();
	});

	it("gives the claim back when the inserts fail, so the next load retries", async () => {
		const { env, runs } = fakeEnv({ failBatch: true });
		await expect(seedOnboardingGraph(env, "user_1")).rejects.toThrow("D1 down");
		expect(runs.at(-1).sql).toContain("onboarded_at = NULL");
	});
});
