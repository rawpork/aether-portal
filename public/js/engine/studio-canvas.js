// Mission Control → Studio: the 2D canvas of what the engine is doing. Reads GET /api/canvas/graph (Aether_Engine
// src/canvasGraph.ts) and draws three columns: task runs, their steps (task trees), and the MCP servers from the
// engine's mcp-config.json. Bridge edges join a step to the servers it relates to; the engine scores each one
// (0–1 confidence) from the step's text and Elarion's reply. The Abstract ↔ Logic slider sets the minimum confidence
// a bridge needs to stay visible (0% shows every faint association, 100% only near-certain ones), and clicking a
// task or step node opens the Node Inspector (the step's instructions, full reply, model, tokens, timing and the
// exact error when it failed; for a task, its outcome and every step), and clicking a
// bridge opens the Edge Inspector with the engine's rationale, Elarion's reply excerpt, the scoring signals and the
// bridge metadata. Read-only; shown as Studio's Engine activity tab. The editable Workflow console is workflow-console.js.
import { getEngineApi } from '../engine-api.bundle.js';
import { describeAuthError, describeUnreachableEngine } from './connection.js';

export const POLL_MS = 10000;
export const DEFAULT_THRESHOLD = 30;
export const THRESHOLD_STORAGE_KEY = 'aether.studio.threshold';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Column geometry (SVG user units = CSS px at 100%).
export const LAYOUT = { pad: 24, colTask: 24, colStep: 300, colMcp: 620, width: 220, taskH: 56, stepH: 40, mcpH: 56, stepGap: 12, taskGap: 28, mcpGap: 20 };

const DEPTH_TEXT = { logic: 'Logic', associative: 'Associative', abstract: 'Abstract' };
const SIGNAL_TEXT = { name: 'Names the server', category: 'Category terms', description: 'Description terms', keys_missing: 'Keys missing' };
const STATUS_KIND = { COMPLETED: 'running', RUNNING: 'running', PENDING: 'queued', FAILED: 'off', HALTED: 'off', ready: 'running', missing_keys: 'alert' };
const STATUS_TEXT = { COMPLETED: 'Done', RUNNING: 'Running', PENDING: 'Pending', QUEUED: 'Not run yet', FAILED: 'Failed', HALTED: 'Halted', ready: 'Ready', missing_keys: 'Keys missing' };

export const clampThreshold = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_THRESHOLD;
};

// A bridge stays visible when its confidence (as a whole percent) reaches the slider value.
export const bridgeVisible = (edge, threshold) => Math.round(edge.confidence * 100) >= clampThreshold(threshold);

export function filterBridges(edges, threshold) {
  const bridges = edges.filter((e) => e.kind === 'bridge');
  return { bridges, visible: bridges.filter((e) => bridgeVisible(e, threshold)) };
}

// Positions for every node: tasks stacked down the left with their steps beside them, servers down the right.
export function layoutGraph(graph) {
  const L = LAYOUT;
  const pos = new Map();
  const tasks = graph.nodes.filter((n) => n.kind === 'task');
  const stepsOf = (taskId) => graph.nodes.filter((n) => n.kind === 'step' && n.task === taskId).sort((a, b) => a.index - b.index);
  let y = L.pad;
  for (const task of tasks) {
    const steps = stepsOf(task.id);
    const block = Math.max(L.taskH, steps.length * (L.stepH + L.stepGap) - L.stepGap);
    pos.set(task.id, { x: L.colTask, y: y + (block - L.taskH) / 2, w: L.width, h: L.taskH });
    steps.forEach((step, i) => pos.set(step.id, { x: L.colStep, y: y + i * (L.stepH + L.stepGap), w: L.width, h: L.stepH }));
    y += block + L.taskGap;
  }
  const servers = graph.nodes.filter((n) => n.kind === 'mcp');
  let my = L.pad;
  for (const server of servers) {
    pos.set(server.id, { x: L.colMcp, y: my, w: L.width, h: L.mcpH });
    my += L.mcpH + L.mcpGap;
  }
  const height = Math.max(y - L.taskGap, my - L.mcpGap, 160) + L.pad;
  return { pos, width: L.colMcp + L.width + L.pad, height };
}

