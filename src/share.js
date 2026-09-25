// Share sheet ingest: the model tiers and action presets offered on /share, the prompts each preset runs
// after a link is saved, and the Claude call behind the Claude Sonnet tier.
import Anthropic from "@anthropic-ai/sdk";

export const SHARE_TIERS = ["flash", "pro", "claude"];
export const SHARE_PRESETS = ["summarize", "event", "branch", "task"];
export const SHARE_TIER_LABELS = { flash: "Gemini Flash", pro: "Gemini Pro", claude: "Claude Sonnet" };
export const SHARE_PRESET_LABELS = { summarize: "📝 Summarize", event: "📅 Event", branch: "🌳 Branch", task: "📌 Action Task" };
const CLAUDE_MODEL = "claude-sonnet-5";
// Page text handed to a preset prompt (about 12k tokens).
const PRESET_INPUT_CHARS = 48000;
const TITLE_MAX = 200;
const TEXT_MAX = 4000;

const PRESET_INSTRUCTIONS = {
  summarize: [
    "Summarize this saved link in plain text (no Markdown headings or bold): a 2-4 sentence overview,",
    'then a blank line, then 3-6 key points, each on its own line starting with "- ".'
  ],
  event: [
    "Extract the event this saved link is about. Reply in plain text with one line each for:",
    "Event, Date, Time (with time zone if stated), Location, Organizer, Registration or tickets, then a one-sentence description.",
    'Write "Not stated" for anything the page does not say. If the link is not about an event, say so in one sentence and then summarize it briefly.'
  ],
  branch: [
    "Suggest 3-5 directions to explore next from this saved link: related topics, questions it raises, or ideas it could grow into.",
    'Reply in plain text, one per line starting with "- ", each a short title followed by one sentence on why it is worth exploring.'
  ],
  task: [
    "Turn this saved link into an action task. Reply in plain text: first line the task in imperative form,",
    'then a blank line, then 2-5 concrete next steps, each on its own line starting with "- ". Mention any deadline the page states.'
  ]
};

// Validates and trims the /api/share body. Returns { value } or { error }.
export function parseSharePayload(body) {
  const url = String(body?.url || "").trim();
  const title = String(body?.title || "").trim().slice(0, TITLE_MAX);
  const note = String(body?.note || "").trim().slice(0, TEXT_MAX);
  const tier = SHARE_TIERS.includes(body?.tier) ? body.tier : "flash";
  const preset = body?.preset === null || body?.preset === undefined || body?.preset === "" ? null : String(body.preset);
  if (preset !== null && !SHARE_PRESETS.includes(preset)) return { error: "Unknown action preset." };
  if (!url && !note) return { error: "Nothing to save: share a link or write a note." };
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "Only http(s) links can be saved." };
    } catch {
      return { error: "That link is not a valid URL." };
    }
  }
  return { value: { url, title, note, tier, preset } };
}

export function buildPresetPrompt(preset, { title, url, note, content }) {
  const text = String(content || "");
  return [
    ...PRESET_INSTRUCTIONS[preset],
    "Use only what the saved link and the note say; do not invent details.",
    "",
    "Title: " + (String(title || "").trim() || "(untitled)"),
    url ? "URL: " + url : "",
    note ? "Note from the person who saved it: " + note : "",
    text ? (text.length > PRESET_INPUT_CHARS ? "Page text (first part only):" : "Page text:") : "(The page text could not be fetched; work from the title, URL and note.)",
    text.slice(0, PRESET_INPUT_CHARS)
  ].filter(line => line !== "").join("\n");
}

// One Claude Sonnet call; returns the reply text. Throws when the key is missing or Claude declines.
export async function callClaude(apiKey, prompt) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    messages: [{ role: "user", content: prompt }]
  });
  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined this request" + (response.stop_details?.category ? " (" + response.stop_details.category + ")." : "."));
  }
  return response.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
}
