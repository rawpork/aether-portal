// Semantic zoom level of detail (SPATIAL_ARCHITECTURE.md 2.4): how far a cluster has collapsed into its group proxy,
// from how large it appears on screen rather than a fixed distance. Pure functions.

export const LOD_NEAR_RATIO = 3.5;
export const LOD_FAR_RATIO = 6.5;
// Small clusters still need room to read as a group, so the radius used is never below this.
export const LOD_MIN_RADIUS = 18;

// 0 = show the cards, 1 = show the proxy. ratio = distance to the cluster centre / cluster radius.
export function lodFactor(distance, radius) {
  const ratio = distance / Math.max(radius, LOD_MIN_RADIUS);
  const t = Math.min(1, Math.max(0, (ratio - LOD_NEAR_RATIO) / (LOD_FAR_RATIO - LOD_NEAR_RATIO)));
  return t * t * (3 - 2 * t);
}

// Modes by time scope: 'cards' (Today, This week, This month: small sets meant to be read, never collapsed),
// 'groups' (the Groups scope: always collapsed) and 'auto' (All time: collapsed by apparent size).
export const LOD_MODES = ['cards', 'auto', 'groups'];

// The goal for one cluster. A cluster the user is working in (the open gallery, or one holding the focused or hovered
// card) always shows its cards.
export function lodGoal({ distance, radius, mode = 'auto', active = false }) {
  if (active || mode === 'cards') return 0;
  if (mode === 'groups') return 1;
  return lodFactor(distance, radius);
}
