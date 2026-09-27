// Hybrid groups and tags (SPATIAL_ARCHITECTURE.md, section 1): validation, #hashtag parsing, concept links, and the
// D1 reads and writes behind /api/graph, /api/groups and the node PATCH. Tables come from migration 0013.

export const GROUP_NAME_MAX = 40;
export const GROUP_SOURCES = ["user", "ai"];
export const TAG_MIN = 2;
export const TAG_MAX = 40;
export const MAX_USER_TAGS_PER_TEXT = 20;
// Two nodes sharing a miner tag at least this strong get a concept link, at most this many per node.
export const CONCEPT_TAG_MIN_WEIGHT = 0.6;
export const MAX_CONCEPT_LINKS_PER_NODE = 3;

// Trimmed, single-spaced, control characters removed; null unless 1-40 characters remain.
export function normalizeGroupName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return name && name.length <= GROUP_NAME_MAX ? name : null;
}

// Lowercase, no leading '#', letters, digits and a few joiners only, single-spaced; null unless 2-40 characters.
export function normalizeTag(value) {
  const tag = String(value ?? "")
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N} _&+.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return tag.length >= TAG_MIN && tag.length <= TAG_MAX ? tag : null;
}

// #hashtags in free text, in order of first appearance. A tag starts after whitespace or the start of the text,
// so URL fragments (page#section) are ignored.
export function extractHashtags(text) {
  const tags = [];
  for (const match of String(text ?? "").matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    const tag = normalizeTag(match[1]);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length === MAX_USER_TAGS_PER_TEXT) break;
  }
  return tags;
}

// Links between nodes sharing a strong miner tag, skipping pairs that already have a link. tagsByNode maps a node id
// to [{ tag, source, weight }]. Pairs are ranked by the weaker of the two weights, so the clearest shared concepts win
// the per-node cap.
export function buildConceptLinks(nodeIds, tagsByNode, existingLinks = []) {
  const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const linked = new Set(existingLinks.map(link => pairKey(String(link.source), String(link.target))));
  const byTag = new Map();
  for (const id of nodeIds) {
    for (const entry of tagsByNode.get(id) || []) {
      if (entry.source !== "miner" || !(entry.weight >= CONCEPT_TAG_MIN_WEIGHT)) continue;
      if (!byTag.has(entry.tag)) byTag.set(entry.tag, []);
      byTag.get(entry.tag).push({ id, weight: entry.weight });
    }
  }
  const candidates = new Map();
  byTag.forEach((members, tag) => {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i].id, members[j].id);
        if (linked.has(key)) continue;
        const strength = Math.min(members[i].weight, members[j].weight);
        const current = candidates.get(key);
        if (!current || strength > current.strength) candidates.set(key, { a: members[i].id, b: members[j].id, tag, strength });
      }
    }
  });
  const degree = new Map();
  const links = [];
  [...candidates.values()]
    .sort((x, y) => y.strength - x.strength || x.tag.localeCompare(y.tag) || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)))
    .forEach(({ a, b, tag }) => {
      if ((degree.get(a) || 0) >= MAX_CONCEPT_LINKS_PER_NODE || (degree.get(b) || 0) >= MAX_CONCEPT_LINKS_PER_NODE) return;
      degree.set(a, (degree.get(a) || 0) + 1);
      degree.set(b, (degree.get(b) || 0) + 1);
      links.push({ source: a, target: b, value: 1, type: "concept", relation: tag });
    });
  return links;
}

export const newGroupId = () => "grp_" + crypto.randomUUID();

// ---- D1 access. Every query is scoped to the signed-in user. ----

// The user's groups with node counts, most used first, then by name.
export async function listGroups(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT g.id, g.name, g.source, COUNT(n.id) AS count FROM node_groups g LEFT JOIN saved_nodes n ON n.group_id = g.id AND n.user_id = g.user_id WHERE g.user_id = ? GROUP BY g.id ORDER BY count DESC, g.name COLLATE NOCASE"
  ).bind(userId).all();
  return (results || []).map(row => ({ id: row.id, name: row.name, source: row.source, count: Number(row.count) || 0 }));
}

// Returns the user's group with this name (any case), creating it with the given source if there is none.
export async function ensureGroup(env, userId, name, source = "user") {
  const find = () => env.DB.prepare(
    "SELECT id, name, source FROM node_groups WHERE user_id = ? AND name = ? COLLATE NOCASE"
  ).bind(userId, name).first();
  const existing = await find();
  if (existing) return existing;
  // OR IGNORE: a concurrent request may create the same name first; the unique index keeps one.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO node_groups (id, user_id, name, source) VALUES (?, ?, ?, ?)"
  ).bind(newGroupId(), userId, name, source).run();
  return find();
}

// Tags for every node of the user, as a Map of node id to [{ tag, source, weight }], strongest first.
export async function loadNodeTags(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT node_id, tag, source, weight FROM node_tags WHERE user_id = ? ORDER BY weight DESC, tag"
  ).bind(userId).all();
  const byNode = new Map();
  for (const row of results || []) {
    if (!byNode.has(row.node_id)) byNode.set(row.node_id, []);
    byNode.get(row.node_id).push({ tag: row.tag, source: row.source, weight: Number(row.weight) || 0 });
  }
  return byNode;
}

// Adds the #hashtags in text as user tags on a node. A miner tag with the same name is promoted to a user tag.
// Best-effort: a failure is logged and never blocks saving the node itself.
export async function saveUserTags(env, userId, nodeId, text) {
  const tags = extractHashtags(text);
  if (!tags.length) return [];
  try {
    await env.DB.batch(tags.map(tag => env.DB.prepare(
      "INSERT INTO node_tags (node_id, tag, user_id, source, weight) VALUES (?, ?, ?, 'user', 1) ON CONFLICT (node_id, tag) DO UPDATE SET source = 'user', weight = 1"
    ).bind(nodeId, tag, userId)));
  } catch (err) {
    console.error("Saving #hashtags failed:", err);
  }
  return tags;
}
