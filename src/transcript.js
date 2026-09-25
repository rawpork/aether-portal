// YouTube Transcript Pipeline: caption tracks from YouTube's player API, flattened to plain text, plus the
// prompts that turn a transcript (or, without captions, the video itself) into a synopsis.
import { decodeHtmlEntities } from "./metadata.js";

const TRANSCRIPT_FETCH_TIMEOUT_MS = 8000;
// Stored transcripts are capped well under D1's row size limit; an hour of speech is roughly 60k characters.
export const TRANSCRIPT_MAX_CHARS = 200000;
// Transcript text sent to Gemini for the synopsis (about 15k tokens).
const SYNOPSIS_INPUT_CHARS = 60000;
const PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
// The web client's player response carries no caption tracks without a proof-of-origin token; the mobile
// clients still list them. Tried in order, so a client that is blocked or empty falls through to the next.
const PLAYER_CLIENTS = [
  {
    client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 },
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
  },
  {
    client: { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2" },
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)"
  }
];

// Hand-made captions beat auto-generated ones, and English beats other languages, in that order.
export function pickCaptionTrack(tracks, language = "en") {
  const usable = (Array.isArray(tracks) ? tracks : []).filter(track => track && typeof track.baseUrl === "string" && track.baseUrl);
  const isLanguage = track => String(track.languageCode || "").toLowerCase().split("-")[0] === language;
  const isAuto = track => track.kind === "asr";
  return usable.find(track => isLanguage(track) && !isAuto(track))
    || usable.find(track => isLanguage(track))
    || usable.find(track => !isAuto(track))
    || usable[0]
    || null;
}

// Two timedtext formats come back depending on the client: <text start dur>…</text> (format 1, whose text is
// HTML-escaped a second time) and <p t d>…</p> with per-word <s> spans (format 3). One caption line per row.
export function parseTranscriptXml(xml) {
  const lines = [];
  for (const match of String(xml || "").matchAll(/<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const text = decodeHtmlEntities(decodeHtmlEntities(match[2].replace(/<[^>]*>/g, "")))
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

// Returns { text, language, auto } or null when the video has no captions or YouTube refuses the request.
export async function fetchYouTubeTranscript(videoId) {
  for (const { client, userAgent } of PLAYER_CLIENTS) {
    try {
      const response = await fetch(PLAYER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent },
        body: JSON.stringify({ context: { client: { ...client, hl: "en" } }, videoId }),
        signal: AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS)
      });
      if (!response.ok) {
        console.warn(`YouTube player (${client.clientName}) answered ${response.status} for ${videoId}.`);
        continue;
      }
      const player = await response.json();
      const track = pickCaptionTrack(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
      if (!track) {
        console.warn(`YouTube player (${client.clientName}) listed no captions for ${videoId}: ${player?.playabilityStatus?.status || "unknown"}.`);
        continue;
      }
      const captions = await fetch(track.baseUrl, {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS)
      });
      if (!captions.ok) {
        console.warn(`YouTube captions (${client.clientName}) answered ${captions.status} for ${videoId}.`);
        continue;
      }
      const text = parseTranscriptXml(await captions.text());
      if (!text) continue;
      return { text: text.slice(0, TRANSCRIPT_MAX_CHARS), language: String(track.languageCode || ""), auto: track.kind === "asr" };
    } catch (err) {
      console.warn(`YouTube transcript (${client.clientName}) failed for ${videoId}:`, err.message);
    }
  }
  return null;
}

const SYNOPSIS_FORMAT = [
  "Write the synopsis in plain text (no Markdown headings or bold): a 2-4 sentence overview of what the video covers,",
  'then a blank line, then 3-6 key points, each on its own line starting with "- ".',
  "Write it in English even if the video is in another language. Do not add anything the video does not say."
];

export function buildTranscriptSynopsisPrompt(title, transcript) {
  const text = String(transcript || "");
  const clipped = text.length > SYNOPSIS_INPUT_CHARS;
  return [
    "Summarize this YouTube video from its transcript.",
    ...SYNOPSIS_FORMAT,
    "",
    "Title: " + (String(title || "").trim() || "(untitled)"),
    clipped ? "Transcript (first part only; the video continues past this point):" : "Transcript:",
    text.slice(0, SYNOPSIS_INPUT_CHARS)
  ].join("\n");
}

// Used with the video itself attached when no captions could be fetched.
export function buildVideoSynopsisPrompt(title) {
  return [
    "Summarize this YouTube video.",
    ...SYNOPSIS_FORMAT,
    "",
    "Title: " + (String(title || "").trim() || "(untitled)")
  ].join("\n");
}
