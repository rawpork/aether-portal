import { describe, it, expect } from "vitest";
import { isYouTubeUrl, parseHtmlMetadata } from "../src/metadata.js";

describe("parseHtmlMetadata", () => {
	it("prefers OpenGraph tags regardless of attribute order", () => {
		const html = `<head><title>Fallback</title>
			<meta content="The &quot;Real&quot; Title &amp; More" property="og:title">
			<meta property='og:description' content='A short summary.'></head>`;
		expect(parseHtmlMetadata(html)).toEqual({ title: 'The "Real" Title & More', description: "A short summary." });
	});

	it("falls back to <title> and meta description", () => {
		const html = `<title>\n  Plain   Page &#8211; Site\n</title><meta name="description" content="Desc">`;
		expect(parseHtmlMetadata(html)).toEqual({ title: "Plain Page – Site", description: "Desc" });
	});

	it("returns null when there is no title", () => {
		expect(parseHtmlMetadata("<html><body>hi</body></html>")).toBeNull();
	});
});

describe("isYouTubeUrl", () => {
	it("matches YouTube hosts only", () => {
		expect(isYouTubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
		expect(isYouTubeUrl("https://youtu.be/abc")).toBe(true);
		expect(isYouTubeUrl("https://m.youtube.com/shorts/abc")).toBe(true);
		expect(isYouTubeUrl("https://notyoutube.com/watch")).toBe(false);
		expect(isYouTubeUrl("not a url")).toBe(false);
	});
});
