// Web Content Fetcher: downloads a link node's page and turns it into readable Markdown-style text
// (headings, list items and paragraphs kept; scripts, styles, navigation, headers and footers dropped).
import { cleanLinkUrl, decodeHtmlEntities, parseHtmlMetadata } from "./metadata.js";

const WEB_FETCH_TIMEOUT_MS = 10000;
// Pages bigger than this are cut off before parsing; the readable text of an article is far smaller.
const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_CONTENT_MAX_CHARS = 100000;
// A current desktop browser: many sites serve bots a stub or a block page.
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
// Whole elements that never hold the page's own text.
const DROPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "nav", "footer", "header", "aside", "form", "button", "select", "dialog"];
const BLOCK_ELEMENTS = ["p", "div", "section", "article", "main", "blockquote", "pre", "table", "tr", "ul", "ol", "dl", "dt", "dd", "figure", "figcaption", "hr"];

export class WebFetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Plain http(s) URLs on public hosts only: no credentials in the URL, no localhost or private address literals.
export function isFetchableUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (host.includes(":") && (host === "::1" || host === "::" || /^f[cd]/.test(host) || host.startsWith("fe80") || host.startsWith("::ffff:"))) return false;
  return true;
}

// The rest of a tag after its name. Quoted attribute values are skipped whole, because they can hold ">"
// (Wikipedia's data-mw JSON does), which would otherwise end the tag early and leak markup into the text.
const ATTRS = "(?:\"[^\"]*\"|'[^']*'|[^'\">])*";
const openTag = names => "<(?:" + names + ")\\b" + ATTRS + ">";
const anyTag = new RegExp("<\\/?[a-zA-Z!]" + ATTRS + ">", "g");

const removeElements = (html, tags) => tags.reduce(
  (text, tag) => text
    .replace(new RegExp(openTag(tag) + "[\\s\\S]*?<\\/" + tag + "\\s*>", "gi"), " ")
    .replace(new RegExp(openTag(tag), "gi"), " "),
  html
);

const innerOf = (tag, greedy = false) => new RegExp(openTag(tag) + "([\\s\\S]*" + (greedy ? "" : "?") + ")<\\/" + tag + "\\s*>", "gi");

// The page's main text: <article> (the longest one) or <main> when the page has them, otherwise <body>.
function pickMainHtml(html) {
  const articles = [...html.matchAll(innerOf("article"))].map(match => match[1]);
  if (articles.length) return articles.sort((a, b) => b.length - a.length)[0];
  const main = innerOf("main").exec(html);
  if (main) return main[1];
  const body = innerOf("body", true).exec(html);
  return body ? body[1] : html;
}

export function extractReadableText(html) {
  let text = String(html || "").replace(/<!--[\s\S]*?-->/g, " ");
  text = removeElements(text, ["script", "style", "noscript", "template", "head"]);
  text = removeElements(pickMainHtml(text), DROPPED_ELEMENTS);
  text = text
    .replace(new RegExp("<h([1-6])\\b" + ATTRS + ">([\\s\\S]*?)<\\/h\\1\\s*>", "gi"), (match, level, inner) => "\n\n" + "#".repeat(Number(level)) + " " + inner.replace(anyTag, " ") + "\n\n")
    .replace(new RegExp(openTag("li"), "gi"), "\n- ")
    .replace(new RegExp(openTag("br"), "gi"), "\n")
    .replace(new RegExp("<\\/?(?:" + BLOCK_ELEMENTS.join("|") + ")\\b" + ATTRS + ">", "gi"), "\n\n")
    .replace(new RegExp("<\\/?(?:td|th)\\b" + ATTRS + ">", "gi"), " ")
    .replace(anyTag, "");
  return decodeHtmlEntities(text)
    .split("\n")
    .map(line => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(line => line !== "-" && line !== "#")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, WEB_CONTENT_MAX_CHARS);
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes.length - offset));
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

// Returns { url, title, content }; throws WebFetchError (with an HTTP status for the API) when nothing usable came back.
export async function fetchWebContent(rawUrl) {
  const url = cleanLinkUrl(rawUrl);
  if (!isFetchableUrl(url)) throw new WebFetchError("Only public http(s) links can be fetched.", 400);

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": DESKTOP_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    throw new WebFetchError(err?.name === "TimeoutError" ? "The page took too long to respond." : "The page could not be reached.");
  }
  if (!response.ok) throw new WebFetchError("The page answered " + response.status + ".");

  const type = (response.headers.get("Content-Type") || "").toLowerCase();
  const isHtml = type.includes("html") || type.includes("xml") || !type;
  if (!isHtml && !type.startsWith("text/plain")) {
    await response.body?.cancel().catch(() => {});
    throw new WebFetchError("This link is not a web page (" + type.split(";")[0] + ").", 415);
  }
  const body = await readCapped(response, WEB_FETCH_MAX_BYTES);
  const content = isHtml ? extractReadableText(body) : body.replace(/\r\n?/g, "\n").trim().slice(0, WEB_CONTENT_MAX_CHARS);
  if (!content) throw new WebFetchError("No readable text was found on the page.", 422);
  const title = isHtml ? parseHtmlMetadata(body, response.url || url)?.title || null : null;
  return { url: response.url || url, title, content };
}
