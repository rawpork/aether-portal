import { describe, it, expect } from "vitest";
import { cleanTitle, isYouTubeUrl, parseHtmlMetadata } from "../src/metadata.js";

describe("parseHtmlMetadata", () => {
	it("prefers OpenGraph tags regardless of attribute order", () => {
		const html = `<head><title>Fallback</title>
			<meta content="The &quot;Real&quot; Title &amp; More" property="og:title">
			<meta property='og:description' content='A short summary.'></head>`;
		expect(parseHtmlMetadata(html)).toEqual({ title: 'The "Real" Title & More', description: "A short summary.", image: null, siteName: null, sourceUrl: null, favicon: null });
	});

	it("falls back to <title> and meta description", () => {
		const html = `<title>\n  Plain   Page &#8211; Site\n</title><meta name="description" content="Desc">`;
		expect(parseHtmlMetadata(html)).toEqual({ title: "Plain Page – Site", description: "Desc", image: null, siteName: null, sourceUrl: null, favicon: null });
	});

	it("extracts the cover image, site name and canonical source URL", () => {
		const html = `<meta property="og:title" content="Post"><meta property="og:image" content="/img/cover.png?a=1&amp;b=2">
			<meta property="og:site_name" content="Example Blog"><meta property="og:url" content="https://example.com/post">`;
		expect(parseHtmlMetadata(html, "https://example.com/post?utm=x")).toMatchObject({
			image: "https://example.com/img/cover.png?a=1&b=2",
			siteName: "Example Blog",
			sourceUrl: "https://example.com/post"
		});
	});

	it("drops non-http image URLs and falls back to the page URL as source", () => {
		const html = `<meta property="og:title" content="Post"><meta property="og:image" content="javascript:alert(1)">`;
		expect(parseHtmlMetadata(html, "https://example.com/a")).toMatchObject({ image: null, sourceUrl: "https://example.com/a" });
	});

	it("prefers the apple-touch-icon, resolves it, and skips mask icons", () => {
		const html = `<title>Page</title><link rel="mask-icon" href="/mask.svg"><link rel="icon" href="/fav.png"><link href="/touch.png" rel="apple-touch-icon">`;
		expect(parseHtmlMetadata(html, "https://example.com/a/b").favicon).toBe("https://example.com/touch.png");
		expect(parseHtmlMetadata(`<title>Page</title><link rel="shortcut icon" href="icons/s.ico">`, "https://example.com/a/b").favicon).toBe("https://example.com/a/icons/s.ico");
	});

	it("falls back to /favicon.ico at the page origin", () => {
		const html = `<title>Page</title><link rel="icon" href="data:image/png;base64,AAAA">`;
		expect(parseHtmlMetadata(html, "https://example.com/deep/page?x=1").favicon).toBe("https://example.com/favicon.ico");
	});

	it("returns null when there is no title", () => {
		expect(parseHtmlMetadata("<html><body>hi</body></html>")).toBeNull();
	});

	it("returns null when the title only names the site", () => {
		expect(parseHtmlMetadata('<meta property="og:title" content="Reddit"><meta name="description" content="x">')).toBeNull();
	});
});

describe("cleanTitle", () => {
	it("strips engagement-count prefixes", () => {
		expect(cleanTitle("26K reactions · 1.6K shares | The Truth About Streaming")).toBe("The Truth About Streaming");
		expect(cleanTitle("1.5K views · 9.3K reactions | Just watch me")).toBe("Just watch me");
		expect(cleanTitle("44 shares | The people moving fastest")).toBe("The people moving fastest");
	});

	it("leaves normal titles alone", () => {
		expect(cleanTitle("Top 10 reactions | A list")).toBe("Top 10 reactions | A list");
		expect(cleanTitle("Cloudflare D1")).toBe("Cloudflare D1");
	});

	it("rejects site-name-only titles", () => {
		for (const name of ["Reddit", "Facebook", "Instagram", "X", " twitter "]) expect(cleanTitle(name)).toBe("");
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
