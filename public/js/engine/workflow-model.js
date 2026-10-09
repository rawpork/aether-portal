// Studio workflow model: port rules, auto-layout and cable geometry for the Workflow console
// (public/js/engine/workflow-console.js, specs/ui/01-node-canvas.md). The port rules mirror Aether_Engine
// src/workflows.ts, which re-checks every saved graph, so the editor can refuse a bad drop with the same reason
// the engine would give.

export const PORTS = {
  trigger: { in: [], out: ['start'] },
  agent: { in: ['start', 'context', 'a2a'], out: ['mcp', 'a2a', 'act'] },
  mcp: { in: ['read', 'act'], out: [] },
  action: { in: ['act'], out: [] },
  human: { in: ['act'], out: ['start'] },
};

export const PORT_TEXT = { start: 'Start', context: 'Context', a2a: 'A2A', mcp: 'MCP', act: 'Act', read: 'Read' };
export const KIND_TEXT = { trigger: 'Trigger', agent: 'Agent', mcp: 'MCP server', action: 'Action', human: 'Approval' };
export const CABLE_TEXT = { start: 'Start', mcp_read: 'MCP Read', a2a: 'A2A', action: 'Action' };

// Card geometry (CSS px at 100%). Ports sit on the card edges: inputs left, outputs right.
export const NODE_W = 208;
export const NODE_H = 110;
export const GRID = 8;
const PORT_TOP = 40;
const PORT_STEP = 28;
const COL = 272;
const ROW = 136;
const PAD = 32;

export const snap = (value) => Math.round(value / GRID) * GRID;

// Same rules and messages as the engine's cableKindFor().
export function cableKindFor(from, fromPort, to, toPort) {
  if (!from || !to) return { error: 'Pick two nodes.' };
  if (from.id === to.id) return { error: 'A node cannot connect to itself.' };
  if (!PORTS[from.kind].out.includes(fromPort)) return { error: from.label + ' has no "' + fromPort + '" output.' };
  if (!PORTS[to.kind].in.includes(toPort)) return { error: to.label + ' has no "' + toPort + '" input.' };
  if (fromPort === 'start' && toPort === 'start' && to.kind === 'agent') return { kind: 'start' };
  if (fromPort === 'mcp' && toPort === 'read' && to.kind === 'mcp') return { kind: 'mcp_read' };
  if (fromPort === 'a2a' && toPort === 'a2a' && from.kind === 'agent' && to.kind === 'agent') return { kind: 'a2a' };
  if (fromPort === 'act' && toPort === 'act') return { kind: 'action' };
  if (to.kind === 'mcp') return { error: "An MCP server is read from an agent's MCP port, or acted on from its Act port." };
  if (from.kind === 'mcp') return { error: "An MCP server can't start anything. Connect it from an agent's MCP port." };
  return { error: "Those ports don't fit: " + fromPort + ' → ' + toPort + '.' };
}

// Graph-level rules on top of the port pair: no duplicate cable, at most one A2A cable per agent pair.
export function checkConnect(workflow, fromId, fromPort, toId, toPort) {
  const from = workflow.nodes.find((n) => n.id === fromId);
  const to = workflow.nodes.find((n) => n.id === toId);
  const result = cableKindFor(from, fromPort, to, toPort);
  if (result.error) return result;
  const cables = workflow.cables;
  if (cables.some((c) => c.from === fromId && c.from_port === fromPort && c.to === toId && c.to_port === toPort)) return { error: 'Those ports are already connected.' };
  if (result.kind === 'a2a' && cables.some((c) => c.kind === 'a2a' && ((c.from === fromId && c.to === toId) || (c.from === toId && c.to === fromId)))) {
    return { error: from.label + ' and ' + to.label + ' already have an A2A cable.' };
  }
  return result;
}

// Every input port a given output could connect to, for highlighting during a drag and the "Connect to…" menu.
export function compatibleTargets(workflow, fromId, fromPort) {
  const out = [];
  for (const node of workflow.nodes) {
    for (const port of PORTS[node.kind].in) {
      const result = checkConnect(workflow, fromId, fromPort, node.id, port);
      if (result.kind) out.push({ node, port, kind: result.kind });
    }
  }
  return out;
}

export function portOffset(kind, dir, port) {
  const list = PORTS[kind][dir];
  const i = list.indexOf(port);
  if (i < 0) return null;
  const y = list.length === 1 ? PORT_TOP + PORT_STEP : PORT_TOP + i * PORT_STEP;
  return { x: dir === 'in' ? 0 : NODE_W, y };
}

export function portPoint(node, dir, port) {
  const offset = portOffset(node.kind, dir, port);
  return offset ? { x: node.x + offset.x, y: node.y + offset.y } : null;
}

// Cubic Bézier with horizontal tangents (spec: dx = max(60, |x2 − x1| / 2)).
export function cableControls(a, b) {
  const dx = Math.max(60, Math.abs(b.x - a.x) / 2);
  return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
}

export function cablePath(a, b) {
  const [p0, p1, p2, p3] = cableControls(a, b);
  return 'M' + p0.x + ' ' + p0.y + ' C' + p1.x + ' ' + p1.y + ' ' + p2.x + ' ' + p2.y + ' ' + p3.x + ' ' + p3.y;
}

