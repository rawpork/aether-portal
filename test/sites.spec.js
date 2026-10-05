import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { extractHtmlDocument, isValidSlug, markdownToHtml, publishSite, saveSiteDraft, serveSite, SITE_CSP, slugify, unpublishSite } from "../src/sites.js";

// A stand-in D1 holding the sites table in memory, for the statements src/sites.js runs.
const fakeEnv = (rows = []) => {
	const sites = new Map(rows.map(row => [row.slug, { live_html: null, status: "draft", ...row }]));
	const summary = row => row && { ...row, changed: row.live_html !== null && row.live_html !== row.draft_html ? 1 : 0 };
	const DB = {
		prepare(sql) {
			return {
				bind(...args) {
					return {
						async first() {
							return summary(sites.get(args[0])) || null;
						},
						async all() {
							return { results: [...sites.values()].filter(row => row.user_id === args[0]).map(summary) };
						},
						async run() {
							if (sql.startsWith("INSERT")) {
								const [slug, user_id, title, draft_html, outcome_id] = args;
								sites.set(slug, { slug, user_id, title, draft_html, live_html: null, status: "draft", outcome_id });
								return { meta: { changes: 1 } };
							}
							const [slug, userId] = args.slice(-2);
							const row = sites.get(slug);
							if (!row || row.user_id !== userId) return { meta: { changes: 0 } };
							if (sql.includes("SET title")) Object.assign(row, { title: args[0], draft_html: args[1], outcome_id: args[2] ?? row.outcome_id });
							else if (sql.includes("live_html = draft_html")) Object.assign(row, { live_html: row.draft_html, status: "live", published_at: "now" });
							else if (sql.includes("live_html = NULL")) Object.assign(row, { live_html: null, status: "draft" });
							return { meta: { changes: 1 } };
						},
					};
				},
			};
		},
	};
	return { env: { DB }, sites };
};
const page = "<!doctype html><html><body>Hi</body></html>";
const get = (env, path, viewer = null) => serveSite(new Request("https://aether.test" + path), env, new URL("https://aether.test" + path), viewer);

describe("site helpers", () => {
	it("makes and checks slugs", () => {
		expect(slugify("My Launch Plan!")).toBe("my-launch-plan");
		expect(slugify("Café")).toBe("cafe");
		expect(slugify("AB")).toBe("ab-site");
		expect(isValidSlug("my-site")).toBe(true);
		for (const bad of ["ab", "-x-y", "a--b", "api", "UPPER", "a/b"]) expect(isValidSlug(bad), bad).toBe(false);
	});

	it("finds a whole HTML document in an answer", () => {
		expect(extractHtmlDocument("Here:\n```html\n" + page + "\n```")).toBe(page);
		expect(extractHtmlDocument(page)).toBe(page);
		expect(extractHtmlDocument("<div>fragment</div>")).toBeNull();
	});

	it("turns Markdown into escaped HTML", () => {
		const html = markdownToHtml("## Plan\n\n- **Go** to https://a.test\n- <script>x</script>\n\nSee [docs](https://d.test) and `code`.");
		expect(html).toContain("<h3>Plan</h3>");
		expect(html).toContain('<li><strong>Go</strong> to <a href="https://a.test" rel="noopener">https://a.test</a></li>');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain('<a href="https://d.test" rel="noopener">docs</a> and <code>code</code>');
	});
});

describe("drafts and publishing", () => {
	it("saves a draft from HTML, and the public page stays empty until it is published", async () => {
		const { env } = fakeEnv();
		const saved = await saveSiteDraft(env, "user_1", { title: "Launch Kit", html: page });
		expect(saved.status).toBe(201);
		expect(saved.body.site).toMatchObject({ slug: "launch-kit", status: "draft", url: "/s/launch-kit", preview_url: "/s/launch-kit?preview=1" });
		expect((await get(env, "/s/launch-kit")).status).toBe(404);
		const preview = await get(env, "/s/launch-kit?preview=1", "user_1");
		expect(preview.status).toBe(200);
		expect(preview.headers.get("Cache-Control")).toBe("no-store");
		expect((await get(env, "/s/launch-kit?preview=1", "user_2")).status).toBe(404);
	});

	it("publishes only with explicit approval and serves the page sandboxed", async () => {
		const { env } = fakeEnv();
		await saveSiteDraft(env, "user_1", { title: "Kit", markdown: "# Kit\n\nHello" });
		expect((await publishSite(env, "user_1", "kit", {})).status).toBe(400);
		expect((await publishSite(env, "user_2", "kit", { approve: true })).status).toBe(404);
		const published = await publishSite(env, "user_1", "kit", { approve: true });
		expect(published.body.site.status).toBe("live");
		const live = await get(env, "/s/kit");
		expect(live.status).toBe(200);
		expect(live.headers.get("Content-Security-Policy")).toBe(SITE_CSP);
		expect(SITE_CSP).not.toContain("allow-same-origin");
		expect(await live.text()).toContain("<p>Hello</p>");
	});

	it("keeps the published copy while a new draft waits for approval", async () => {
		const { env } = fakeEnv([{ slug: "kit", user_id: "user_1", title: "Kit", draft_html: page, live_html: page, status: "live" }]);
		const redraft = await saveSiteDraft(env, "user_1", { title: "Kit", slug: "kit", html: page.replace("Hi", "New") });
		expect(redraft.status).toBe(200);
		expect(redraft.body.site.unpublished_changes).toBe(true);
		expect(await (await get(env, "/s/kit")).text()).toContain("Hi");
		await unpublishSite(env, "user_1", "kit");
		expect((await get(env, "/s/kit")).status).toBe(404);
	});

	it("never takes another user's address", async () => {
		const { env } = fakeEnv([{ slug: "kit", user_id: "user_2", title: "Theirs", draft_html: page }]);
		expect((await saveSiteDraft(env, "user_1", { title: "Mine", slug: "kit", html: page })).status).toBe(409);
		const auto = await saveSiteDraft(env, "user_1", { title: "Kit", html: page });
		expect(auto.body.site.slug).toBe("kit-2");
	});

	it("rejects bad input", async () => {
		const { env } = fakeEnv();
		expect((await saveSiteDraft(env, "user_1", { html: page })).status).toBe(400);
		expect((await saveSiteDraft(env, "user_1", { title: "x" })).status).toBe(400);
		expect((await saveSiteDraft(env, "user_1", { title: "x", html: "<div>no</div>" })).status).toBe(400);
		expect((await saveSiteDraft(env, "user_1", { title: "x", slug: "API", html: page })).status).toBe(400);
	});
});

describe("site routes", () => {
	it("needs sign-in for /api/sites and answers 404 for addresses that cannot exist", async () => {
		expect((await SELF.fetch("http://example.com/api/sites")).status).toBe(401);
		const missing = await SELF.fetch("http://example.com/s/x");
		expect(missing.status).toBe(404);
		expect(missing.headers.get("Content-Security-Policy")).toBe(SITE_CSP);
	});
});
