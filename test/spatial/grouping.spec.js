import { describe, expect, it } from "vitest";
import { buildHierarchy, getNodeCategory, getNodePlatform } from "../../public/js/spatial/grouping.js";

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

	it("handles an empty graph and rejects unknown keys", () => {
		expect(buildHierarchy([]).order).toEqual([]);
		expect(() => buildHierarchy(nodes, { key: "mood" })).toThrow("Unknown group key");
	});
});
