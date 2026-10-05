// Aether-hosted websites: a project's deliverable as a public page at /s/<slug>, on this Worker, with no new
// credentials. Mission Control writes a draft (an HTML page an agent produced, or the run's Markdown report turned into
// a page) with POST /api/sites; the public page only changes when the owner presses Publish in Mission Control, which
// sends { approve: true } from a signed-in, same-origin session. The engine has no portal session, so it can draft
// nothing and publish nothing on its own.
//
// Pages are user content on the portal's origin, so every /s/ response carries a CSP sandbox without allow-same-origin:
// the page runs in an opaque origin and cannot read the session cookie or call the portal's API as the user.

export const SITE_HTML_MAX = 500000;
export const SITE_TITLE_MAX = 120;
export const SITES_LIST_MAX = 50;
export const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
export const RESERVED_SLUGS = ["admin", "aether", "api", "app", "login", "mission-control", "new", "preview", "s", "settings", "www"];
export const SITE_CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors 'self'";

// The sandbox gives a page an opaque origin, where reading localStorage or sessionStorage throws. Pages often read
// a saved setting first thing (a theme), and the error stops the rest of their script (tabs, menus). This runs
// before the page's own scripts and swaps in an in-memory store for any storage that throws, so such pages work;
// values last for the visit only. It changes nothing else.
export const STORAGE_SHIM = "<script>(function(){function m(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){var a=Object.keys(d);return i<a.length?a[i]:null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('aether')}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}})})();</script>";

// The page with the storage shim placed first in <head> (or before everything when there is no <head>).
export function withStorageShim(html) {
  const text = String(html || "");
  const head = /<head(\s[^>]*)?>/i.exec(text);
  if (head) return text.slice(0, head.index + head[0].length) + STORAGE_SHIM + text.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  return doctype ? doctype[0] + STORAGE_SHIM + text.slice(doctype[0].length) : STORAGE_SHIM + text;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// A URL-safe slug from a title: "My Launch Plan!" -> "my-launch-plan". Empty when nothing usable is left.
export function slugify(title) {
  const slug = String(title ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug.length >= 3 ? slug : slug ? (slug + "-site") : "";
}

export function isValidSlug(slug) {
  return typeof slug === "string" && SITE_SLUG_PATTERN.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.includes(slug);
}

// A whole HTML document in an agent's answer: a ```html fenced block, or the text itself when it is a document.
// Returns the document or null.
export function extractHtmlDocument(text) {
  const source = String(text ?? "");
  const fenced = /```html\s*\n([\s\S]*?)```/i.exec(source);
  const candidate = (fenced ? fenced[1] : source).trim();
  return /^(<!doctype html|<html[\s>])/i.test(candidate) ? candidate : null;
}

// Inline Markdown on already-escaped text: `code`, **bold**, [text](https://...) and bare https links.
function inlineMarkdown(escaped) {
  const codes = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, code) => "\u0000" + (codes.push("<code>" + code + "</code>") - 1) + "\u0000");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" rel="noopener">$2</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

// A small, safe Markdown subset to HTML: # headings, - and 1. lists, paragraphs, inline code, bold and links.
// Everything is escaped first, so no HTML in the Markdown reaches the page.
export function markdownToHtml(markdown) {
  const html = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) html.push("<p>" + inlineMarkdown(paragraph.join(" ")) + "</p>");
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push("</" + list + ">");
    list = null;
  };
  for (const raw of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = escapeHtml(raw.trim());
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) {
      flushParagraph();
      closeList();
    } else if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length + 1;
      html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
    } else if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        html.push("<" + kind + ">");
        list = kind;
      }
      html.push("<li>" + inlineMarkdown((bullet || numbered)[1]) + "</li>");
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  closeList();
  return html.join("\n");
}

