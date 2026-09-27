// Grouping engine (SPATIAL_ARCHITECTURE.md, section 1.8): turns the visible nodes into ordered groups for layout,
// proxies and the camera. Pure functions only: no DOM and no three.js, so this runs in unit tests as-is.

export const GROUP_KEYS = ['category', 'platform'];

const PLATFORM_LABELS = { youtube: 'YouTube', x: 'X/Twitter', facebook: 'Facebook', links: 'Links', notes: 'Notes', images: 'Images' };

// Same rule as the portal's getNodeCategory().
export function getNodeCategory(node) {
  return String(node.category || node.type || node.group || 'note').toLowerCase();
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

const KEYS = {
  category: { valueOf: getNodeCategory, labelOf: value => value.replace(/_/g, ' ') },
  platform: { valueOf: getNodePlatform, labelOf: value => PLATFORM_LABELS[value] || value }
};

// Returns { groups: Map<groupId, group>, order: groupId[], groupOf: Map<nodeId, groupId> }.
// Group ids are key + ':' + value, so they stay stable across refiltering. Order is largest group first, then
// label, so layout slots do not shuffle when counts tie.
export function buildHierarchy(nodes, { key = 'category' } = {}) {
  const spec = KEYS[key];
  if (!spec) throw new Error('Unknown group key: ' + key);
  const groups = new Map();
  const groupOf = new Map();
  for (const node of nodes) {
    const value = spec.valueOf(node);
    const id = key + ':' + value;
    let group = groups.get(id);
    if (!group) {
      group = { id, key, value, label: spec.labelOf(value), nodeIds: [], count: 0 };
      groups.set(id, group);
    }
    group.nodeIds.push(node.id);
    group.count++;
    groupOf.set(node.id, id);
  }
  const order = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map(group => group.id);
  return { groups, order, groupOf };
}
