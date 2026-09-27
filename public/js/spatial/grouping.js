// Grouping engine (SPATIAL_ARCHITECTURE.md, sections 1.7-1.8): turns the visible nodes into ordered groups for
// layout, labels and the camera. Pure functions only: no DOM and no three.js, so this runs in unit tests as-is.

// 'group' is the hybrid default: the node's AI or user group, and its category while it has none.
export const GROUP_KEYS = ['group', 'category', 'platform', 'tag'];

const PLATFORM_LABELS = { youtube: 'YouTube', x: 'X/Twitter', facebook: 'Facebook', links: 'Links', notes: 'Notes', images: 'Images' };

// Colours for groups and tags, chosen to read on the navy portal and stay clear of the teal selection accent.
export const GROUP_PALETTE = ['#7c9cff', '#ff9f6b', '#c38bff', '#5fd38d', '#ffd166', '#ff7aa8', '#6fc3e8', '#b8c46a', '#f28f7c', '#a5b1ff'];

// Same rule as the portal's getNodeCategory().
export function getNodeCategory(node) {
  return String(node.category || node.type || 'note').toLowerCase();
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www[.]/, '');
  } catch {
    return '';
  }
}

// Same rule as the portal's getPlatform(), which drives the origin bar: a photo, a note (no link), a known social
// site, or any other link.
export function getNodePlatform(node) {
  if (getNodeCategory(node) === 'image') return 'images';
  const url = String(node.url || '');
  if (!/^https?:/i.test(url)) return 'notes';
  const host = getHostname(url).toLowerCase();
  const onDomain = domains => domains.some(domain => host === domain || host.endsWith('.' + domain));
  if (onDomain(['youtube.com', 'youtu.be'])) return 'youtube';
  if (onDomain(['x.com', 'twitter.com'])) return 'x';
  if (onDomain(['facebook.com', 'fb.watch', 'fb.com'])) return 'facebook';
  return 'links';
}

// A stable palette colour for any group id, so a group keeps its colour across reloads and filters.
export function groupColor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return GROUP_PALETTE[hash % GROUP_PALETTE.length];
}

// The node's strongest tag (user tags count as weight 1), ties broken alphabetically; null when it has none.
function topTag(node) {
  const tags = Array.isArray(node.tags) ? node.tags : [];
  let best = null;
  for (const entry of tags) {
    const weight = entry.source === 'user' ? 1 : Number(entry.weight) || 0;
    if (!best || weight > best.weight || (weight === best.weight && entry.tag < best.tag)) best = { tag: entry.tag, weight };
  }
  return best ? best.tag : null;
}

const categoryPlacement = node => ({ id: 'category:' + getNodeCategory(node), key: 'category', value: getNodeCategory(node) });

// Where a node goes under each key: an id, the key it came from, and the raw value. Nodes without a group or tag
// fall back to their category, with the same ids the category key uses, so their islands do not move between keys.
const PLACEMENT = {
  category: categoryPlacement,
  platform: node => ({ id: 'platform:' + getNodePlatform(node), key: 'platform', value: getNodePlatform(node) }),
  group: (node, groups) => (node.group_id && groups.has(node.group_id)
    ? { id: 'group:' + node.group_id, key: 'group', value: node.group_id }
    : categoryPlacement(node)),
  tag: node => {
    const tag = topTag(node);
    return tag ? { id: 'tag:' + tag, key: 'tag', value: tag } : categoryPlacement(node);
  }
};

function describe(placement, groups) {
  if (placement.key === 'group') {
    const group = groups.get(placement.value);
    return { label: group.name, source: group.source || 'user', color: groupColor(placement.id) };
  }
  if (placement.key === 'tag') return { label: '#' + placement.value, source: null, color: groupColor(placement.id) };
  if (placement.key === 'platform') return { label: PLATFORM_LABELS[placement.value] || placement.value, source: null, color: null };
  return { label: placement.value.replace(/_/g, ' '), source: null, color: null };
}

// Returns { groups: Map<groupId, group>, order: groupId[], groupOf: Map<nodeId, groupId> }. groups (for the 'group'
// key) maps a group id to { name, source }. A group's color is null for category and platform groups, which use the
// portal's own palettes. Order is largest first, then label, so layout slots do not shuffle when counts tie.
export function buildHierarchy(nodes, { key = 'group', groups = new Map() } = {}) {
  const place = PLACEMENT[key];
  if (!place) throw new Error('Unknown group key: ' + key);
  const result = new Map();
  const groupOf = new Map();
  for (const node of nodes) {
    const placement = place(node, groups);
    let group = result.get(placement.id);
    if (!group) {
      group = { id: placement.id, key: placement.key, value: placement.value, ...describe(placement, groups), nodeIds: [], count: 0 };
      result.set(placement.id, group);
    }
    group.nodeIds.push(node.id);
    group.count++;
    groupOf.set(node.id, placement.id);
  }
  const order = [...result.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map(group => group.id);
  return { groups: result, order, groupOf };
}
