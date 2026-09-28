import { describe, expect, it } from "vitest";
import { ABSTRACT_LINKS_PER_NODE, depthRank, linkDepth, normalizeDepth, primaryGroup, visibleLinks } from "../../public/js/spatial/depth.js";

const nodes = {
	a1: { id: "a1", group_id: "A" },
	a2: { id: "a2", group_id: "A" },
	b1: { id: "b1", group_id: "B" },
	n1: { id: "n1", category: "Note" },
};
const groupOf = id => primaryGroup(nodes[id]);
const keys = links => links.map(link => link.source + "-" + link.target + ":" + link.type + (link.depth ? "/" + link.depth : ""));

const links = [
	{ source: "a1", target: "a2", type: "semantic", value: 1 },
	{ source: "a1", target: "b1", type: "semantic", value: 1 },
	{ source: "a2", target: "b1", type: "semantic", value: 3 },
	{ source: "a1", target: "b1", type: "concept", value: 1 },
	{ source: "a2", target: "n1", type: "category", value: 0.5 },
	{ source: "a1", target: "a2", type: "ai", depth: "logical" },
	{ source: "a2", target: "b1", type: "ai", depth: "logical" },
	{ source: "a1", target: "n1", type: "ai", depth: "abstract", confidence: 0.9 },
	{ source: "n1", target: "b1", type: "synthesis" },
	{ source: "b1", target: "n1", type: "ai", relation: "manual" },
];

describe("depth basics", () => {
	it("normalizes levels and ranks them", () => {
		expect(normalizeDepth("abstract")).toBe("abstract");
		expect(normalizeDepth("weird")).toBe("logical");
		expect(depthRank("obvious")).toBeLessThan(depthRank("logical"));
		expect(depthRank(undefined)).toBe(1);
	});

	it("uses group_id, else the category, as the primary group", () => {
		expect(primaryGroup({ group_id: "g1", category: "note" })).toBe("group:g1");
		expect(primaryGroup({ category: "Video" })).toBe("category:video");
	});

	it("labels mined links by their depth and everything else as obvious", () => {
		expect(linkDepth({ type: "ai", depth: "abstract" })).toBe("abstract");
		expect(linkDepth({ type: "ai" })).toBe("logical");
		expect(linkDepth({ type: "ai", relation: "manual", depth: "abstract" })).toBe("obvious");
		expect(linkDepth({ type: "semantic" })).toBe("obvious");
	});
});

describe("visibleLinks", () => {
	it("Obvious keeps links inside a group only (plus Outcome and manual links)", () => {
		expect(keys(visibleLinks(links, "obvious", groupOf))).toEqual([
			"a1-a2:semantic",
			"n1-b1:synthesis",
			"b1-n1:ai",
		]);
	});

	it("Logical adds semantic links and direct cross-group links, but not weak keyword or category links", () => {
		expect(keys(visibleLinks(links, "logical", groupOf))).toEqual([
			"a1-a2:semantic",
			"a2-b1:semantic",
			"a1-b1:concept",
			"a1-a2:ai/logical",
			"a2-b1:ai/logical",
			"n1-b1:synthesis",
			"b1-n1:ai",
		]);
	});

	it("Abstract opens every cross-group link and adds the leaps", () => {
		const shown = keys(visibleLinks(links, "abstract", groupOf));
		expect(shown).toContain("a1-b1:semantic");
		expect(shown).toContain("a2-n1:category");
		expect(shown).toContain("a1-n1:ai/abstract");
		expect(shown).toHaveLength(links.length);
	});

	it("caps abstract leaps per card, keeping the most confident", () => {
		const hub = { id: "hub", group_id: "H" };
		const others = Array.from({ length: 5 }, (_, i) => ({ id: "o" + i, group_id: "O" + i }));
		const all = Object.fromEntries([hub, ...others].map(node => [node.id, node]));
		const leaps = others.map((node, i) => ({ source: "hub", target: node.id, type: "ai", depth: "abstract", confidence: i / 10 }));
		const shown = visibleLinks(leaps, "abstract", id => primaryGroup(all[id]));
		expect(shown).toHaveLength(ABSTRACT_LINKS_PER_NODE);
		expect(shown.map(link => link.target)).toEqual(["o4", "o3", "o2"]);
	});
});
