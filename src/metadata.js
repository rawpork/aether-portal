// Link metadata lookup for Telegram ingestion: YouTube oEmbed, otherwise OpenGraph / <title> parsing.

const METADATA_FETCH_TIMEOUT_MS = 4000;
// OpenGraph tags live in <head>; no need to download whole pages.
const METADATA_MAX_HTML_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_SITE_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2000;

// Titles that only name the site: what bot-blocked / login-walled pages return. Treated as "no title".
const GENERIC_SITE_TITLES = new Set(["reddit", "facebook", "instagram", "x", "twitter", "tiktok", "youtube", "linkedin"]);
// Facebook-style "26K reactions · 1.6K shares | " prefixes: stale counts that bury the real caption.
const ENGAGEMENT_PREFIX = /^(?:[\d.,]+[KMB]?\s+(?:views?|reactions?|shares?|comments?|likes?)\s*(?:·\s*)?)+\|\s*/i;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

// Returns { title, description, image, siteName, sourceUrl, favicon } (all but title may be null), or null if nothing usable was found.
export async function fetchLinkMetadata(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  try {
    return isYouTubeUrl(parsed.href) ? await fetchYouTubeMetadata(parsed.href) : await fetchOpenGraphMetadata(parsed.href);
  } catch (err) {
    console.error("Link metadata fetch failed:", url, err);
    return null;
  }
}

async function fetchYouTubeMetadata(url) {
  const endpoint = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;

  const data = await response.json();
  const title = cleanTitle(data?.title);
  if (!title) return null;
  const author = cleanText(data?.author_name, MAX_TITLE_LENGTH);
  return {
    title,
    description: author ? "YouTube video by " + author : null,
    image: resolveHttpUrl(data?.thumbnail_url, url),
    siteName: "YouTube",
    sourceUrl: url,
    favicon: "https://www.youtube.com/favicon.ico"
  };
}

async function fetchOpenGraphMetadata(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AetherPortalBot/1.0)",
      Accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS)
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!response.ok || !/html/i.test(contentType)) {
    await response.body?.cancel();
    return null;
  }

  return parseHtmlMetadata(await readTextPrefix(response, METADATA_MAX_HTML_BYTES), response.url || url);
}

async function readTextPrefix(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

// Returns { title, description, image, siteName, sourceUrl, favicon } or null. Prefers OpenGraph, then Twitter cards,
// then <title>/meta description. Relative image/canonical URLs resolve against pageUrl; non-http(s) ones are dropped.
export function parseHtmlMetadata(html, pageUrl = null) {
  const meta = {};
  for (const [tag] of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content;
  }
  // First href per rel; apple-touch-icon is sharpest, mask-icon is a monochrome SVG and skipped.
  const icons = {};
  for (const [tag] of String(html || "").matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    const rel = String(attrs.rel || "").toLowerCase().trim();
    if (attrs.href && /\bicon\b/.test(rel) && !(rel in icons)) icons[rel] = attrs.href;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "")?.[1];

  const title = cleanTitle(meta["og:title"] || meta["twitter:title"] || titleTag);
  if (!title) return null;
  const description = cleanText(meta["og:description"] || meta["twitter:description"] || meta["description"], MAX_DESCRIPTION_LENGTH);
  return {
    title,
    description: description || null,
    image: resolveHttpUrl(meta["og:image:secure_url"] || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["twitter:image:src"], pageUrl),
    siteName: cleanText(meta["og:site_name"], MAX_SITE_NAME_LENGTH) || null,
    sourceUrl: resolveHttpUrl(meta["og:url"], pageUrl) || resolveHttpUrl(pageUrl, null),
    favicon: resolveHttpUrl(icons["apple-touch-icon"] || icons["icon"] || icons["shortcut icon"], pageUrl) || defaultFavicon(pageUrl)
  };
}

// Browsers' own fallback: /favicon.ico at the page's origin.
function defaultFavicon(pageUrl) {
  const page = resolveHttpUrl(pageUrl, null);
  return page ? new URL("/favicon.ico", page).href : null;
}

// Absolute http(s) URL or null; anything else (javascript:, data:, garbage) never reaches the card.
function resolveHttpUrl(value, base) {
  const text = decodeHtmlEntities(String(value || "")).trim();
  if (!text) return null;
  try {
    const resolved = base ? new URL(text, base) : new URL(text);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.href.length <= MAX_URL_LENGTH ? resolved.href : null;
  } catch {
    return null;
  }
}

function parseAttributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

function decodeHtmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// Returns "" for titles that are only a site name, so callers keep their fallback title.
export function cleanTitle(value) {
  const title = cleanText(value, Infinity).replace(ENGAGEMENT_PREFIX, "").trim().slice(0, MAX_TITLE_LENGTH);
  return GENERIC_SITE_TITLES.has(title.toLowerCase()) ? "" : title;
}

function cleanText(value, maxLength) {
  if (!value) return "";
  return decodeHtmlEntities(String(value)).replace(/\s+/g, " ").trim().slice(0, maxLength);
}
