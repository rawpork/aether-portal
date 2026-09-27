import { describe, it, expect } from "vitest";
import { buildMinerPrompt, parseMinerResponse } from "../src/miner.js";

const CATEGORIES = ["note", "link", "dev_task"];
const normalize = (value, fallback) => (CATEGORIES.includes(value) ? value : fallback);

describe("buildMinerPrompt", () => {
	it("numbers new items before context items and prefers titles over bare URLs", () => {
		const prompt = buildMinerPrompt(
			[{ title: "Vite docs", url: "https://vitejs.dev", category: "link" }],
			[{ title: "https://x.test", url: "https://x.test", category: "note" }],
			CATEGORIES
		);
		expect(prompt).toContain("Items 0-0 are NEW");
		expect(prompt).toContain("[0] (link) Vite docs | https://vitejs.dev");
		expect(prompt).toContain("[1] (note) https://x.test");
	});

	it("adds the start of a node's page text or synopsis when it has one", () => {
		const prompt = buildMinerPrompt(
			[{ title: "Post", url: "https://p.test", category: "link", snippet: "  Edge   runtimes\nexplained. " + "x".repeat(400) }],
			[{ title: "Plain", url: "https://q.test", category: "note", snippet: null }],
			CATEGORIES
		);
		expect(prompt).toContain("[0] (link) Post | https://p.test :: Edge runtimes explained. x");
		expect(prompt).toMatch(/\[1\] \(note\) Plain \| https:\/\/q\.test$/m);
		expect(prompt.split("\n").find(line => line.startsWith("[0]")).split(" :: ")[1]).toHaveLength(200);
	});
});

describe("buildMinerPrompt tags and groups", () => {
	it("asks for tags and a group, and offers existing groups for reuse", () => {
		const prompt = buildMinerPrompt([{ title: "A", url: "a", category: "note" }], [], CATEGORIES, ["Memory & Learning"]);
		expect(prompt).toContain("3-5 tags");
		expect(prompt).toContain('"Memory & Learning"');
		expect(prompt).toContain('"group":"..."');
	});

	it("says to leave group empty when there are no groups yet", () => {
		expect(buildMinerPrompt([{ title: "A", url: "a" }], [], CATEGORIES)).toContain("leave group empty");
	});
});

describe("parseMinerResponse", () => {
	it("keeps valid categories for new items only", () => {
		const { categories } = parseMinerResponse(
			{ nodes: [{ i: 0, category: "dev_task" }, { i: 1, category: "bogus" }, { i: 2, category: "note" }] },
			2, 3, normalize
		);
		expect([...categories]).toEqual([[0, "dev_task"]]);
	});

	it("drops self, out-of-range, context-only and duplicate edges", () => {
		const { edges } = parseMinerResponse(
			{
				edges: [
					{ a: 0, b: 2, relation: "  same   project " },
					{ a: 2, b: 0 },
					{ a: 1, b: 1 },
					{ a: 0, b: 9 },
					{ a: 2, b: 3 },
					{ a: "x", b: 1 },
				],
			},
			2, 4, normalize
		);
		expect(edges).toEqual([{ a: 0, b: 2, relation: "same project" }]);
	});

	it("caps edges per new item", () => {
		const { edges } = parseMinerResponse(
			{ edges: [1, 2, 3, 4, 5].map(b => ({ a: 0, b })) },
			1, 6, normalize
		);
		expect(edges).toHaveLength(3);
	});

	it("parses tags from objects or strings, strongest first, capped at five", () => {
		const { tags } = parseMinerResponse(
			{
				nodes: [
					{ i: 0, tags: [{ tag: "#Anki", weight: 0.4 }, { tag: "spaced repetition", weight: 2 }, { tag: "x" }, "anki"] },
					{ i: 1, tags: ["one", "two", "three", "four", "five", "six"] },
				],
			},
			2, 2, normalize
		);
		expect(tags.get(0)).toEqual([{ tag: "spaced repetition", weight: 1 }, { tag: "anki", weight: 0.55 }]);
		expect(tags.get(1).map(t => t.tag)).toEqual(["one", "two", "three", "four", "five"]);
	});

	it("reuses existing group spellings and only keeps new groups shared by two items", () => {
		const { groups } = parseMinerResponse(
			{
				nodes: [
					{ i: 0, group: "memory & learning" },
					{ i: 1, group: "3D Printing" },
					{ i: 2, group: "3d printing" },
					{ i: 3, group: "Lonely Idea" },
					{ i: 4, group: "  " },
				],
			},
			5, 5, normalize, ["Memory & Learning"]
		);
		expect([...groups]).toEqual([[0, "Memory & Learning"], [1, "3D Printing"], [2, "3d printing"]]);
	});

	it("tolerates a malformed response", () => {
		const result = parseMinerResponse(null, 2, 4, normalize);
		expect(result.categories.size).toBe(0);
		expect(result.edges).toEqual([]);
		expect(result.tags.size).toBe(0);
		expect(result.groups.size).toBe(0);
	});
});
