import { describe, expect, it } from "vitest";
import { faceFromNode, faceKey, wrapText } from "../../public/js/spatial/card-faces.js";

describe("faceFromNode", () => {
	it("maps a YouTube node to a video face with its thumbnail", () => {
		const face = faceFromNode(
			{ id: 7, category: "video", title: "WebXR talk", url: "https://www.youtube.com/watch?v=1", description: "YouTube video by Immersive Web", image_url: "https://i.ytimg.com/vi/1/hq.jpg", created_at: "2026-09-24T00:38:08Z" },
			{ categoryColor: "#ff4d6d", categoryLabel: "video", group: { name: "Talks", color: "#7c9cff", source: "ai" } }
		);
		expect(face).toMatchObject({ id: "7", type: "video", title: "WebXR talk", site: "youtube.com", thumbUrl: "https://i.ytimg.com/vi/1/hq.jpg", color: "#ff4d6d", label: "VIDEO", group: { name: "Talks", source: "ai" } });
		expect(face.date).not.toBe("");
	});

	it("treats a node without a link as a note and shows its text", () => {
		const face = faceFromNode({ id: "n", category: "note", title: "Plan", url: "Study the N4 list", user_note: "#task" });
		expect(face).toMatchObject({ type: "note", site: "", text: "Study the N4 list · #task", thumbUrl: null, group: null });
	});

	it("uses the link face for articles and keeps only safe thumbnail sources", () => {
		const face = faceFromNode({ id: "a", category: "article", title: "Spaced repetition", url: "https://en.wikipedia.org/wiki/x", site_name: "Wikipedia", image_url: "javascript:alert(1)" });
		expect(face).toMatchObject({ type: "link", site: "Wikipedia", thumbUrl: null });
		expect(faceFromNode({ id: "i", category: "image", url: "", image_url: "/api/node-image/i" }).thumbUrl).toBe("/api/node-image/i");
	});

	it("changes its key only when something visible changes", () => {
		const base = faceFromNode({ id: "a", category: "link", title: "A", url: "https://a.test" });
		expect(faceKey(base, false)).toBe(faceKey({ ...base }, false));
		expect(faceKey(base, false)).not.toBe(faceKey(base, true));
		expect(faceKey(base, false)).not.toBe(faceKey({ ...base, group: { name: "G", color: "#fff" } }, false));
	});
});

describe("wrapText", () => {
	const measure = text => text.length;

	it("wraps on words and ends a cut with an ellipsis", () => {
		expect(wrapText(measure, "one two three four five", 9, 2)).toEqual(["one two", "three…"]);
		expect(wrapText(measure, "short", 20, 2)).toEqual(["short"]);
	});

	it("shortens a single word that is too long for the line", () => {
		const [line] = wrapText(measure, "supercalifragilistic", 8, 1);
		expect(line.length).toBeLessThanOrEqual(8);
		expect(line.endsWith("…")).toBe(true);
	});
});