// A complete page around a Markdown deliverable, in the portal's teal system (navy, #00ffcc accents, system fonts).
// The report's own first "# Title" line is dropped, since the page header shows the title.
export function renderMarkdownSite(title, markdown) {
  const body = markdownToHtml(String(markdown ?? "").replace(/^\s*#\s+[^\n]*\n/, ""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(title)}">
<style>
  :root { color-scheme: dark; --bg: #0b1320; --surface: #101a2b; --text: #e6edf3; --muted: #9fb0c3; --accent: #00ffcc; --line: rgba(0, 255, 204, 0.18); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header, main, footer { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  header { padding-top: 56px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: clamp(28px, 6vw, 40px); line-height: 1.2; }
  main { padding-top: 16px; padding-bottom: 48px; }
  h2 { margin: 36px 0 8px; font-size: 22px; } h3, h4 { margin: 24px 0 6px; font-size: 18px; }
  a { color: var(--accent); overflow-wrap: anywhere; }
  code { padding: 1px 6px; border-radius: 6px; background: var(--surface); font-size: 0.9em; }
  ul, ol { padding-left: 22px; } li { margin: 4px 0; }
  footer { padding-bottom: 40px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1></header>
<main>
${body}
</main>
<footer>Made with Aether</footer>
</body>
</html>`;
}

const SUMMARY_COLUMNS = "slug, title, status, outcome_id, created_at, updated_at, published_at, (live_html IS NOT NULL AND live_html != draft_html) AS changed";

export function siteSummary(row) {
  return {
    slug: row.slug,
    title: row.title,
    status: row.status,
    outcome_id: row.outcome_id || null,
    url: "/s/" + row.slug,
    preview_url: "/s/" + row.slug + "?preview=1",
    unpublished_changes: Boolean(row.changed),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    published_at: row.published_at || null
  };
}

async function findSite(env, slug) {
  return env.DB.prepare("SELECT " + SUMMARY_COLUMNS + ", user_id FROM sites WHERE slug = ?").bind(slug).first();
}

// POST /api/sites: creates or updates the signed-in user's draft. { title, html? | markdown?, slug?, outcome_id? }.
// html must be a whole document (or contain one in a ```html block); markdown is turned into a page. Re-drafting a
// live site changes only the draft: the public page keeps the last published copy. Returns { status, body }.
export async function saveSiteDraft(env, userId, body) {
  const title = String(body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, SITE_TITLE_MAX);
  if (!title) return { status: 400, body: { error: "title is required." } };
  let html = null;
  if (typeof body?.html === "string" && body.html.trim()) {
    html = extractHtmlDocument(body.html);
    if (!html) return { status: 400, body: { error: "html must be a whole HTML document (starting with <!doctype html> or <html>)." } };
  } else if (typeof body?.markdown === "string" && body.markdown.trim()) {
    html = renderMarkdownSite(title, body.markdown);
  } else {
    return { status: 400, body: { error: "html or markdown is required." } };
  }
  if (html.length > SITE_HTML_MAX) return { status: 413, body: { error: "The page is too large (limit " + SITE_HTML_MAX.toLocaleString() + " characters)." } };
  const outcomeId = typeof body?.outcome_id === "string" && body.outcome_id.trim() ? body.outcome_id.trim().slice(0, 200) : null;

  const explicit = typeof body?.slug === "string" && body.slug.trim() !== "";
  let start = explicit ? body.slug.trim().toLowerCase() : slugify(title);
  if (explicit && !isValidSlug(start)) {
    return { status: 400, body: { error: "slug must be 3-48 lowercase letters, digits or single hyphens, and not a reserved word." } };
  }
  if (!isValidSlug(start)) start = isValidSlug(start + "-site") ? start + "-site" : "site-" + crypto.randomUUID().slice(0, 8);
  // An explicit slug must be free or already this user's; a slug from the title gets -2, -3... when someone else has it.
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? start : start.slice(0, 44).replace(/-+$/, "") + "-" + n;
    const existing = await findSite(env, slug);
    if (existing && existing.user_id !== userId) {
      if (explicit) return { status: 409, body: { error: "That address is taken. Pick another." } };
      continue;
    }
    if (existing) {
      await env.DB.prepare("UPDATE sites SET title = ?, draft_html = ?, outcome_id = COALESCE(?, outcome_id), updated_at = CURRENT_TIMESTAMP WHERE slug = ? AND user_id = ?")
        .bind(title, html, outcomeId, slug, userId).run();
    } else {
      await env.DB.prepare("INSERT INTO sites (slug, user_id, title, draft_html, status, outcome_id) VALUES (?, ?, ?, ?, 'draft', ?)")
        .bind(slug, userId, title, html, outcomeId).run();
    }
    const saved = await findSite(env, slug);
    return { status: existing ? 200 : 201, body: { success: true, site: siteSummary(saved || { slug, title, status: "draft", outcome_id: outcomeId }) } };
  }
  return { status: 409, body: { error: "Could not find a free address for that title. Pick a slug." } };
}

export async function listSites(env, userId) {
  const { results } = await env.DB.prepare("SELECT " + SUMMARY_COLUMNS + " FROM sites WHERE user_id = ? ORDER BY updated_at DESC LIMIT " + SITES_LIST_MAX).bind(userId).all();
  return { status: 200, body: { sites: (results || []).map(siteSummary) } };
}

// POST /api/sites/<slug>/publish { approve: true }: the operator's approval. Copies the draft to the public page.
export async function publishSite(env, userId, slug, body) {
  if (body?.approve !== true) return { status: 400, body: { error: "Publishing needs the operator's explicit approval ({ approve: true })." } };
  const result = await env.DB.prepare("UPDATE sites SET live_html = draft_html, status = 'live', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE slug = ? AND user_id = ?")
    .bind(slug, userId).run();
  if (!result?.meta?.changes) return { status: 404, body: { error: "Site not found." } };
  const saved = await findSite(env, slug);
  return { status: 200, body: { success: true, site: siteSummary(saved || { slug, status: "live" }) } };
}

// POST /api/sites/<slug>/unpublish: takes the public page down; the draft stays.
export async function unpublishSite(env, userId, slug) {
  const result = await env.DB.prepare("UPDATE sites SET live_html = NULL, status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE slug = ? AND user_id = ?")
    .bind(slug, userId).run();
  if (!result?.meta?.changes) return { status: 404, body: { error: "Site not found." } };
  const saved = await findSite(env, slug);
  return { status: 200, body: { success: true, site: siteSummary(saved || { slug, status: "draft" }) } };
}

export async function deleteSite(env, userId, slug) {
  const result = await env.DB.prepare("DELETE FROM sites WHERE slug = ? AND user_id = ?").bind(slug, userId).run();
  if (!result?.meta?.changes) return { status: 404, body: { error: "Site not found." } };
  return { status: 200, body: { success: true, deleted: slug } };
}

// /api/sites and /api/sites/<slug>[/publish|/unpublish] for a signed-in user (auth is checked by the caller).
export async function handleSitesApi(request, env, url, userId) {
  const match = /^\/api\/sites(?:\/([^/]+)(?:\/(publish|unpublish))?)?\/?$/.exec(url.pathname);
  if (!match) return json({ error: "Not found" }, 404);
  const [, rawSlug, action] = match;
  const body = request.method === "POST" ? await request.json().catch(() => null) : null;
  let result;
  if (!rawSlug) {
    if (request.method === "GET") result = await listSites(env, userId);
    else if (request.method === "POST") result = await saveSiteDraft(env, userId, body);
    else return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  } else {
    let slug = "";
    try {
      slug = decodeURIComponent(rawSlug).toLowerCase();
    } catch {
      slug = "";
    }
    if (!isValidSlug(slug)) return json({ error: "Site not found." }, 404);
    if (action) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      result = action === "publish" ? await publishSite(env, userId, slug, body) : await unpublishSite(env, userId, slug);
    } else if (request.method === "DELETE") {
      result = await deleteSite(env, userId, slug);
    } else {
      return json({ error: "Method not allowed" }, 405, { Allow: "DELETE" });
    }
  }
  return json(result.body, result.status);
}

function notFoundPage() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1320;color:#e6edf3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;padding:16px}a{color:#00ffcc}</style></head><body><main><h1>Nothing published here</h1><p>This address has no live page.</p></main></body></html>`, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": SITE_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }
  });
}

// GET /s/<slug>: the live page, public. ?preview=1 shows the owner the current draft (not indexed, not cached).
export async function serveSite(request, env, url, viewerId) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const match = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  let slug = "";
  try {
    slug = match ? decodeURIComponent(match[1]).toLowerCase() : "";
  } catch {
    slug = "";
  }
  if (!isValidSlug(slug)) return notFoundPage();
  const row = await env.DB.prepare("SELECT user_id, draft_html, live_html FROM sites WHERE slug = ?").bind(slug).first();
  if (!row) return notFoundPage();
  const preview = url.searchParams.get("preview") === "1" && viewerId && viewerId === row.user_id;
  const html = preview ? row.draft_html : row.live_html;
  if (!html) return notFoundPage();
  return new Response(request.method === "HEAD" ? null : withStorageShim(html), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SITE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": preview ? "no-store" : "public, max-age=60",
      ...(preview ? { "X-Robots-Tag": "noindex" } : {})
    }
  });
}
