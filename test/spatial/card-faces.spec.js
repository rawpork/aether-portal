import { describe, expect, it } from "vitest";
import { faceFromNode, faceKey, wrapText, youtubeThumb } from "../../public/js/spatial/card-faces.js";

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

	it("shows a portal note's text from its description, without repeats", () => {
		expect(faceFromNode({ id: "p", category: "note", title: "Welcome", url: "", description: "This is your knowledge graph." }).text).toBe("This is your knowledge graph.");
		expect(faceFromNode({ id: "q", category: "note", title: "T", url: "Same", description: "Same", user_note: "Mine" }).text).toBe("Same · Mine");
	});

	it("falls back to a video's synopsis, and to its YouTube thumbnail when it has no preview image", () => {
		const face = faceFromNode({ id: "v", category: "video", title: "Talk", url: "https://youtu.be/dQw4w9WgXcQ", synopsis: "A talk about XR." });
		expect(face.text).toBe("A talk about XR.");
		expect(face.thumbUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
		expect(youtubeThumb("https://example.com/a")).toBeNull();
	});

	it("carries up to three tags, the user's own first, and redraws when they change", () => {
		const tags = [{ tag: "ai", source: "ai", weight: 0.9 }, { tag: "mine", source: "user", weight: 0.1 }, { tag: "seo", source: "ai", weight: 0.5 }, { tag: "low", source: "ai", weight: 0.2 }];
		const face = faceFromNode({ id: "t", category: "note", title: "T", url: "", tags });
		expect(face.tags).toEqual(["mine", "ai", "seo"]);
		expect(faceKey(face, false)).not.toBe(faceKey({ ...face, tags: ["mine"] }, false));
	});

	it("changes its key only when something visible changes", () => {
		const base = faceFromNode({ id: "a", category: "link", title: "A", url: "https://a.test" });
		expect(faceKey(base, false)).toBe(faceKey({ ...base }, false));
		expect(faceKey(base, false)).not.toBe(faceKey(base, true));
		expect(faceKey(base, false)).not.toBe(faceKey({ ...base, group: { name: "G", color: "#fff" } }, false));
	});
});

describe("faceFromNode for Outcome Nodes", () => {
	it("uses the outcome face with plan details and source topics", () => {
		const face = faceFromNode(
			{ id: "o1", category: "outcome", title: "Launch a funnel", url: "aether:outcome/o1", description: "Why", outcome_status: "accepted", outcome_plan: { template: "content_creation", goal: "Get sign-ups", effort: "2 weekends", steps: [{}, {}, {}] } },
			{ categoryColor: "#ffb627", categoryLabel: "outcome", sources: ["AI video", "SEO", "Lead gen", "Extra"] }
		);
		expect(face).toMatchObject({ type: "outcome", text: "Get sign-ups", site: "", outcome: { steps: 3, effort: "2 weekends", template: "Content", status: "accepted", sources: ["AI video", "SEO", "Lead gen"] } });
		expect(faceKey(face, false)).not.toBe(faceKey({ ...face, outcome: { ...face.outcome, status: "sent" } }, false));
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
