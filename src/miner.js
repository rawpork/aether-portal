// Daily connection miner: one batched Gemini prompt categorizes unanalyzed nodes and links related ones.

// Unanalyzed nodes sent per run, plus recently analyzed nodes offered as edge targets.
export const MINER_BATCH_SIZE = 40;
export const MINER_CONTEXT_SIZE = 60;
const MAX_EDGES_PER_NEW_NODE = 3;
const MAX_ITEM_TEXT_LENGTH = 160;
// Opening words of a node's fetched page text or video synopsis, so items are judged by what they say, not just titles.
const MAX_SNIPPET_LENGTH = 200;
const MAX_RELATION_LENGTH = 60;

// Items are numbered in the prompt so Gemini never has to echo (or invent) node ids.
export function buildMinerPrompt(newNodes, contextNodes, categories) {
  const describe = (node, index) => {
    const title = String(node.title || "");
    const url = String(node.url || "");
    const text = title && title !== url ? title + " | " + url : url || title;
    const snippet = String(node.snippet || "").replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_LENGTH);
    return "[" + index + "] (" + (node.category || "note") + ") " + text.replace(/\s+/g, " ").slice(0, MAX_ITEM_TEXT_LENGTH) + (snippet ? " :: " + snippet : "");
  };
  const lines = [...newNodes, ...contextNodes].map(describe);
  const lastNew = newNodes.length - 1;

  return [
    "You organize a personal knowledge graph of saved links and notes.",
    `Items 0-${lastNew} are NEW. For every NEW item pick the best category from: ${categories.join(", ")}.`,
    "Then list edges between items that are genuinely related (same topic, project, tool, or one builds on the other).",
    `Every edge must involve at least one NEW item. At most ${MAX_EDGES_PER_NEW_NODE} edges per NEW item. Skip weak or generic similarities.`,
    'Return only valid JSON: {"nodes":[{"i":0,"category":"..."}],"edges":[{"a":0,"b":5,"relation":"short phrase"}]}',
    "Items:",
    ...lines
  ].join("\n");
}

// Validates Gemini's answer against the prompt's numbering. Returns { categories: Map<index, category>, edges }.
export function parseMinerResponse(parsed, newCount, totalCount, normalizeCategory) {
  const categories = new Map();
  for (const entry of Array.isArray(parsed?.nodes) ? parsed.nodes : []) {
    const i = Number(entry?.i);
    if (!Number.isInteger(i) || i < 0 || i >= newCount || !entry?.category) continue;
    const category = normalizeCategory(entry.category, null);
    if (category) categories.set(i, category);
  }

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
  return { categories, edges };
}
