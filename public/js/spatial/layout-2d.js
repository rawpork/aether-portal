// 2D board layout (SPATIAL_ARCHITECTURE.md, section 3.3): the flat mode lays the same cards out as a node-editor board,
// one column per group. Pure math with plain objects, so it runs in unit tests as-is. The board lies in the z = 0
// plane, centred on the origin, with +y up; world units are the card field's (CARD_WIDTH x CARD_HEIGHT).

// Board columns order their cards by status, in the same order as the Board view's columns, then newest first.
export const STATUS_ORDER = ['inbox', 'active', 'reference', 'done'];

const statusRank = status => {
  const index = STATUS_ORDER.indexOf(String(status || 'inbox'));
  return index === -1 ? STATUS_ORDER.length : index;
};

// items: [{ id, key, label, status, created }] where key is the card's cluster (its column). Returns
// { slots: Map(id -> { x, y, z }), columns: [{ key, label, count, subColumns, left, right, x, headerY, bottom }],
// width, height }. Columns go largest first (ties by label), and a column taller than maxRows continues in a
// sub-column beside it.
export function boardLayout(items, {
  cardWidth,
  cardHeight,
  gapX = cardWidth * 0.25,
  gapY = cardHeight * 0.2,
  groupGap = cardWidth * 0.6,
  headerHeight = cardHeight * 0.8,
  maxRows = 12
}) {
  const groups = new Map();
  items.forEach(item => {
    if (!groups.has(item.key)) groups.set(item.key, { key: item.key, label: item.label || item.key, items: [] });
    groups.get(item.key).items.push(item);
  });
  const ordered = [...groups.values()].sort((a, b) => b.items.length - a.items.length || String(a.label).localeCompare(String(b.label)));

  const slots = new Map();
  const columns = [];
  let cursor = 0;
  let tallest = 0;
  ordered.forEach(group => {
    group.items.sort((a, b) => statusRank(a.status) - statusRank(b.status) || String(b.created || '').localeCompare(String(a.created || '')));
    const rows = Math.min(maxRows, group.items.length);
    const subColumns = Math.max(1, Math.ceil(group.items.length / maxRows));
    const width = subColumns * cardWidth + (subColumns - 1) * gapX;
    group.items.forEach((item, index) => {
      const sub = Math.floor(index / maxRows);
      const row = index % maxRows;
      slots.set(String(item.id), {
        x: cursor + sub * (cardWidth + gapX) + cardWidth / 2,
        y: -(headerHeight + row * (cardHeight + gapY) + cardHeight / 2),
        z: 0
      });
    });
    const bottom = -(headerHeight + rows * (cardHeight + gapY) - gapY);
    tallest = Math.max(tallest, -bottom);
    columns.push({ key: group.key, label: group.label, count: group.items.length, subColumns, left: cursor, right: cursor + width, x: cursor + width / 2, headerY: -headerHeight / 2, bottom });
    cursor += width + groupGap;
  });

  // Centre the board on the origin.
  const width = Math.max(0, cursor - groupGap);
  const height = tallest;
  const dx = -width / 2;
  const dy = height / 2;
  slots.forEach(slot => {
    slot.x += dx;
    slot.y += dy;
  });
  columns.forEach(column => {
    column.left += dx;
    column.right += dx;
    column.x += dx;
    column.headerY += dy;
    column.bottom += dy;
  });
  return { slots, columns, width, height };
}

// The column a board x position belongs to: the one it falls in (gaps split halfway), else the nearest one.
export function columnAt(layout, x) {
  let best = null;
  let bestDistance = Infinity;
  for (const column of layout.columns) {
    const distance = x < column.left ? column.left - x : x > column.right ? x - column.right : 0;
    if (distance < bestDistance) {
      best = column;
      bestDistance = distance;
    }
  }
  return best;
}
