import { describe, it, expect } from "vitest";
import { cleanLinkUrl, cleanTitle, fallbackLinkTitle, getYouTubeVideoId, isYouTubeUrl, parseHtmlMetadata } from "../src/metadata.js";

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

describe("getYouTubeVideoId", () => {
	it("reads the id from every common URL shape", () => {
		for (const url of [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
			"https://youtu.be/dQw4w9WgXcQ?si=abc",
			"https://m.youtube.com/shorts/dQw4w9WgXcQ",
			"https://www.youtube.com/embed/dQw4w9WgXcQ",
			"https://www.youtube.com/live/dQw4w9WgXcQ?feature=share"
		]) expect(getYouTubeVideoId(url), url).toBe("dQw4w9WgXcQ");
	});

	it("rejects non-YouTube hosts and malformed ids", () => {
		expect(getYouTubeVideoId("https://vimeo.com/dQw4w9WgXcQ")).toBeNull();
		expect(getYouTubeVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
		expect(getYouTubeVideoId("nope")).toBeNull();
	});
});

describe("cleanLinkUrl", () => {
	it("drops Facebook and ad tracking parameters but keeps meaningful ones", () => {
		expect(cleanLinkUrl("https://www.facebook.com/share/r/1ByXqcB56g/?mibextid=wwXIfr")).toBe("https://www.facebook.com/share/r/1ByXqcB56g/");
		expect(cleanLinkUrl("https://example.com/p?utm_source=fb&utm_medium=paid&fbclid=Iw&id=7")).toBe("https://example.com/p?id=7");
		expect(cleanLinkUrl("https://www.google.com/search?q=best+routes&gclid=x")).toBe("https://www.google.com/search?q=best+routes");
	});

	it("drops YouTube share ids only on YouTube", () => {
		expect(cleanLinkUrl("https://youtu.be/dQw4w9WgXcQ?si=abc&t=42")).toBe("https://youtu.be/dQw4w9WgXcQ?t=42");
		expect(cleanLinkUrl("https://example.com/?si=keep")).toBe("https://example.com/?si=keep");
	});

	it("leaves non-URLs alone", () => {
		expect(cleanLinkUrl("  just text ")).toBe("just text");
	});
});

describe("fallbackLinkTitle", () => {
	it("names Facebook links by kind instead of showing the share URL", () => {
		expect(fallbackLinkTitle("https://www.facebook.com/share/r/1ByXqcB56g/")).toBe("Facebook Reel");
		expect(fallbackLinkTitle("https://www.facebook.com/reel/1635289831288212/")).toBe("Facebook Reel");
		expect(fallbackLinkTitle("https://fb.watch/abc123/")).toBe("Facebook Video");
		expect(fallbackLinkTitle("https://www.facebook.com/page/videos/some-clip/123")).toBe("Facebook Video");
		expect(fallbackLinkTitle("https://www.facebook.com/share/p/1Bx1Jh5d18/")).toBe("Facebook Post");
		expect(fallbackLinkTitle("https://m.facebook.com/groups/123/posts/456")).toBe("Facebook Group Post");
	});

	it("uses the search query, the YouTube kind, or a readable path segment", () => {
		expect(fallbackLinkTitle("https://www.google.com/search?q=best+routes+to+nashville")).toBe("Google search: best routes to nashville");
		expect(fallbackLinkTitle("https://youtube.com/shorts/xcxbOcc36dM")).toBe("YouTube Short");
		expect(fallbackLinkTitle("https://youtu.be/dQw4w9WgXcQ")).toBe("YouTube Video");
		expect(fallbackLinkTitle("https://go.stripe.global/rs/072-MDK-283/images/Pricing_AI_products.pdf")).toBe("Pricing AI products · go.stripe.global");
		expect(fallbackLinkTitle("https://www.reddit.com/r/promoteMyApp/s/jpMwoJ66of")).toBe("PromoteMyApp · reddit.com");
		expect(fallbackLinkTitle("https://share.google/eSMugMLxOwla4YARF")).toBe("share.google");
	});
});

describe("cleanTitle placeholders", () => {
	it("rejects login walls, share placeholders and bare URLs", () => {
		for (const title of ["Facebook", "facebook/share", "Log in or sign up to view", "Log into Facebook", "Facebook - Log In or Sign Up", "https://www.facebook.com/share/r/x/"]) {
			expect(cleanTitle(title), title).toBe("");
		}
	});

	it("keeps real titles that merely mention logging in", () => {
		expect(cleanTitle("Login flows explained")).toBe("Login flows explained");
		expect(cleanTitle("How to log in to your router")).toBe("How to log in to your router");
	});
});
