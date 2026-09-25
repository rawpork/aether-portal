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

	it("tolerates a malformed response", () => {
		const result = parseMinerResponse(null, 2, 4, normalize);
		expect(result.categories.size).toBe(0);
		expect(result.edges).toEqual([]);
	});
});