// Point at t (0-1) along the cable, for pulses and badges (no DOM path measuring needed).
export function cablePoint(a, b, t) {
  const [p0, p1, p2, p3] = cableControls(a, b);
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
}

// Spec easing cubic-bezier(0.25, 1, 0.5, 1), solved for y at time x.
export function ease(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * 0.25 + 3 * (1 - t) * t * t * 0.5 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * 1 + 3 * (1 - t) * t * t * 1 + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

// Depth of trigger / agent / approval nodes: longest path along start, A2A and approval cables (cycle-safe).
function flowDepths(nodes, cables) {
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const flow = cables.filter((c) => c.kind === 'start' || c.kind === 'a2a' || (c.kind === 'action' && kindOf.get(c.to) === 'human'));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const c of flow) {
      const next = (depth.get(c.from) ?? 0) + 1;
      if (next > (depth.get(c.to) ?? 0) && next <= nodes.length) {
        depth.set(c.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

const overlaps = (a, b) => Math.abs(a.x - b.x) < NODE_W + 16 && Math.abs(a.y - b.y) < NODE_H + 16;

// Positions for every node. Flow nodes go in columns by depth, actions one column after the agent that acts on
// them, MCP servers in a row underneath near the agents that read them. Nodes the operator placed keep their
// position unless `force` (Auto-arrange); new nodes are nudged down until they don't overlap a placed one.
export function autoLayout(workflow, { force = false } = {}) {
  const { nodes, cables } = workflow;
  const depth = flowDepths(nodes, cables);
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  for (const n of nodes) {
    if (n.kind === 'action') {
      const sources = cables.filter((c) => c.to === n.id && kindOf.get(c.from) === 'agent').map((c) => depth.get(c.from) ?? 0);
      depth.set(n.id, (sources.length ? Math.max(...sources) : 0) + 1);
    }
  }
  const columns = new Map();
  for (const n of nodes) {
    if (n.kind === 'mcp') continue;
    const d = depth.get(n.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }
  const ideal = new Map();
  let bottom = PAD;
  for (const [d, list] of columns) {
    // Agents and approvals first, actions under them.
    list.sort((a, b) => (a.kind === 'action') - (b.kind === 'action'));
    list.forEach((n, i) => {
      const p = { x: PAD + d * COL, y: PAD + i * ROW };
      ideal.set(n.id, p);
      bottom = Math.max(bottom, p.y + NODE_H);
    });
  }
  const servers = nodes
    .filter((n) => n.kind === 'mcp')
    .map((n) => {
      const xs = cables.filter((c) => c.to === n.id).map((c) => ideal.get(c.from)?.x).filter((x) => x !== undefined);
      return { n, x: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : PAD };
    })
    .sort((a, b) => a.x - b.x || a.n.label.localeCompare(b.n.label));
  let nextX = PAD;
  const mcpY = bottom + 56;
  for (const { n, x } of servers) {
    const px = Math.max(snap(x), nextX);
    ideal.set(n.id, { x: px, y: mcpY });
    nextX = px + NODE_W + 24;
  }

  const placed = force ? [] : nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y)).map((n) => ({ x: n.x, y: n.y }));
  return nodes.map((n) => {
    if (!force && Number.isFinite(n.x) && Number.isFinite(n.y)) return { ...n };
    const p = { ...ideal.get(n.id) };
    for (let i = 0; i < 40 && placed.some((q) => overlaps(p, q)); i++) p.y += GRID * 4;
    placed.push(p);
    return { ...n, x: snap(p.x), y: snap(p.y) };
  });
}

// Size of the stage that holds every node, with room to drag beyond the last one.
export function stageSize(nodes) {
  let w = 960;
  let h = 440;
  for (const n of nodes) {
    w = Math.max(w, n.x + NODE_W + PAD * 4);
    h = Math.max(h, n.y + NODE_H + PAD * 3);
  }
  return { width: w, height: h };
}

export function cableLabel(cable, nodes) {
  const name = (id) => (nodes.find((n) => n.id === id) || {}).label || id;
  return (CABLE_TEXT[cable.kind] || 'Cable') + ' cable from ' + name(cable.from) + ' to ' + name(cable.to);
}

// What the engine accepts on save: no client-only fields, positions rounded.
export function graphForSave(nodes, cables) {
  const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== '').map((k) => [k, obj[k]]));
  return {
    nodes: nodes.map((n) => ({ ...pick(n, ['id', 'kind', 'label', 'role', 'instructions', 'server', 'origin', 'connector', 'action']), ...(n.params && Object.keys(n.params).length ? { params: Object.fromEntries(Object.entries(n.params).filter(([, v]) => typeof v === 'string' && v !== '')) } : {}), x: Math.round(n.x), y: Math.round(n.y) })),
    cables: cables.map((c) => pick(c, ['id', 'from', 'from_port', 'to', 'to_port', 'kind', 'origin'])),
  };
}

let counter = 0;
export const localId = (prefix) => prefix + '_' + Date.now().toString(16).slice(-6) + (counter++).toString(16).padStart(2, '0');
