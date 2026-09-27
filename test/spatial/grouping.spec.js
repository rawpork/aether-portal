import { describe, expect, it } from "vitest";
import { GROUP_PALETTE, buildHierarchy, getNodeCategory, getNodePlatform, groupColor } from "../../public/js/spatial/grouping.js";

const nodes = [
	{ id: "a", category: "video", url: "https://www.youtube.com/watch?v=1" },
	{ id: "b", category: "link", url: "https://en.wikipedia.org/wiki/Spaced_repetition" },
	{ id: "c", category: "note", url: "buy milk" },
	{ id: "d", category: "link", url: "https://m.facebook.com/post/1" },
	{ id: "e", category: "image", url: "https://x.com/photo.jpg" },
	{ id: "f", category: "Dev_Task", url: "fix login" },
	{ id: "g", category: "link", url: "https://x.com/someone/status/1" },
];

describe("getNodePlatform", () => {
	it("matches the origin bar rules", () => {
		expect(nodes.map(getNodePlatform)).toEqual(["youtube", "links", "notes", "facebook", "images", "notes", "x"]);
	});

	it("treats unparsable links as generic links", () => {
		expect(getNodePlatform({ url: "https://" })).toBe("links");
	});
});

describe("getNodeCategory", () => {
	it("lowercases and falls back to note", () => {
		expect(getNodeCategory({ category: "Dev_Task" })).toBe("dev_task");
		expect(getNodeCategory({})).toBe("note");
	});
});

describe("buildHierarchy", () => {
	it("groups by category with stable ids and labels", () => {
		const { groups, groupOf } = buildHierarchy(nodes);
		expect(groupOf.get("b")).toBe("category:link");
		expect(groups.get("category:link")).toMatchObject({ key: "category", value: "link", label: "link", nodeIds: ["b", "d", "g"], count: 3 });
		expect(groups.get("category:dev_task").label).toBe("dev task");
	});

	it("orders groups largest first, then by label", () => {
		const { order } = buildHierarchy(nodes);
		expect(order).toEqual(["category:link", "category:dev_task", "category:image", "category:note", "category:video"]);
	});

	it("groups by platform", () => {
		const { groups, order } = buildHierarchy(nodes, { key: "platform" });
		expect(order[0]).toBe("platform:notes");
		expect(groups.get("platform:x")).toMatchObject({ label: "X/Twitter", nodeIds: ["g"] });
		expect([...groups.values()].reduce((sum, group) => sum + group.count, 0)).toBe(nodes.length);
	});

	it("keeps group ids stable when the node set is filtered", () => {
		const all = buildHierarchy(nodes);
		const some = buildHierarchy(nodes.filter(node => node.id !== "b"));
		expect(some.groupOf.get("d")).toBe(all.groupOf.get("d"));
	});

	it("groups by the hybrid group key, with unsorted nodes on their category islands", () => {
		const groups = new Map([["g1", { name: "Memory & Learning", source: "ai" }], ["g2", { name: "Reading", source: "user" }]]);
		const grouped = nodes.map((node, i) => ({ ...node, group_id: i < 3 ? "g1" : i === 3 ? "gone" : null }));
		const { groups: result, groupOf } = buildHierarchy(grouped, { key: "group", groups });
		expect(result.get("group:g1")).toMatchObject({ key: "group", label: "Memory & Learning", source: "ai", nodeIds: ["a", "b", "c"], color: groupColor("group:g1") });
		expect(groupOf.get("d")).toBe("category:link");
		expect(groupOf.get("g")).toBe(buildHierarchy(nodes, { key: "category" }).groupOf.get("g"));
		expect(result.has("group:g2")).toBe(false);
	});

	it("groups by each node's strongest tag, user tags first", () => {
		const tagged = [
			{ id: "a", category: "note", tags: [{ tag: "anki", source: "miner", weight: 0.9 }, { tag: "study", source: "user", weight: 1 }] },
			{ id: "b", category: "note", tags: [{ tag: "memory", source: "miner", weight: 0.7 }, { tag: "anki", source: "miner", weight: 0.7 }] },
			{ id: "c", category: "link" },
		];
		const { groupOf, groups } = buildHierarchy(tagged, { key: "tag" });
		expect([...groupOf.values()]).toEqual(["tag:study", "tag:anki", "category:link"]);
		expect(groups.get("tag:anki").label).toBe("#anki");
	});

	it("gives groups a stable palette colour", () => {
		expect(groupColor("group:g1")).toBe(groupColor("group:g1"));
		expect(GROUP_PALETTE).toContain(groupColor("tag:anki"));
		expect(buildHierarchy(nodes, { key: "category" }).groups.get("category:link").color).toBeNull();
	});

	it("handles an empty graph and rejects unknown keys", () => {
		expect(buildHierarchy([]).order).toEqual([]);
		expect(() => buildHierarchy(nodes, { key: "mood" })).toThrow("Unknown group key");
	});
});
