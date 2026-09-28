// 2D node map (the board's Map mode): the cards laid out like a node editor, flowing left to right along their links,
// so pipelines read as chains of wired cards. Pure math with plain objects, so it runs in unit tests as-is. The map
// lies in the z = 0 plane, centred on the origin, +y up; world units are the card field's.
//
// Each connected group of cards is layered by its links (a card sits one column right of the card that links to it),
// ordered within its columns to cross fewer wires, and the groups are stacked top to bottom, largest first. Cards
// with no links wait in a grid underneath.

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ids: card ids; links: [{ source, target, type? }] by id (links to cards not in ids are ignored). Returns
// { slots: Map(id -> { x, y, z }), wires: [{ source, target, type }], width, height }.
export function mapLayout(ids, links, {
  cardWidth,
  cardHeight,
  gapX = cardWidth * 0.9,
  gapY = cardHeight * 0.45,
  componentGap = cardHeight * 1.5,
  gridGap = cardWidth * 0.2,
  sweeps = 4
}) {
  const nodes = [...new Set(ids.map(String))];
  const known = new Set(nodes);
  const out = new Map(nodes.map(id => [id, new Set()]));
  const incoming = new Map(nodes.map(id => [id, new Set()]));
  const wires = [];
  const seen = new Set();
  links.forEach(link => {
    const source = String(link.source);
    const target = String(link.target);
    if (source === target || !known.has(source) || !known.has(target)) return;
    const pair = source < target ? source + '|' + target : target + '|' + source;
    if (seen.has(pair)) return;
    seen.add(pair);
    out.get(source).add(target);
    incoming.get(target).add(source);
    wires.push({ source, target, type: link.type || null });
  });
  const neighbours = id => [...out.get(id), ...incoming.get(id)];

  // Connected components (links taken both ways).
  const componentOf = new Map();
  const components = [];
  nodes.slice().sort(byId).forEach(start => {
    if (componentOf.has(start)) return;
    const members = [start];
    componentOf.set(start, components.length);
    for (let i = 0; i < members.length; i++) {
      neighbours(members[i]).forEach(next => {
        if (componentOf.has(next)) return;
        componentOf.set(next, components.length);
        members.push(next);
      });
    }
    components.push(members.sort(byId));
  });
  const connected = components.filter(members => members.length > 1).sort((a, b) => b.length - a.length || byId(a[0], b[0]));
  const loose = components.filter(members => members.length === 1).map(members => members[0]);

  const slots = new Map();
  const stepX = cardWidth + gapX;
  const stepY = cardHeight + gapY;
  let top = 0;
  let widest = 0;

  connected.forEach(members => {
    const inComponent = new Set(members);
    // Layers: shortest distance along links from the cards nothing links to (or, in a pure cycle, from the card with
    // the most outgoing links).
    let roots = members.filter(id => ![...incoming.get(id)].some(source => inComponent.has(source)));
    if (!roots.length) roots = [members.slice().sort((a, b) => out.get(b).size - out.get(a).size || byId(a, b))[0]];
    const layer = new Map(roots.map(id => [id, 0]));
    const queue = [...roots];
    for (let i = 0; i < queue.length; i++) {
      out.get(queue[i]).forEach(next => {
        if (layer.has(next)) return;
        layer.set(next, layer.get(queue[i]) + 1);
        queue.push(next);
      });
    }
    // Cards only reached against a link's direction sit one column left of what they link to.
    let pending = members.filter(id => !layer.has(id));
    while (pending.length) {
      const before = pending.length;
      pending = pending.filter(id => {
        const target = [...out.get(id)].find(next => layer.has(next));
        if (target !== undefined) {
          layer.set(id, layer.get(target) - 1);
          return false;
        }
        const source = [...incoming.get(id)].find(prev => layer.has(prev));
        if (source !== undefined) {
          layer.set(id, layer.get(source) + 1);
          return false;
        }
        return true;
      });
      if (pending.length === before) {
        pending.forEach(id => layer.set(id, 0));
        pending = [];
      }
    }
    const lowest = Math.min(...layer.values());
    const columns = [];
    members.forEach(id => {
      const index = layer.get(id) - lowest;
      (columns[index] = columns[index] || []).push(id);
    });
    for (let i = 0; i < columns.length; i++) columns[i] = columns[i] || [];

    // Fewer crossings: order each column by the average row of its neighbours in the column beside it, sweeping right
    // then left.
    const rowOf = new Map();
    const index = () => columns.forEach(column => column.forEach((id, row) => rowOf.set(id, row)));
    index();
    const reorder = (column, besideColumn) => {
      const beside = new Set(besideColumn);
      const weight = new Map(column.map(id => {
        const rows = neighbours(id).filter(next => beside.has(next)).map(next => rowOf.get(next));
        return [id, rows.length ? rows.reduce((sum, row) => sum + row, 0) / rows.length : rowOf.get(id)];
      }));
      column.sort((a, b) => weight.get(a) - weight.get(b) || byId(a, b));
    };
    for (let sweep = 0; sweep < sweeps; sweep++) {
      if (sweep % 2 === 0) for (let i = 1; i < columns.length; i++) reorder(columns[i], columns[i - 1]);
      else for (let i = columns.length - 2; i >= 0; i--) reorder(columns[i], columns[i + 1]);
      index();
    }

    const tallest = Math.max(...columns.map(column => column.length));
    columns.forEach((column, x) => {
      const offset = (tallest - column.length) / 2;
      column.forEach((id, row) => slots.set(id, { x: x * stepX + cardWidth / 2, y: top - (offset + row) * stepY - cardHeight / 2, z: 0 }));
    });
    widest = Math.max(widest, columns.length * stepX - gapX);
    top -= tallest * stepY - gapY + componentGap;
  });

  if (loose.length) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(loose.length * 1.6)));
    loose.forEach((id, i) => {
      const column = i % perRow;
      const row = Math.floor(i / perRow);
      slots.set(id, { x: column * (cardWidth + gridGap) + cardWidth / 2, y: top - row * stepY - cardHeight / 2, z: 0 });
    });
    widest = Math.max(widest, perRow * (cardWidth + gridGap) - gridGap);
    top -= Math.ceil(loose.length / perRow) * stepY - gapY;
  } else if (connected.length) {
    top += componentGap;
  }

  // Centre on the origin.
  const width = Math.max(0, widest);
  const height = Math.max(0, -top);
  slots.forEach(slot => {
    slot.x -= width / 2;
    slot.y += height / 2;
  });
  return { slots, wires, width, height };
}

// A node-editor wire: a cubic Bézier from the right edge of the source card to the left edge of the target, with
// its control points pulled out horizontally by half the gap (at least a card width, so short or backward wires
// still curve). Returns `segments + 1` points { x, y, z }.
export function wirePoints(from, to, { cardWidth, segments = 24 }) {
  const start = { x: from.x + cardWidth / 2, y: from.y, z: from.z || 0 };
  const end = { x: to.x - cardWidth / 2, y: to.y, z: to.z || 0 };
  const pull = Math.max(cardWidth, Math.abs(end.x - start.x) * 0.5);
  const c1 = { x: start.x + pull, y: start.y, z: start.z };
  const c2 = { x: end.x - pull, y: end.y, z: end.z };
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push({
      x: a * start.x + b * c1.x + c * c2.x + d * end.x,
      y: a * start.y + b * c1.y + c * c2.y + d * end.y,
      z: a * start.z + b * c1.z + c * c2.z + d * end.z
    });
  }
  return points;
}
