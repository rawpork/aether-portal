// Daily connection miner: one batched Gemini prompt categorizes unanalyzed nodes, links related ones, and extracts
// keywords and a concept group for each (SPATIAL_ARCHITECTURE.md, section 1.5).
import { normalizeGroupName, normalizeTag } from "./groups.js";

// Unanalyzed nodes sent per run, plus recently analyzed nodes offered as edge targets.
export const MINER_BATCH_SIZE = 40;
export const MINER_CONTEXT_SIZE = 60;
const MAX_EDGES_PER_NEW_NODE = 3;
const MAX_ITEM_TEXT_LENGTH = 160;
// Opening words of a node's fetched page text or video synopsis, so items are judged by what they say, not just titles.
const MAX_SNIPPET_LENGTH = 200;
const MAX_RELATION_LENGTH = 60;
const MAX_TAGS_PER_NODE = 5;
// Existing group names offered to Gemini for reuse, most used first.
export const MINER_GROUP_NAMES_MAX = 60;
// A group name Gemini invents is only created when at least this many NEW items share it.
const MIN_NODES_FOR_NEW_GROUP = 2;

// Items are numbered in the prompt so Gemini never has to echo (or invent) node ids.
export function buildMinerPrompt(newNodes, contextNodes, categories, groupNames = []) {
  const describe = (node, index) => {
    const title = String(node.title || "");
    const url = String(node.url || "");
    const text = title && title !== url ? title + " | " + url : url || title;
    const snippet = String(node.snippet || "").replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_LENGTH);
    return "[" + index + "] (" + (node.category || "note") + ") " + text.replace(/\s+/g, " ").slice(0, MAX_ITEM_TEXT_LENGTH) + (snippet ? " :: " + snippet : "");
  };
  const lines = [...newNodes, ...contextNodes].map(describe);
  const lastNew = newNodes.length - 1;
  const groups = groupNames.slice(0, MINER_GROUP_NAMES_MAX);

  return [
    "You organize a personal knowledge graph of saved links and notes.",
    `Items 0-${lastNew} are NEW. For every NEW item pick the best category from: ${categories.join(", ")}.`,
    `For every NEW item also give 3-${MAX_TAGS_PER_NODE} tags: specific lowercase keywords for its concepts, tools, people or places (for example "spaced repetition", "anki"), never generic words like "article", "video", "link" or "interesting". Weight each tag from 0 to 1 by how central it is to the item.`,
    "Give every NEW item a group: a short concept name (1-3 words, Title Case) for the theme it belongs to.",
    groups.length
      ? `Reuse one of these existing groups whenever it fits: ${groups.map(name => JSON.stringify(name)).join(", ")}. Only invent a new group when none fits and at least two NEW items share it.`
      : "Only invent a group when at least two NEW items share it; otherwise leave group empty.",
    "Then list edges between items that are genuinely related (same topic, project, tool, or one builds on the other).",
    `Every edge must involve at least one NEW item. At most ${MAX_EDGES_PER_NEW_NODE} edges per NEW item. Skip weak or generic similarities.`,
    'Return only valid JSON: {"nodes":[{"i":0,"category":"...","tags":[{"tag":"...","weight":0.9}],"group":"..."}],"edges":[{"a":0,"b":5,"relation":"short phrase"}]}',
    "Items:",
    ...lines
  ].join("\n");
}

// Tags as [{ tag, weight }], strongest first. Accepts objects or plain strings (weighted by position).
function parseMinerTags(value) {
  const tags = new Map();
  (Array.isArray(value) ? value : []).forEach((entry, position) => {
    const tag = normalizeTag(typeof entry === "string" ? entry : entry?.tag);
    if (!tag) return;
    const given = typeof entry === "string" ? NaN : Number(entry?.weight);
    const weight = Number.isFinite(given) ? Math.min(1, Math.max(0, given)) : Math.max(0.3, 1 - position * 0.15);
    const rounded = Math.round(weight * 100) / 100;
    if (!tags.has(tag) || tags.get(tag) < rounded) tags.set(tag, rounded);
  });
  return [...tags]
    .map(([tag, weight]) => ({ tag, weight }))
    .sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag))
    .slice(0, MAX_TAGS_PER_NODE);
}

// Validates Gemini's answer against the prompt's numbering. Returns { categories: Map<index, category>, edges,
// tags: Map<index, [{ tag, weight }]>, groups: Map<index, name> }. A group name that matches an existing group (any
// case) takes that group's spelling; a new name is kept only when enough NEW items share it.
export function parseMinerResponse(parsed, newCount, totalCount, normalizeCategory, existingGroupNames = []) {
  const categories = new Map();
  const tags = new Map();
  const proposed = new Map();
  const existing = new Map(existingGroupNames.map(name => [String(name).toLowerCase(), String(name)]));
  for (const entry of Array.isArray(parsed?.nodes) ? parsed.nodes : []) {
    const i = Number(entry?.i);
    if (!Number.isInteger(i) || i < 0 || i >= newCount) continue;
    const category = entry?.category ? normalizeCategory(entry.category, null) : null;
    if (category) categories.set(i, category);
    const nodeTags = parseMinerTags(entry?.tags);
    if (nodeTags.length) tags.set(i, nodeTags);
    const group = normalizeGroupName(entry?.group);
    if (group) proposed.set(i, existing.get(group.toLowerCase()) || group);
  }
  const uses = new Map();
  proposed.forEach(name => uses.set(name.toLowerCase(), (uses.get(name.toLowerCase()) || 0) + 1));
  const groups = new Map();
  proposed.forEach((name, i) => {
    if (existing.has(name.toLowerCase()) || uses.get(name.toLowerCase()) >= MIN_NODES_FOR_NEW_GROUP) groups.set(i, name);
  });

  const edges = [];
  const seen = new Set();
  const degree = new Map();
  for (const entry of Array.isArray(parsed?.edges) ? parsed.edges : []) {
    const a = Number(entry?.a);
    const b = Number(entry?.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    if (a < 0 || b < 0 || a >= totalCount || b >= totalCount) continue;
    if (a >= newCount && b >= newCount) continue;
    const key = Math.min(a, b) + ":" + Math.max(a, b);
    if (seen.has(key)) continue;
    const newEnds = [a, b].filter(i => i < newCount);
    if (newEnds.some(i => (degree.get(i) || 0) >= MAX_EDGES_PER_NEW_NODE)) continue;
    seen.add(key);
    newEnds.forEach(i => degree.set(i, (degree.get(i) || 0) + 1));
    const relation = String(entry?.relation || "").replace(/\s+/g, " ").trim().slice(0, MAX_RELATION_LENGTH);
    edges.push({ a, b, relation: relation || null });
  }
  return { categories, edges, tags, groups };
}
