// Link metadata lookup for Telegram and UI ingestion: YouTube oEmbed, otherwise OpenGraph / <title> parsing,
// plus URL cleaning and readable fallback titles when a page gives nothing usable.

const METADATA_FETCH_TIMEOUT_MS = 4000;
// OpenGraph tags live in <head>; no need to download whole pages.
const METADATA_MAX_HTML_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_SITE_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2000;
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; AetherPortalBot/1.0)";
// Facebook often answers data-center clients (like Workers) with a login wall, but serves full Open Graph tags
// to its own link-preview crawler, so Facebook links that come back empty are retried once with that user agent.
const FACEBOOK_CRAWLER_USER_AGENT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
// Share and ad-tracking query parameters: dropped before fetching and saving, they never change the page.
const TRACKING_PARAMS = new Set(["mibextid", "rdid", "share_url", "fbclid", "gclid", "dclid", "msclkid", "igsh", "igshid", "mc_cid", "mc_eid"]);
const YOUTUBE_TRACKING_PARAMS = new Set(["si", "is", "feature", "pp"]);

// Titles that only name the site: what bot-blocked / login-walled pages return. Treated as "no title".
const GENERIC_SITE_TITLES = new Set(["reddit", "facebook", "instagram", "x", "twitter", "tiktok", "youtube", "linkedin"]);
// Login walls and share-link placeholders ("facebook/share", "Log in or sign up to view", a bare URL).
const PLACEHOLDER_TITLES = [
  /^(?:www\.)?facebook(?:\.com)?\/share\b/i,
  /^log in(?:to| to)? (?:facebook|instagram)\b/i,
  /\blog in or sign up\b/i,
  /^facebook\s*[-–|:]\s*log in\b/i,
  /^https?:\/\/\S+$/i
];
// Facebook-style "26K reactions · 1.6K shares | " prefixes: stale counts that bury the real caption.
const ENGAGEMENT_PREFIX = /^(?:[\d.,]+[KMB]?\s+(?:views?|reactions?|shares?|comments?|likes?)\s*(?:·\s*)?)+\|\s*/i;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function isFacebookUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "fb.watch" || host === "fb.com" || host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

// The 11-character video id from watch, youtu.be, shorts, embed and live URLs, or null.
export function getYouTubeVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
    let id = "";
    if (host === "youtu.be") id = parsed.pathname.split("/")[1] || "";
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = parsed.searchParams.get("v") || /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(parsed.pathname)?.[1] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Drops share/ad tracking parameters (Facebook mibextid, fbclid, utm_*, YouTube si/is...). Other parameters stay,
// so search queries, video ids and timestamps survive. Non-URLs come back unchanged (trimmed).
export function cleanLinkUrl(url) {
  const text = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return text;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return text;
  const youtube = isYouTubeUrl(parsed.href);
  for (const key of [...new Set(parsed.searchParams.keys())]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith("utm_") || (youtube && YOUTUBE_TRACKING_PARAMS.has(lower))) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.href;
}

// A readable title for a link whose page gave none: the kind of Facebook post, a Google search's query,
// or the last meaningful path segment plus the site. Never the raw URL.
export function fallbackLinkTitle(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return String(url || "").trim().slice(0, 60) || "Saved link";
  }
  const host = parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile|web)\./, "");
  const path = parsed.pathname;

  if (isFacebookUrl(parsed.href)) {
    if (host === "fb.watch" || /^\/(?:share\/v|watch)\b/.test(path) || /\/videos\//.test(path)) return "Facebook Video";
    if (/^\/(?:share\/r|reels?)\//.test(path)) return "Facebook Reel";
    if (/^\/(?:groups|share\/g)\//.test(path)) return "Facebook Group Post";
    if (/^\/events\//.test(path)) return "Facebook Event";
    return "Facebook Post";
  }
  if (isYouTubeUrl(parsed.href)) return /^\/shorts\//.test(path) ? "YouTube Short" : "YouTube Video";
  const query = parsed.searchParams.get("q");
  if (/^google\.[a-z.]+$/.test(host) && path === "/search" && query) {
    return ("Google search: " + query.replace(/\s+/g, " ").trim()).slice(0, MAX_TITLE_LENGTH);
  }

  const segments = path.split("/").filter(Boolean);
  let segment = "";
  for (let i = segments.length - 1; i >= 0 && !segment; i--) {
    let value = segments[i];
    try { value = decodeURIComponent(value); } catch {}
    value = value.replace(/\.(?:html?|php|aspx?|pdf)$/i, "").replace(/[-_+]+/g, " ").trim();
    // Skip opaque ids and share tokens (e.g. "jpMwoJ66of", "1Bx1Jh5d18", long hex).
    const looksLikeId = /^[a-z0-9]{8,}$/i.test(value) && /\d/.test(value) || /^[0-9a-f-]{16,}$/i.test(value) || /^\d+$/.test(value);
    if (value && !looksLikeId && value.length > 1) segment = value;
  }
  if (!segment) return host;
  return (segment.charAt(0).toUpperCase() + segment.slice(1) + " · " + host).slice(0, MAX_TITLE_LENGTH);
}

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
    parsed = new URL(cleanLinkUrl(url));
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
  const videoId = getYouTubeVideoId(url);
  return {
    title,
    description: author ? "YouTube video by " + author : null,
    image: videoId ? await pickYouTubeThumbnail(videoId) : resolveHttpUrl(data?.thumbnail_url, url),
    siteName: "YouTube",
    sourceUrl: url,
    favicon: "https://www.youtube.com/favicon.ico"
  };
}

// maxresdefault is a sharp 16:9 frame but only exists for HD uploads (YouTube answers 404 otherwise);
// hqdefault always exists but is 4:3 with black bars baked in.
async function pickYouTubeThumbnail(videoId) {
  const maxres = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  try {
    const response = await fetch(maxres, { method: "HEAD", signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS) });
    if (response.ok) return maxres;
  } catch {}
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

async function fetchOpenGraphMetadata(url) {
  const metadata = await fetchHtmlMetadata(url, BOT_USER_AGENT);
  if (metadata || !isFacebookUrl(url)) return metadata;
  return fetchHtmlMetadata(url, FACEBOOK_CRAWLER_USER_AGENT);
}

async function fetchHtmlMetadata(url, userAgent) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
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

// Returns "" for titles that are only a site name or a login/share placeholder, so callers use their fallback.
export function cleanTitle(value) {
  const title = cleanText(value, Infinity).replace(ENGAGEMENT_PREFIX, "").trim().slice(0, MAX_TITLE_LENGTH);
  if (GENERIC_SITE_TITLES.has(title.toLowerCase())) return "";
  return PLACEHOLDER_TITLES.some(pattern => pattern.test(title)) ? "" : title;
}

function cleanText(value, maxLength) {
  if (!value) return "";
  return decodeHtmlEntities(String(value)).replace(/\s+/g, " ").trim().slice(0, maxLength);
}