// Cubic Bézier with horizontal tangents from the right edge of `a` to the left edge of `b`.
export function bezierPath(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(60, Math.abs(x2 - x1) / 2);
  return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
}

export const percent = (confidence) => Math.round(confidence * 100) + '%';

export function edgeLabel(edge, nodes) {
  const from = nodes.find((n) => n.id === edge.from);
  const to = nodes.find((n) => n.id === edge.to);
  return 'Bridge from step ' + (from ? from.label : edge.from) + ' to ' + (to ? to.label : edge.to) + ', confidence ' + percent(edge.confidence);
}

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function svg(doc, tag, attrs = {}, children = []) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  for (const child of children) if (child) node.append(child);
  return node;
}

const truncate = (text, max) => (String(text).length > max ? String(text).slice(0, max - 1) + '…' : String(text));

function readThreshold(win) {
  try {
    const saved = win.localStorage.getItem(THRESHOLD_STORAGE_KEY);
    return saved === null ? DEFAULT_THRESHOLD : clampThreshold(saved);
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

function saveThreshold(win, value) {
  try {
    win.localStorage.setItem(THRESHOLD_STORAGE_KEY, String(value));
  } catch {
    /* storage blocked: the slider still works for this visit */
  }
}

export function mountStudioCanvas(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const onConnect = options.onConnect || (() => {});

  let graph = null;
  let error = null;
  let loading = false;
  let active = false;
  let timer = null;
  let destroyed = false;
  let selectedId = null;
  // The task or step node whose details the inspector shows (cleared when a bridge is selected).
  let selectedNode = null;
  // Full task records for the Node Inspector, by run id + status + completed steps (refetched as a run moves on).
  const records = new Map();
  let threshold = options.threshold !== undefined ? clampThreshold(options.threshold) : readThreshold(win);

  // Static frame: toolbar (slider, counts, refresh), canvas viewport, inspector.
  const slider = el(doc, 'input', { type: 'range', min: '0', max: '100', step: '5', id: 'studio-threshold', class: 'studio-slider', 'aria-describedby': 'studio-threshold-note' });
  slider.value = String(threshold);
  const note = el(doc, 'span', { id: 'studio-threshold-note', class: 'mini-label', 'aria-live': 'polite' });
  const refreshBtn = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: 'Refresh' });
  const status = el(doc, 'p', { class: 'studio-status mini-label', role: 'status' });
  const viewport = el(doc, 'div', { class: 'studio-viewport', tabindex: '-1' });
  const inspector = el(doc, 'aside', { class: 'studio-inspector surface', 'aria-label': 'Edge Inspector', hidden: true });
  container.replaceChildren(
    el(doc, 'div', { class: 'studio-toolbar' }, [
      el(doc, 'label', { class: 'studio-slider-wrap', for: 'studio-threshold' }, [
        el(doc, 'span', { class: 'studio-end', text: 'Abstract' }),
        slider,
        el(doc, 'span', { class: 'studio-end', text: 'Logic' }),
      ]),
      note,
      el(doc, 'span', { class: 'studio-spacer' }),
      el(doc, 'span', { class: 'studio-legend mini-label' }, [
        el(doc, 'span', { class: 'legend-line legend-solid', 'aria-hidden': 'true' }), ' Logic ',
        el(doc, 'span', { class: 'legend-line legend-dashed', 'aria-hidden': 'true' }), ' Abstract',
      ]),
      refreshBtn,
    ]),
    status,
    el(doc, 'div', { class: 'studio-body' }, [viewport, inspector]),
  );

  function renderNote() {
    const { bridges, visible } = graph ? filterBridges(graph.edges, threshold) : { bridges: [], visible: [] };
    note.textContent = 'Min confidence ' + threshold + '% · ' + visible.length + ' of ' + bridges.length + ' bridge' + (bridges.length === 1 ? '' : 's');
    slider.setAttribute('aria-valuetext', threshold + '% minimum confidence');
  }

  // Shows or hides bridges in place, so moving the slider never rebuilds the canvas.
  function applyThreshold() {
    for (const group of viewport.querySelectorAll('.bridge')) {
      const edge = graph && graph.edges.find((e) => e.id === group.getAttribute('data-edge'));
      const show = edge ? bridgeVisible(edge, threshold) : false;
      group.setAttribute('data-hidden', String(!show));
      const hit = group.querySelector('.bridge-hit');
      if (hit) hit.setAttribute('tabindex', show ? '0' : '-1');
    }
    renderNote();
    renderInspector();
  }

  function renderCanvas() {
    if (!graph) {
      viewport.replaceChildren();
      return;
    }
    const { pos, width, height } = layoutGraph(graph);
    const root = svg(doc, 'svg', { class: 'studio-svg', width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'group', 'aria-label': 'Task trees, MCP servers and bridges' });
    const edgeLayer = svg(doc, 'g', { class: 'edge-layer' });
    const nodeLayer = svg(doc, 'g', { class: 'node-layer' });
    root.append(edgeLayer, nodeLayer);

    for (const edge of graph.edges) {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b) continue;
      if (edge.kind === 'tree') {
        edgeLayer.append(svg(doc, 'path', { class: 'tree-edge', d: bezierPath(a, b), 'data-edge': edge.id }));
        continue;
      }
      const group = svg(doc, 'g', { class: 'bridge', 'data-edge': edge.id, 'data-depth': edge.depth, 'data-selected': String(edge.id === selectedId) });
      const d = bezierPath(a, b);
      group.append(
        svg(doc, 'path', { class: 'bridge-line', d, 'stroke-width': (1 + 3 * edge.confidence).toFixed(2), 'stroke-opacity': (0.35 + 0.65 * edge.confidence).toFixed(2) }),
        svg(doc, 'path', { class: 'bridge-hit', d, tabindex: '0', role: 'button', 'aria-label': edgeLabel(edge, graph.nodes) }),
      );
      edgeLayer.append(group);
    }

    for (const node of graph.nodes) {
      const p = pos.get(node.id);
      if (!p) continue;
      const statusKey = node.kind === 'mcp' ? node.status : node.status;
      const sub =
        node.kind === 'task'
          ? node.agent_id + ' · ' + node.completed_steps + '/' + node.total_steps + ' steps'
          : node.kind === 'step'
            ? node.action
            : (node.category || 'mcp') + ' · ' + node.transport;
      const g = svg(doc, 'g', { class: 'node node-' + node.kind, 'data-node': node.id, 'data-status': statusKey, 'data-selected': String(node.id === selectedNode), transform: 'translate(' + p.x + ' ' + p.y + ')' });
      if (node.kind === 'task' || node.kind === 'step') {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', (node.kind === 'task' ? 'Task ' : 'Step ') + node.label + ', ' + (STATUS_TEXT[statusKey] || statusKey) + '. Show details.');
      }
      const title = svg(doc, 'title');
      title.textContent = node.label + (node.kind === 'mcp' && node.description ? ' — ' + node.description : '');
      g.append(
        title,
        svg(doc, 'rect', { class: 'node-box', width: p.w, height: p.h, rx: node.kind === 'step' ? 10 : 12 }),
        svg(doc, 'circle', { class: 'node-dot', cx: 14, cy: node.kind === 'step' ? p.h / 2 : 18, r: 4, 'data-kind': STATUS_KIND[statusKey] || 'queued' }),
      );
      const label = svg(doc, 'text', { class: 'node-label', x: 26, y: node.kind === 'step' ? p.h / 2 + 4 : 22 });
      label.textContent = truncate(node.label, 26);
      g.append(label);
      if (node.kind !== 'step') {
        const subText = svg(doc, 'text', { class: 'node-sub', x: 26, y: 40 });
        subText.textContent = truncate(sub + ' · ' + (STATUS_TEXT[statusKey] || statusKey), 34);
        g.append(subText);
      } else {
        const tag = svg(doc, 'text', { class: 'node-sub', x: p.w - 10, y: p.h / 2 + 4, 'text-anchor': 'end' });
        tag.textContent = sub;
        g.append(tag);
      }
      nodeLayer.append(g);
    }
    viewport.replaceChildren(root);
    applyThreshold();
  }

  function select(edgeId) {
    selectedId = edgeId;
    if (edgeId) selectedNode = null;
    for (const g of viewport.querySelectorAll('.node')) g.setAttribute('data-selected', String(g.getAttribute('data-node') === selectedNode));
    for (const group of viewport.querySelectorAll('.bridge')) group.setAttribute('data-selected', String(group.getAttribute('data-edge') === edgeId));
    renderInspector();
    if (edgeId) {
      const close = inspector.querySelector('.inspector-close');
      if (close && options.focusInspector !== false) close.focus();
    }
  }

  function selectNode(nodeId) {
    selectedNode = nodeId;
    if (nodeId) selectedId = null;
    for (const group of viewport.querySelectorAll('.bridge')) group.setAttribute('data-selected', 'false');
    for (const g of viewport.querySelectorAll('.node')) g.setAttribute('data-selected', String(g.getAttribute('data-node') === nodeId));
    renderInspector();
    if (nodeId) {
      const close = inspector.querySelector('.inspector-close');
      if (close && options.focusInspector !== false) close.focus();
    }
  }

  function closeButton(label, onClose) {
    const close = el(doc, 'button', { type: 'button', class: 'btn btn-small inspector-close', 'aria-label': label, text: 'Close' });
    close.addEventListener('click', onClose);
    return close;
  }

  // The full record behind a task node, fetched once per run state.
  async function recordFor(task) {
    const key = task.run_id + ':' + task.status + ':' + task.completed_steps;
    if (!records.has(key)) records.set(key, api.getTaskStatus(task.agent_id, task.label));
    return records.get(key);
  }

  function renderNodeInspector(node) {
    const task = node.kind === 'task' ? node : graph.nodes.find((n) => n.id === node.task);
    const close = closeButton('Close the details', () => {
      const target = viewport.querySelector('.node[data-node="' + CSS_escape(node.id) + '"]');
      selectNode(null);
      if (target) target.focus();
    });
    const body = el(doc, 'div', { class: 'inspector-node-body' }, [el(doc, 'p', { class: 'mini-label', text: 'Loading details…' })]);
    inspector.hidden = false;
    inspector.setAttribute('aria-label', node.kind === 'task' ? 'Task details' : 'Step details');
    inspector.replaceChildren(el(doc, 'div', { class: 'inspector-head' }, [el(doc, 'h3', { text: node.kind === 'task' ? 'Task details' : 'Step details' }), close]), body);
    if (!task) {
      body.replaceChildren(el(doc, 'p', { class: 'mini-label', text: 'This step’s task is no longer listed.' }));
      return;
    }
    recordFor(task).then((record) => {
      if (selectedNode !== node.id) return;
      body.replaceChildren(...(node.kind === 'task' ? taskDetails(record) : stepDetails(record, node.index)));
    }).catch((err) => {
      if (selectedNode !== node.id) return;
      body.replaceChildren(el(doc, 'p', { class: 'inspector-error', text: 'Could not load the details: ' + (err && err.message ? err.message : 'unknown error') }));
    });
  }

  const tokenText = (t) => (t ? (t.input || 0).toLocaleString() + ' in / ' + (t.output || 0).toLocaleString() + ' out' : '');
  const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '');

  function stepDetails(record, index) {
    const step = (record.plan || [])[index] || {};
    const result = (record.results || []).find((r) => r.step_index === index);
    const failed = record.failure && record.failure.step_index === index ? record.failure : null;
    const halted = record.status === 'HALTED' && record.interrupted_step_index === index;
    const output = result ? result.output || {} : null;
    const status = result ? 'COMPLETED' : failed ? 'FAILED' : halted ? 'HALTED' : record.status === 'RUNNING' && index === record.completed_steps ? 'RUNNING' : 'QUEUED';
    const parts = [
      el(doc, 'p', { class: 'inspector-route' }, [el(doc, 'strong', { text: step.step_id || 'step ' + (index + 1) }), ' · step ' + (index + 1) + ' of ' + (record.total_steps || '?') + ' · ' + (step.action || '')]),
      el(doc, 'span', { class: 'pill', 'data-kind': STATUS_KIND[status] || 'queued' }, [el(doc, 'span', { class: 'pill-dot' }), STATUS_TEXT[status] || status]),
    ];
    if (failed) {
      parts.push(el(doc, 'div', { class: 'inspector-error' }, [
        el(doc, 'strong', { text: 'Why it failed' }),
        el(doc, 'p', { text: failed.error + (failed.status ? ' (HTTP ' + failed.status + ')' : '') }),
        el(doc, 'p', { class: 'mini-label', text: /gemini|google|upstream|returned an error|timed out|429|50\d/i.test(failed.error) ? 'This came from the model provider, not your blueprint. Run it again; the engine now retries a failed Gemini step once and then lets Claude take over.' : 'Steps after this one did not run.' }),
      ]));
    }
    if (halted) parts.push(el(doc, 'div', { class: 'inspector-error' }, [el(doc, 'strong', { text: 'Halted by the circuit breaker' }), el(doc, 'p', { text: (record.halt && record.halt.reason) || 'No reason given.' })]));
    const meta = [
      ['Model', output && output.model ? output.model + (output.tier ? ' · ' + output.tier : '') : ''],
      ['Tokens', result ? tokenText(result.tokens) : ''],
      ['Time', result ? (result.duration_ms / 1000).toFixed(1) + ' s · started ' + when(result.started_at) : ''],
      ['Run', record.task_id + ' · ' + record.agent_id],
    ].filter(([, v]) => v);
    parts.push(el(doc, 'dl', { class: 'inspector-meta' }, meta.flatMap(([k, v]) => [el(doc, 'dt', { text: k }), el(doc, 'dd', { text: v })])));
    if (step.summary) parts.push(el(doc, 'h4', { text: 'Instructions' }), el(doc, 'p', { class: 'inspector-text', text: step.summary + (step.summary.length >= 500 ? '…' : '') }));
    if (output) {
      const reply = typeof output.response === 'string' ? output.response : JSON.stringify(output, null, 2);
      parts.push(el(doc, 'h4', { text: typeof output.response === 'string' ? 'Reply' : 'Output' }), el(doc, 'pre', { class: 'inspector-reply' }, [el(doc, 'code', { text: reply || '(empty)' })]));
      if (reply && win.navigator && win.navigator.clipboard) {
        const copy = el(doc, 'button', { type: 'button', class: 'btn btn-small inspector-copy', text: 'Copy reply' });
        copy.addEventListener('click', () => win.navigator.clipboard.writeText(reply).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; }));
        parts.push(copy);
      }
    } else if (!failed && !halted) {
      parts.push(el(doc, 'p', { class: 'mini-label', text: status === 'RUNNING' ? 'Running now.' : 'Not run yet.' }));
    }
    return parts;
  }

  function taskDetails(record) {
    const parts = [
      el(doc, 'p', { class: 'inspector-route' }, [el(doc, 'strong', { text: record.task_id }), ' · ' + record.agent_id]),
      el(doc, 'span', { class: 'pill', 'data-kind': STATUS_KIND[record.status] || 'queued' }, [el(doc, 'span', { class: 'pill-dot' }), STATUS_TEXT[record.status] || record.status]),
    ];
    if (record.failure) {
      const step = (record.plan || [])[record.failure.step_index] || {};
      parts.push(el(doc, 'div', { class: 'inspector-error' }, [el(doc, 'strong', { text: 'Failed at ' + (step.step_id || 'step ' + (record.failure.step_index + 1)) }), el(doc, 'p', { text: record.failure.error })]));
    }
    if (record.status === 'HALTED' && record.halt) parts.push(el(doc, 'div', { class: 'inspector-error' }, [el(doc, 'strong', { text: 'Halted by the circuit breaker' }), el(doc, 'p', { text: record.halt.reason || 'No reason given.' })]));
    parts.push(el(doc, 'dl', { class: 'inspector-meta' }, [
      ['Steps', record.completed_steps + ' of ' + record.total_steps + ' done'],
      ['Tokens', tokenText(record.total_tokens)],
      ['Started', when(record.started_at)],
      ['Finished', when(record.finished_at) || 'still running'],
      ['Run id', record.run_id],
    ].flatMap(([k, v]) => [el(doc, 'dt', { text: k }), el(doc, 'dd', { text: v })])));
    parts.push(el(doc, 'h4', { text: 'Steps' }));
    parts.push(el(doc, 'ol', { class: 'inspector-steps' }, (record.plan || []).map((step, index) => {
      const done = (record.results || []).some((r) => r.step_index === index);
      const failed = record.failure && record.failure.step_index === index;
      const button = el(doc, 'button', { type: 'button', class: 'inspector-step-link', 'data-state': failed ? 'failed' : done ? 'done' : 'queued', text: (failed ? '✕ ' : done ? '✓ ' : '○ ') + step.step_id });
      button.addEventListener('click', () => selectNode('task:' + record.agent_id + ':' + record.task_id + ':' + index));
      return el(doc, 'li', {}, [button]);
    })));
    return parts;
  }

  function renderInspector() {
    const edge = graph && selectedId ? graph.edges.find((e) => e.id === selectedId && e.kind === 'bridge') : null;
    const node = !edge && graph && selectedNode ? graph.nodes.find((n) => n.id === selectedNode) : null;
    if (node) {
      renderNodeInspector(node);
      return;
    }
    inspector.setAttribute('aria-label', 'Edge Inspector');
    if (!edge) {
      inspector.hidden = true;
      inspector.replaceChildren();
      return;
    }
    const m = edge.metadata;
    const close = el(doc, 'button', { type: 'button', class: 'btn btn-small inspector-close', 'aria-label': 'Close the Edge Inspector', text: 'Close' });
    close.addEventListener('click', () => {
      const hit = viewport.querySelector('.bridge[data-edge="' + CSS_escape(edge.id) + '"] .bridge-hit');
      select(null);
      if (hit) hit.focus();
    });
    const pct = Math.round(edge.confidence * 100);
    inspector.hidden = false;
    // replaceChildren would print a null part as the text "null"; parts left out are dropped.
    inspector.replaceChildren(...[
      el(doc, 'div', { class: 'inspector-head' }, [el(doc, 'h3', { text: 'Edge Inspector' }), close]),
      el(doc, 'p', { class: 'inspector-route' }, [el(doc, 'strong', { text: m.step_id }), ' → ', el(doc, 'strong', { text: m.server })]),
      bridgeVisible(edge, threshold) ? null : el(doc, 'p', { class: 'mini-label inspector-hidden-note', text: 'Hidden at the current slider setting (' + threshold + '% minimum).' }),
      el(doc, 'div', { class: 'inspector-confidence' }, [
        el(doc, 'span', { class: 'inspector-pct', text: pct + '%' }),
        el(doc, 'span', { class: 'pill', 'data-kind': edge.depth === 'logic' ? 'running' : edge.depth === 'associative' ? 'queued' : 'alert' }, [el(doc, 'span', { class: 'pill-dot' }), DEPTH_TEXT[edge.depth] || edge.depth]),
      ]),
      el(doc, 'div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Confidence' }, [el(doc, 'span', { style: 'width:' + pct + '%' })]),
      el(doc, 'h4', { text: "Elarion's step rationale" }),
      el(doc, 'p', { class: 'inspector-rationale', text: edge.rationale }),
      m.elarion_excerpt
        ? el(doc, 'blockquote', { class: 'inspector-quote' }, [el(doc, 'span', { class: 'mini-label', text: 'Elarion replied' }), el(doc, 'p', { text: m.elarion_excerpt })])
        : el(doc, 'p', { class: 'mini-label', text: m.step_status === 'COMPLETED' ? 'This step returned no text.' : "This step hasn't run yet, so the score uses its instructions only." }),
      m.step_excerpt ? el(doc, 'details', { class: 'inspector-step' }, [el(doc, 'summary', { text: 'Step instructions' }), el(doc, 'p', { text: m.step_excerpt })]) : null,
      el(doc, 'h4', { text: 'Confidence metrics' }),
      el(
        doc,
        'ul',
        { class: 'inspector-signals' },
        edge.signals.map((s) =>
          el(doc, 'li', {}, [
            el(doc, 'span', { text: SIGNAL_TEXT[s.type] || s.type }),
            el(doc, 'span', { class: 'mono', text: (s.weight >= 0 ? '+' : '') + s.weight.toFixed(2) }),
            s.terms.length ? el(doc, 'span', { class: 'mini-label inspector-terms', text: s.terms.join(', ') }) : null,
          ]),
        ),
      ),
      el(doc, 'p', { class: 'mini-label', text: 'Scoring: ' + m.scoring + '. It measures how strongly the step relates to the server, not whether the server was called.' }),
      el(doc, 'h4', { text: 'Bridge metadata' }),
      el(
        doc,
        'dl',
        { class: 'inspector-meta' },
        [
          ['Agent', m.agent_id],
          ['Task', m.task_id],
          ['Run', m.run_id],
          ['Step', '#' + (m.step_index + 1) + ' · ' + m.step_action + ' · ' + (STATUS_TEXT[m.step_status] || m.step_status)],
          ['Server', m.server + ' · ' + (m.category || 'uncategorised')],
          ['Transport', m.transport],
          ['Keys', STATUS_TEXT[m.server_status] || m.server_status],
          ['Edge id', edge.id],
        ].flatMap(([k, v]) => [el(doc, 'dt', { text: k }), el(doc, 'dd', { text: v })]),
      ),
    ].filter(Boolean));
  }

  function renderStatus() {
    if (error) {
      status.replaceChildren(error.text + ' ');
      if (error.connect) {
        const btn = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: 'Open Settings' });
        btn.addEventListener('click', onConnect);
        status.append(btn);
      }
      status.setAttribute('data-kind', 'error');
      return;
    }
    status.removeAttribute('data-kind');
    if (!graph) {
      status.textContent = loading ? 'Loading the canvas…' : '';
      return;
    }
    const c = graph.counts;
    const parts = [c.tasks + ' task run' + (c.tasks === 1 ? '' : 's'), c.steps + ' step' + (c.steps === 1 ? '' : 's'), c.mcp_servers + ' MCP server' + (c.mcp_servers === 1 ? '' : 's')];
    let text = parts.join(' · ');
    if (!c.tasks) text += '. No task runs yet: run a blueprint or a recipe and its steps appear here.';
    if (graph.mcp_error) text += ' ' + graph.mcp_error;
    status.textContent = text;
  }

  async function refresh() {
    if (destroyed || loading) return;
    loading = true;
    renderStatus();
    try {
      graph = await api.getCanvasGraph();
      error = null;
      if (selectedId && !graph.edges.some((e) => e.id === selectedId)) selectedId = null;
      renderCanvas();
    } catch (err) {
      const away = err && !err.status ? describeUnreachableEngine(api.baseUrl) : '';
      if (away) error = { text: away, connect: true };
      else if (err && err.isUnauthorized) error = { text: describeAuthError(err), connect: true };
      else if (err && err.status === 404) error = { text: 'This engine has no canvas endpoint (GET /api/canvas/graph). Update Aether_Engine and restart it.', connect: false };
      else error = { text: 'Could not load the canvas from the engine (' + (err && err.message ? err.message : 'unreachable') + ').', connect: !err || !err.status };
    } finally {
      loading = false;
      renderStatus();
      renderNote();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (active && !destroyed) timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, options.pollMs ?? POLL_MS);
  }

  slider.addEventListener('input', () => {
    threshold = clampThreshold(slider.value);
    saveThreshold(win, threshold);
    applyThreshold();
  });
  refreshBtn.addEventListener('click', () => refresh());
  const pick = (target) => {
    const node = target && target.closest ? target.closest('.node-task, .node-step') : null;
    if (node) {
      selectNode(node.getAttribute('data-node'));
      return;
    }
    const group = target && target.closest ? target.closest('.bridge') : null;
    if (group && group.getAttribute('data-hidden') !== 'true') select(group.getAttribute('data-edge'));
  };
  viewport.addEventListener('click', (event) => pick(event.target));
  viewport.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList && (event.target.classList.contains('bridge-hit') || event.target.classList.contains('node-task') || event.target.classList.contains('node-step'))) {
      event.preventDefault();
      pick(event.target);
    }
  });
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selectedId) select(null);
    else if (event.key === 'Escape' && selectedNode) selectNode(null);
  });
  renderNote();

  return {
    refresh,
    // The Studio view calls this when it is shown or hidden, so the canvas only polls while visible.
    setActive(next) {
      active = Boolean(next);
      if (active) refresh().then(schedule);
      else clearTimeout(timer);
    },
    select,
    selectNode,
    setThreshold(value) {
      threshold = clampThreshold(value);
      slider.value = String(threshold);
      applyThreshold();
    },
    getState: () => ({ graph, error, threshold, selectedId, selectedNode, active }),
    destroy() {
      destroyed = true;
      clearTimeout(timer);
    },
  };
}

// CSS.escape where available (attribute selectors with ids that contain ':' and '>').
function CSS_escape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}
