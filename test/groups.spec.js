import { describe, it, expect } from "vitest";
import { buildConceptLinks, extractHashtags, normalizeGroupName, normalizeTag } from "../src/groups.js";

describe("normalizeGroupName", () => {
	it("trims, single-spaces and strips control characters", () => {
		expect(normalizeGroupName("  Memory \n & \t learning ")).toBe("Memory & learning");
	});

	it("rejects empty and over-long names", () => {
		expect(normalizeGroupName("   ")).toBeNull();
		expect(normalizeGroupName(null)).toBeNull();
		expect(normalizeGroupName("x".repeat(41))).toBeNull();
		expect(normalizeGroupName("x".repeat(40))).toHaveLength(40);
	});
});

describe("normalizeTag", () => {
	it("lowercases, drops the # and odd characters", () => {
		expect(normalizeTag("#Spaced   Repetition!")).toBe("spaced repetition");
		expect(normalizeTag("C++")).toBe("c++");
		expect(normalizeTag("日本語")).toBe("日本語");
	});

	it("needs 2-40 characters", () => {
		expect(normalizeTag("#a")).toBeNull();
		expect(normalizeTag("a".repeat(41))).toBeNull();
	});
});

describe("extractHashtags", () => {
	it("finds tags at word starts, deduplicated in order", () => {
		expect(extractHashtags("#task read this #Anki then #task again, #done")).toEqual(["task", "anki", "done"]);
	});

	it("ignores URL fragments and lone hashes", () => {
		expect(extractHashtags("see https://a.test/page#section and # alone")).toEqual([]);
		expect(extractHashtags(null)).toEqual([]);
	});
});

describe("buildConceptLinks", () => {
	const tags = new Map([
		["a", [{ tag: "anki", source: "miner", weight: 0.9 }, { tag: "memory", source: "miner", weight: 0.7 }]],
		["b", [{ tag: "anki", source: "miner", weight: 0.8 }]],
		["c", [{ tag: "memory", source: "miner", weight: 0.65 }, { tag: "anki", source: "user", weight: 1 }]],
		["d", [{ tag: "memory", source: "miner", weight: 0.4 }]],
	]);

	it("links nodes sharing a strong miner tag", () => {
		const links = buildConceptLinks(["a", "b", "c", "d"], tags);
		expect(links).toEqual([
			{ source: "a", target: "b", value: 1, type: "concept", relation: "anki" },
			{ source: "a", target: "c", value: 1, type: "concept", relation: "memory" },
		]);
	});

	it("skips pairs that already have a link and nodes that are not visible", () => {
		expect(buildConceptLinks(["a", "b", "c"], tags, [{ source: "b", target: "a" }])).toHaveLength(1);
		expect(buildConceptLinks(["a", "d"], tags)).toEqual([]);
	});

	it("caps concept links per node", () => {
		const many = new Map(["h", "x1", "x2", "x3", "x4"].map(id => [id, [{ tag: "hub", source: "miner", weight: 1 }]]));
		const links = buildConceptLinks([...many.keys()], many);
		const degree = id => links.filter(link => link.source === id || link.target === id).length;
		expect(Math.max(...[...many.keys()].map(degree))).toBeLessThanOrEqual(3);
	});
});
