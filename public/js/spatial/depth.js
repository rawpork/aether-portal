// Connection Depth (PROJECT_STATE.md, next step 2): how far the engine reaches when it relates saves, on three cumulative
// levels. The same rules decide which wires the portal draws and which links Outcome synthesis may follow, so this module
// is pure and shared by the page and the worker (src/synthesis.js imports it).
//
//   obvious   surface-level and keyword connections, only between cards in the same group;
//   logical   plus semantic relations, and direct links across groups (AI links, shared tags, strong keyword overlap);
//   abstract  plus cross-disciplinary leaps between different groups, at most ABSTRACT_LINKS_PER_NODE per card.
//
// A card's group is its primary group (its group_id, or its category while it has none) and never changes with the
// level: the level only decides which links may cross groups.

export const DEPTHS = ['obvious', 'logical', 'abstract'];
export const DEFAULT_DEPTH = 'logical';
// Abstract leaps shown per card, most confident first, so the space does not turn into spaghetti.
export const ABSTRACT_LINKS_PER_NODE = 3;
// A keyword link (shared title and URL words) crosses groups at the Logical level only with at least this many.
export const STRONG_KEYWORD_LINK = 2;

export const normalizeDepth = value => (DEPTHS.includes(value) ? value : DEFAULT_DEPTH);
export const depthRank = value => DEPTHS.indexOf(normalizeDepth(value));

// The card's primary group key: 'group:<id>' or 'category:<name>'.
export const primaryGroup = node => {
  if (node && node.group_id) return 'group:' + node.group_id;
  return 'category:' + String((node && (node.category || node.type)) || 'note').toLowerCase();
};

const endId = end => String(end && typeof end === 'object' ? end.id : end);
const isManual = link => link.type === 'ai' && link.relation === 'manual';

// The level a link belongs to: mined AI links carry their own label; keyword, shared-tag and category links are obvious.
export function linkDepth(link) {
  if (link.type === 'ai' && !isManual(link)) return normalizeDepth(link.depth);
  return 'obvious';
}

// Whether a link may be shown at `level`, given whether it joins two different groups (the abstract cap comes after).
export function linkAllowed(link, level, crossesGroups) {
  // Outcome provenance and links the user made are always shown.
  if (link.type === 'synthesis' || isManual(link)) return true;
  const rank = depthRank(level);
  if (depthRank(linkDepth(link)) > rank) return false;
  if (!crossesGroups) return true;
  if (rank === 0) return false;
  if (rank === 2) return true;
  if (link.type === 'ai' || link.type === 'concept') return true;
  if (link.type === 'semantic') return Number(link.value) >= STRONG_KEYWORD_LINK;
  return false;
}

// The links shown at `level`. groupOf(id) returns a card's primary group key. Abstract leaps are capped at
// ABSTRACT_LINKS_PER_NODE per card, keeping the most confident; every other allowed link is kept in order.
export function visibleLinks(links, level, groupOf) {
  const kept = [];
  const leaps = [];
  for (const link of links) {
    const a = endId(link.source);
    const b = endId(link.target);
    if (!linkAllowed(link, level, groupOf(a) !== groupOf(b))) continue;
    if (linkDepth(link) === 'abstract') leaps.push(link);
    else kept.push(link);
  }
  const pair = link => [endId(link.source), endId(link.target)].sort().join('|');
  leaps.sort((x, y) => (Number(y.confidence) || 0) - (Number(x.confidence) || 0) || (pair(x) < pair(y) ? -1 : 1));
  const degree = new Map();
  for (const link of leaps) {
    const a = endId(link.source);
    const b = endId(link.target);
    if ((degree.get(a) || 0) >= ABSTRACT_LINKS_PER_NODE || (degree.get(b) || 0) >= ABSTRACT_LINKS_PER_NODE) continue;
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
    kept.push(link);
  }
  return kept;
}
