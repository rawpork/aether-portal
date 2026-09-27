// Hub weighting (SPATIAL_ARCHITECTURE.md 2.9, D9): how connected each visible card is, relative to what is on
// screen, and the hero scale that follows from it. Pure functions; links may hold node ids or node objects.

// Link types and how much each says about a connection. Category chain links join every node to a neighbour of the
// same category, so they carry no signal.
export const LINK_WEIGHTS = { ai: 1, concept: 0.6, semantic: 0.5, category: 0 };
export const HUB_MAX_SCALE = 1.35;
// Weight at which a hub starts to glow (DESIGN.md glow exception).
export const GLOW_THRESHOLD = 0.35;
// Outcome Nodes (SPATIAL_ARCHITECTURE.md section 8) glow gold and always count as the top hub.
export const OUTCOME_GOLD = '#ffb627';
export const OUTCOME_CATEGORY = 'outcome';

// Hub glow opacity for a weight: nothing below the threshold, then 0.12 rising to 0.45 at the top hub.
export function glowOpacity(weight) {
  if (!(weight > GLOW_THRESHOLD)) return 0;
  const t = Math.min(1, (weight - GLOW_THRESHOLD) / (1 - GLOW_THRESHOLD));
  return 0.12 + 0.33 * t;
}
const SCALE_FROM = 0.15;

const endId = end => (end && typeof end === 'object' ? end.id : end);

// Map of node id to weight in 0..1: log(1 + degree) / log(1 + max degree), degree summed over visible links.
export function computeHubWeights(nodes, links) {
  const visible = new Set(nodes.map(node => node.id));
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const link of links) {
    const a = endId(link.source);
    const b = endId(link.target);
    if (a === b || !visible.has(a) || !visible.has(b)) continue;
    const value = LINK_WEIGHTS[link.type] ?? 0;
    if (!value) continue;
    degree.set(a, degree.get(a) + value);
    degree.set(b, degree.get(b) + value);
  }
  const max = Math.max(0, ...degree.values());
  const weights = new Map();
  degree.forEach((value, id) => weights.set(id, max > 0 ? Math.log1p(value) / Math.log1p(max) : 0));
  return weights;
}

// 1.0 for ordinary cards, easing up to HUB_MAX_SCALE for the most connected one.
export function hubScale(weight) {
  const t = Math.min(1, Math.max(0, (weight - SCALE_FROM) / (1 - SCALE_FROM)));
  return 1 + (HUB_MAX_SCALE - 1) * t * t * (3 - 2 * t);
}
