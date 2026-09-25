import { describe, it, expect } from "vitest";
import { WEB_CONTENT_MAX_CHARS, extractReadableText, isFetchableUrl } from "../src/webfetch.js";

describe("extractReadableText", () => {
	it("keeps headings, paragraphs and list items and drops page chrome", () => {
		const html = `<html><head><title>T</title><style>p{}</style></head><body>
			<header><a href="/">Site</a> Menu</header>
			<nav><ul><li>Home</li><li>About</li></ul></nav>
			<h1>Main &amp; Title</h1>
			<p>First <b>bold</b> paragraph.<br>Second line.</p>
			<ul><li>One</li><li>Two</li></ul>
			<script>var x = "<p>not text</p>";</script>
			<!-- a comment -->
			<footer>© 2026</footer>
		</body></html>`;
		expect(extractReadableText(html)).toBe("# Main & Title\n\nFirst bold paragraph.\nSecond line.\n\n- One\n- Two");
	});

	it("prefers the longest <article>, then <main>, over the whole body", () => {
		const html = `<body><p>Sidebar junk</p><article><p>Short</p></article><article><h2>Story</h2><p>The long article body.</p></article></body>`;
		expect(extractReadableText(html)).toBe("## Story\n\nThe long article body.");
		expect(extractReadableText(`<body><div>Outer</div><main><p>Inside main</p></main></body>`)).toBe("Inside main");
	});

	it("does not leak markup from attribute values that contain >", () => {
		const html = `<body><p data-mw='{"html":"<ref>x</ref>","wt":"{{cite |a=b}}"}' title="a > b">Visible text</p><span data-x="</p>">and more</span></body>`;
		expect(extractReadableText(html)).toBe("Visible text\n\nand more");
	});

	it("caps very long pages", () => {
		const html = "<p>" + "word ".repeat(40000) + "</p>";
		expect(extractReadableText(html).length).toBe(WEB_CONTENT_MAX_CHARS);
	});

	it("returns an empty string for empty or script-only pages", () => {
		for (const value of [null, "", "<script>1</script>", "<body><nav>Menu</nav></body>"]) {
			expect(extractReadableText(value), String(value)).toBe("");
		}
	});
});

describe("isFetchableUrl", () => {
	it("allows public http(s) pages", () => {
		for (const url of ["https://example.com/a?b=1", "http://news.example.org", "https://93.184.216.34/"]) {
			expect(isFetchableUrl(url), url).toBe(true);
		}
	});

	it("rejects other schemes, credentials, local names and private addresses", () => {
		for (const url of ["ftp://example.com", "javascript:alert(1)", "https://user:pw@example.com", "http://localhost:8787", "http://intranet", "http://printer.local", "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.1", "http://172.20.0.1", "http://169.254.169.254/latest", "http://[::1]/", "not a url"]) {
			expect(isFetchableUrl(url), url).toBe(false);
		}
	});
});
