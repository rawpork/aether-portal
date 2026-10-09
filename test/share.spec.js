import { describe, it, expect } from "vitest";
import { buildPresetPrompt, parseSharePayload } from "../src/share.js";
import { missionControlShareUrl, normalizeSharedInput, renderSharePage } from "../src/share-page.js";

describe("parseSharePayload", () => {
	it("accepts a link with a tier and preset, defaulting the tier to Flash", () => {
		expect(parseSharePayload({ url: "https://example.com/x", title: " Post ", note: " read later ", tier: "claude", preset: "event" }))
			.toEqual({ value: { url: "https://example.com/x", title: "Post", note: "read later", tier: "claude", preset: "event" } });
		expect(parseSharePayload({ url: "https://example.com", tier: "gpt" }).value).toMatchObject({ tier: "flash", preset: null });
		expect(parseSharePayload({ note: "just a thought" }).value).toMatchObject({ url: "", note: "just a thought" });
	});

	it("rejects empty shares, bad links and unknown presets", () => {
		expect(parseSharePayload({}).error).toBeTruthy();
		expect(parseSharePayload(null).error).toBeTruthy();
		expect(parseSharePayload({ url: "javascript:alert(1)" }).error).toBeTruthy();
		expect(parseSharePayload({ url: "not a url" }).error).toBeTruthy();
		expect(parseSharePayload({ url: "https://example.com", preset: "delete" }).error).toBeTruthy();
	});
});

describe("buildPresetPrompt", () => {
	it("includes the preset instructions, link details and page text", () => {
		const prompt = buildPresetPrompt("event", { title: "Meetup", url: "https://e.test", note: "with Sam", content: "June 3 at the library" });
		expect(prompt).toContain("Extract the event");
		expect(prompt).toContain("Title: Meetup");
		expect(prompt).toContain("URL: https://e.test");
		expect(prompt).toContain("Note from the person who saved it: with Sam");
		expect(prompt).toContain("Page text:\nJune 3 at the library");
	});

	it("says when the page text is missing", () => {
		expect(buildPresetPrompt("summarize", { title: "", url: "https://e.test" })).toContain("could not be fetched");
	});
});

describe("normalizeSharedInput", () => {
	it("pulls the link out of shared text and keeps the rest as a note", () => {
		expect(normalizeSharedInput({ text: "Look at this https://www.example.com/post?id=1. So good" }))
			.toEqual({ url: "https://www.example.com/post?id=1", title: "", note: "Look at this So good", domain: "example.com" });
	});

	it("uses the url field and drops a title or text that only repeats it", () => {
		expect(normalizeSharedInput({ url: "https://a.test/x", title: "https://a.test/x", text: "https://a.test/x" }))
			.toEqual({ url: "https://a.test/x", title: "", note: "", domain: "a.test" });
	});

	it("handles a plain note with no link", () => {
		expect(normalizeSharedInput({ text: "buy milk" })).toEqual({ url: "", title: "", note: "buy milk", domain: "" });
	});
});

describe("renderSharePage", () => {
	it("escapes shared values into the page and has a parseable script", () => {
		const html = renderSharePage({ url: "https://x.test/a", title: "</script><script>alert(1)</script>", text: "" }, { claudeAvailable: false });
		expect(html).not.toContain("</script><script>alert(1)");
		const json = /<script type="application\/json" id="share-data">([\s\S]*?)<\/script>/.exec(html)[1];
		expect(JSON.parse(json)).toMatchObject({ url: "https://x.test/a", title: "</script><script>alert(1)</script>", claudeAvailable: false });
		for (const id of ["link", "input", "ribbon", "ingest"]) expect(html, id).toContain(`id="${id}"`);
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
		expect(scripts.length).toBe(1);
		expect(() => new Function(scripts[0])).not.toThrow();
	});

	it("offers View Node after saving instead of closing the window", () => {
		const html = renderSharePage({ url: "https://x.test/a" });
		expect(html).toContain('id="view-node"');
		expect(html).toContain("'/node/' + encodeURIComponent(id)");
		expect(html).not.toMatch(/setTimeout[(]finish/);
	});

	it("offers one row of quick-insert command chips", () => {
		const html = renderSharePage({ url: "https://x.test/a" });
		for (const chip of ["/research", "/learn", "/ask", "#task", "#done", "/summary", "/event", "/pro", "/claude"]) expect(html, chip).toContain(`data-insert="${chip}"`);
	});
});

describe("/share into Mission Control", () => {
	it("the Ingest page offers Make it a project instead, pointing at the New project dialog", () => {
		const html = renderSharePage({ url: "https://a.test/x" }, { projectUrl: missionControlShareUrl("https://p.test", { url: "https://a.test/x" }) });
		expect(html).toContain('id="ingest"');
		expect(html).toContain('id="make-project" href="https://p.test/mission-control?share_url=https%3A%2F%2Fa.test%2Fx"');
		expect(renderSharePage({ url: "https://a.test/x" })).not.toContain("make-project");
	});

	it("sends a shared link to the New project dialog, and shared text alone to the goal", () => {
		expect(missionControlShareUrl("https://p.test", { url: "https://a.test/x?y=1", title: "A page" })).toBe("https://p.test/mission-control?share_url=https%3A%2F%2Fa.test%2Fx%3Fy%3D1&share_title=A+page");
		const android = new URL(missionControlShareUrl("https://p.test", { text: "Look https://b.test/z great find" }));
		expect(android.searchParams.get("share_url")).toBe("https://b.test/z");
		expect(android.searchParams.get("share_text")).toBe("Look great find");
		expect(new URL(missionControlShareUrl("https://p.test", { text: "just words" })).searchParams.get("share_text")).toBe("just words");
		expect(missionControlShareUrl("https://p.test", {})).toBe("https://p.test/mission-control");
	});
});
