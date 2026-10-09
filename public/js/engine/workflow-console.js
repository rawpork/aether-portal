// Mission Control → Studio → Workflow console (Phase 4, Step 4.1b; specs/ui/01-node-canvas.md).
//
// - Studio Command Bar: a goal generates a workflow on Aether_Engine (agents, A2A hand-offs, MCP tool bindings,
//   actions behind approval checkpoints); with a workflow open, a prompt changes it ("add an agent to review the code
//   before deployment"). New nodes are auto-arranged and flagged for a moment so the change is visible.
// - Human override: drag nodes by their header (8px grid), drag from an output port to an input port to wire (or
//   Enter on a port for "Connect to…"), select a cable or node and press Delete, edit an agent in the inspector.
//   Every change is saved to the engine against the version it was made on; a 409 reloads the newer version.
// - Runs: Run starts the workflow on the engine and polls its events. Each flow event sends a pulse along its cable
//   (at most 3 per cable, extras count on a badge); node statuses update in place; a breaker halt freezes the canvas.
//
// Port rules and layout live in workflow-model.js (mirrors Aether_Engine src/workflows.ts).
import { stepChatMenu } from './step-chat.js';
import { getEngineApi } from '../engine-api.bundle.js';
import { issuesFor, workflowReadiness } from './workflow-readiness.js';
import { describeAuthError, describeUnreachableEngine } from './connection.js';
import {
  CABLE_TEXT, KIND_TEXT, NODE_H, NODE_W, PORT_TEXT, PORTS, autoLayout, cableLabel, cablePath, cablePoint, checkConnect,
  compatibleTargets, ease, graphForSave, localId, portOffset, portPoint, snap, stageSize,
} from './workflow-model.js';

export const EVENT_POLL_MS = 500;
export const PULSE_MS = 600;
export const MAX_PULSES_PER_CABLE = 3;
const SAVE_DELAY_MS = 450;
const NEW_FLAG_MS = 2400;
const BADGE_MS = 1500;
const SVG_NS = 'http://www.w3.org/2000/svg';

const RUN_TEXT = { running: 'Running', done: 'Done', failed: 'Failed', halted: 'Halted', proposed: 'Proposed', waiting: 'Waiting' };
const RUN_KIND = { running: 'running', done: 'running', failed: 'off', halted: 'off', proposed: 'alert', waiting: 'queued' };
const SOURCE_TEXT = { model: 'Model', planner: 'Built-in planner', operator: 'You' };

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

function svg(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  return node;
}

const cssEscape = (value) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));

export function mountWorkflowConsole(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const onConnect = options.onConnect || (() => {});
  const now = options.now || (() => Date.now());
  const raf = options.requestAnimationFrame || ((fn) => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16)));
  const reducedMotion = options.reducedMotion ?? Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const pollMs = options.pollMs ?? EVENT_POLL_MS;

  let list = [];
  let workflow = null; // engine workflow with every node positioned
  let selected = null; // { type: 'node' | 'cable', id }
  let tap = null; // a press on a node that may become a select
  let mode = 'generate'; // command bar: generate a new workflow or change the open one
  let busy = false;
  let error = null;
  let message = '';
  let run = null;
  let lastSeq = 0;
  let pollTimer = null;
  let active = false;
  let loaded = false;
  let destroyed = false;
  let saveTimer = null;
  let saving = null;
  let saveAgain = false;
  let editable = options.editable ?? !(win.matchMedia && win.matchMedia('(max-width: 600px)').matches);
  const fresh = new Map(); // node / cable id -> time it appeared (highlight)
  const pulses = []; // { cableId, start, dot, halo }
  const overflow = new Map(); // cable id -> extra events beyond the pulse cap
  let animating = false;
  let frozen = false;
  let lastRunSummary = '';

  // ---- static frame -------------------------------------------------------------------------------------------
  const prompt = el(doc, 'textarea', { id: 'wfc-prompt', class: 'wfc-prompt', rows: '1', maxlength: '4000', 'aria-describedby': 'wfc-prompt-hint' });
  const submit = el(doc, 'button', { type: 'submit', class: 'btn-primary wfc-submit' });
  const hint = el(doc, 'span', { id: 'wfc-prompt-hint', class: 'mini-label' });
  const newBtn = el(doc, 'button', { type: 'button', class: 'btn btn-small btn-ghost wfc-new' });
  const form = el(doc, 'form', { class: 'wfc-command surface', 'aria-label': 'Studio Command Bar' }, [
    el(doc, 'label', { class: 'wfc-command-label', for: 'wfc-prompt', text: 'Studio Command Bar' }),
    el(doc, 'div', { class: 'wfc-command-row' }, [prompt, submit]),
    el(doc, 'div', { class: 'wfc-command-meta' }, [hint, newBtn]),
  ]);
  const picker = el(doc, 'select', { class: 'wfc-picker', 'aria-label': 'Open workflow' });
  // The version is a button: it opens the toolbox on the version history, where a click goes back to that version.
  const version = el(doc, 'button', { type: 'button', class: 'wfc-version', title: 'Version history: click to go back to an earlier version', hidden: true });
  const arrangeBtn = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: 'Auto-arrange' });
  const editBtn = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-edit-toggle' });
  const runBtn = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-run', text: 'Run' });
  const hintsBtn = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-hints-btn', 'aria-pressed': 'false', title: 'Hints: hover a node, port or cable to see what it is and does' });
  const legend = el(doc, 'span', { class: 'wfc-legend mini-label', 'aria-hidden': 'true' }, Object.entries(CABLE_TEXT).map(([kind, text]) => el(doc, 'span', { class: 'wfc-legend-item', 'data-kind': kind }, [el(doc, 'span', { class: 'wfc-legend-line' }), text])));
  const status = el(doc, 'p', { class: 'wfc-status mini-label', role: 'status', 'aria-live': 'polite' });
  const banner = el(doc, 'div', { class: 'wfc-halted', role: 'alert', hidden: true });
  const cableLayer = svg(doc, 'svg', { class: 'wfc-cables', 'aria-hidden': 'false' });
  const defs = svg(doc, 'defs');
  const marker = svg(doc, 'marker', { id: 'wfc-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  marker.append(svg(doc, 'path', { d: 'M0 0 L10 5 L0 10 z', class: 'wfc-arrow' }));
  defs.append(marker);
  const cableGroup = svg(doc, 'g', { class: 'wfc-cable-group' });
  const ghost = svg(doc, 'path', { class: 'wfc-ghost', d: '' });
  const pulseGroup = svg(doc, 'g', { class: 'wfc-pulses' });
  cableLayer.append(defs, cableGroup, ghost, pulseGroup);
  const nodeLayer = el(doc, 'div', { class: 'wfc-nodes' });
  const stage = el(doc, 'div', { class: 'wfc-stage' }, [cableLayer, nodeLayer]);
  const viewport = el(doc, 'div', { class: 'wfc-viewport', role: 'group', 'aria-label': 'Workflow canvas. Drag to move around, scroll or pinch to zoom, double-click to fit the whole flow.', title: 'Drag to move around · scroll or pinch to zoom · double-click to fit' }, [stage]);
  // Camera controls: the canvas pans and zooms like a map (drag, wheel, pinch); these buttons are the same thing for a keyboard or a mouse without a wheel.
  const zoomOut = el(doc, 'button', { type: 'button', class: 'wfc-zoom-btn', 'aria-label': 'Zoom out', title: 'Zoom out (-)', text: '−' });
  const zoomLabel = el(doc, 'span', { class: 'wfc-zoom-label', 'aria-live': 'polite', text: '100%' });
  const zoomIn = el(doc, 'button', { type: 'button', class: 'wfc-zoom-btn', 'aria-label': 'Zoom in', title: 'Zoom in (+)', text: '+' });
  const zoomFit = el(doc, 'button', { type: 'button', class: 'wfc-zoom-btn wfc-zoom-fit', 'aria-label': 'Fit the whole flow in view', title: 'Fit the whole flow (0 or double-click)', text: 'Fit' });
  const zoomBar = el(doc, 'div', { class: 'wfc-zoom', role: 'group', 'aria-label': 'Canvas zoom' }, [zoomOut, zoomLabel, zoomIn, zoomFit]);
  const toolbox = el(doc, 'aside', { class: 'wfc-toolbox surface', 'aria-label': 'Toolbox: what the workflow can connect to' });
  const tip = el(doc, 'p', { class: 'wfc-tip', role: 'alert', hidden: true });
  const menu = el(doc, 'div', { class: 'wfc-connect-menu surface', role: 'dialog', 'aria-label': 'Connect to', hidden: true });
  const inspector = el(doc, 'aside', { class: 'wfc-inspector surface', 'aria-label': 'Workflow inspector' });
  container.replaceChildren(
    form,
    el(doc, 'div', { class: 'wfc-toolbar' }, [picker, version, el(doc, 'span', { class: 'studio-spacer' }), legend, hintsBtn, arrangeBtn, editBtn, runBtn]),
    status,
    banner,
    el(doc, 'div', { class: 'wfc-body' }, [toolbox, el(doc, 'div', { class: 'wfc-canvas-wrap' }, [viewport, zoomBar, tip, menu]), inspector]),
  );

  // ---- hover: the cables of the node under the pointer light up and the rest dim; with Hints on, a card says what it is -------------
  const HINTS_KEY = 'aether.studio.hints';
  let hintsOn = false;
  try { hintsOn = win.localStorage.getItem(HINTS_KEY) === 'on'; } catch { /* storage blocked: off */ }
  const hintEl = el(doc, 'div', { class: 'wfc-hint', role: 'tooltip', hidden: true });
  doc.body.append(hintEl);
  const PORT_HINTS = {
    start: 'Start: hands the work on to the next agent, or kicks the flow off.',
    context: 'Context: extra background an agent reads before it starts.',
    a2a: 'A2A: agent to agent. The next agent builds on what this one produced.',
    mcp: 'MCP: tools this agent can read from, such as a connected service.',
    act: 'Act: an action this agent proposes, such as sending a message. It waits for your approval.',
    read: 'Read: the tool this agent reads from.',
  };
  const CABLE_HINTS = {
    start: 'Start cable: the work moves from one step to the next.',
    mcp_read: 'MCP read cable: the agent reads from this tool; nothing is changed.',
    a2a: 'A2A cable: hand-off from one agent to another.',
    action: 'Action cable: something this agent proposes to do. It stops for your approval first.',
  };
  function hintFor(target) {
    const port = target.closest && target.closest('.wfc-port');
    const card = target.closest && target.closest('.wfc-node');
    const cableNode = target.closest && target.closest('.wfc-cable');
    if (port) return { title: PORT_TEXT[port.getAttribute('data-port')] + ' ' + (port.getAttribute('data-dir') === 'out' ? 'output' : 'input'), body: PORT_HINTS[port.getAttribute('data-port')] || '' };
    if (card) {
      const node = nodeById(card.getAttribute('data-node'));
      if (!node) return null;
      const lines = [node.role, node.instructions && node.instructions.slice(0, 160), node.connector ? 'Connector: ' + node.connector + '.' + node.action : '', run && run.node_status && run.node_status[node.id] ? 'Last run: ' + RUN_TEXT[run.node_status[node.id]] : ''].filter(Boolean);
      return { title: KIND_TEXT[node.kind] + ': ' + node.label, body: lines.concat('Tap or click the card to see where its data comes from.').join('\n') };
    }
    if (cableNode) {
      const cable = cableById(cableNode.getAttribute('data-cable'));
      return cable ? { title: CABLE_TEXT[cable.kind] + ' cable', body: (nodeById(cable.from) || {}).label + ' → ' + (nodeById(cable.to) || {}).label + '\n' + (CABLE_HINTS[cable.kind] || '') } : null;
    }
    return null;
  }
  function placeHint(event) {
    const w = hintEl.offsetWidth || 260;
    hintEl.style.left = Math.max(8, Math.min(event.clientX + 14, win.innerWidth - w - 8)) + 'px';
    hintEl.style.top = Math.min(event.clientY + 16, win.innerHeight - (hintEl.offsetHeight || 80) - 8) + 'px';
  }
  function focusNode(id) {
    if (!id) {
      cableGroup.removeAttribute('data-focus');
      for (const c of cableGroup.querySelectorAll('.wfc-cable')) c.removeAttribute('data-linked');
      for (const n of nodeLayer.querySelectorAll('.wfc-node')) n.removeAttribute('data-linked');
      return;
    }
    const linked = new Set([id]);
    for (const c of workflow ? workflow.cables : []) {
      if (c.from === id || c.to === id) {
        linked.add(c.from);
        linked.add(c.to);
        const ce = cableEl(c.id);
        if (ce) ce.setAttribute('data-linked', 'true');
      }
    }
    cableGroup.setAttribute('data-focus', id);
    for (const n of nodeLayer.querySelectorAll('.wfc-node')) n.setAttribute('data-linked', String(linked.has(n.getAttribute('data-node'))));
  }
  viewport.addEventListener('pointerover', (event) => {
    if (drag || wiring) return;
    const card = event.target.closest && event.target.closest('.wfc-node');
    focusNode(card ? card.getAttribute('data-node') : null);
  });
  viewport.addEventListener('pointerleave', (event) => {
    focusNode(null);
    // A finger lifting also "leaves": keep the hint a tap just showed until the next tap.
    if (event.pointerType !== 'touch') hintEl.hidden = true;
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!hintsOn || drag || wiring || event.buttons) {
      hintEl.hidden = true;
      return;
    }
    const hint = hintFor(event.target);
    if (!hint) {
      hintEl.hidden = true;
      return;
    }
    hintEl.replaceChildren(el(doc, 'strong', { text: hint.title }), ...(hint.body ? [el(doc, 'span', { class: 'wfc-hint-body', text: hint.body })] : []));
    hintEl.hidden = false;
    placeHint(event);
  });
  // A finger has no hover: with hints on, tapping a node, port or cable shows its hint; tapping empty canvas hides it.
  viewport.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch' || !hintsOn || drag || wiring) return;
    const hint = hintFor(event.target);
    if (!hint) {
      hintEl.hidden = true;
      return;
    }
    hintEl.replaceChildren(el(doc, 'strong', { text: hint.title }), ...(hint.body ? [el(doc, 'span', { class: 'wfc-hint-body', text: hint.body })] : []));
    hintEl.hidden = false;
    placeHint({ clientX: Math.min(event.clientX, win.innerWidth - 280), clientY: Math.max(8, event.clientY - (hintEl.offsetHeight || 80) - 24) });
  });
  hintsBtn.addEventListener('click', () => {
    hintsOn = !hintsOn;
    try { win.localStorage.setItem(HINTS_KEY, hintsOn ? 'on' : 'off'); } catch { /* storage blocked: for this page only */ }
    if (!hintsOn) hintEl.hidden = true;
    renderToolbar();
  });

  // ---- camera: the stage is moved and scaled inside a fixed viewport, so there are no scrollbars -----------------
  const K_MIN = 0.1; // low enough that a long flow fits a phone
  const K_MAX = 2.5;
  const FIT_PAD = 40;
  const cam = { x: 0, y: 0, k: 1 };
  let camTouched = false; // once you move the view yourself it stays put; a new workflow or Fit frames the flow again
  const clampK = (k) => Math.min(K_MAX, Math.max(K_MIN, k));
  function applyCam() {
    stage.style.transform = 'translate(' + Math.round(cam.x * 100) / 100 + 'px, ' + Math.round(cam.y * 100) / 100 + 'px) scale(' + Math.round(cam.k * 1000) / 1000 + ')';
    zoomLabel.textContent = Math.round(cam.k * 100) + '%';
  }
  // Frames every node: scaled down to fit (never up past 100%) and centred.
  function fitView() {
    camTouched = false;
    if (!workflow || !workflow.nodes.length) {
      Object.assign(cam, { x: 0, y: 0, k: 1 });
      return applyCam();
    }
    const box = viewport.getBoundingClientRect();
    if (!box.width || !box.height) return applyCam(); // hidden (another Studio tab): framed when it is shown
    const xs = workflow.nodes.map((n) => n.x);
    const ys = workflow.nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(...xs) + NODE_W - minX;
    const h = Math.max(...ys) + NODE_H - minY;
    const pad = Math.min(FIT_PAD, box.width * 0.05);
    const k = clampK(Math.min((box.width - pad * 2) / w, (box.height - pad * 2) / h, 1));
    cam.k = k;
    cam.x = (box.width - w * k) / 2 - minX * k;
    // Centred, unless the flow is a thin strip in a tall box (a phone): then it sits near the top where it is seen.
    // (The strip along the top is kept clear for the toolbox and zoom buttons.)
    cam.y = (box.height > h * k * 1.6 ? 64 : (box.height - h * k) / 2) - minY * k;
    applyCam();
  }
  // Zooms about a point on screen, so what is under the pointer stays under it.
  function zoomAt(clientX, clientY, factor) {
    const box = viewport.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    const k = clampK(cam.k * factor);
    cam.x = px - (px - cam.x) * (k / cam.k);
    cam.y = py - (py - cam.y) * (k / cam.k);
    cam.k = k;
    camTouched = true;
    applyCam();
  }
  const zoomCentre = (factor) => {
    const box = viewport.getBoundingClientRect();
    zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
  };
  // The viewport's size settles after the first draw (the page above it finishes laying out, a phone rotates): while the view is not
  // moved by hand, keep the whole flow framed.
  let sizeWatch = null;
  if (win.ResizeObserver) {
    sizeWatch = new win.ResizeObserver(() => { if (!camTouched) fitView(); });
    sizeWatch.observe(viewport);
  }
  zoomIn.addEventListener('click', () => zoomCentre(1.25));
  zoomOut.addEventListener('click', () => zoomCentre(0.8));
  zoomFit.addEventListener('click', () => fitView());

  // Wheel and trackpad pinch (which browsers report as ctrl+wheel) zoom about the pointer.
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 16 : 1;
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.0018)));
  }, { passive: false });

  // Drag the background to move around; two fingers pinch and move at once. Nodes, ports and cables keep their own drags.
  const touches = new Map();
  let pan = null;
  let pinch = null;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  viewport.addEventListener('pointerdown', (event) => {
    if (event.target.closest && event.target.closest('.wfc-node, .wfc-cable, .wfc-port')) return;
    if (event.pointerType === 'mouse' && event.button > 1) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (viewport.setPointerCapture) { try { viewport.setPointerCapture(event.pointerId); } catch { /* not capturable */ } }
    if (touches.size === 2) {
      const s = spread();
      pinch = { dist: s.dist, k: cam.k };
      pan = null;
    } else if (touches.size === 1) {
      pan = { x: event.clientX, y: event.clientY, moved: false };
    }
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!touches.has(event.pointerId)) return;
    const before = touches.size === 2 ? spread() : null;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && touches.size === 2) {
      const now = spread();
      zoomAt(now.x, now.y, (pinch.k * (now.dist / pinch.dist)) / cam.k);
      cam.x += now.x - before.x;
      cam.y += now.y - before.y;
      applyCam();
    } else if (pan) {
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      pan.moved = true;
      viewport.setAttribute('data-panning', 'true');
      cam.x += dx;
      cam.y += dy;
      pan.x = event.clientX;
      pan.y = event.clientY;
      camTouched = true;
      applyCam();
    }
  });
  const endTouch = (event) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = null;
    if (!touches.size) {
      pan = null;
      viewport.removeAttribute('data-panning');
    }
  };
  viewport.addEventListener('pointerup', endTouch);
  viewport.addEventListener('pointercancel', endTouch);
  viewport.addEventListener('dblclick', (event) => {
    if (event.target.closest && event.target.closest('.wfc-node, .wfc-cable')) return;
    fitView();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------
  const nodeById = (id) => workflow && workflow.nodes.find((n) => n.id === id);
  const cableById = (id) => workflow && workflow.cables.find((c) => c.id === id);
  const nodeEl = (id) => nodeLayer.querySelector('.wfc-node[data-node="' + cssEscape(id) + '"]');
  const cableEl = (id) => cableGroup.querySelector('.wfc-cable[data-cable="' + cssEscape(id) + '"]');
  const ends = (cable) => {
    const from = nodeById(cable.from);
    const to = nodeById(cable.to);
    if (!from || !to) return null;
    const a = portPoint(from, 'out', cable.from_port);
    const b = portPoint(to, 'in', cable.to_port);
    return a && b ? [a, b] : null;
  };

  function describeError(err, what) {
    const away = err && !err.status ? describeUnreachableEngine(api.baseUrl) : '';
    if (away) return { text: away, connect: true };
    if (err && err.isUnauthorized) return { text: describeAuthError(err), connect: true };
    if (err && err.status === 404 && /\/api\/workflows$/.test(err.path || '')) return { text: 'This engine has no workflow endpoints (/api/workflows). Update Aether_Engine and restart it.', connect: false };
    const problems = err && err.body && Array.isArray(err.body.problems) ? ' ' + err.body.problems.join(' ') : '';
    return { text: what + ' (' + (err && err.message ? err.message : 'engine unreachable') + ').' + problems, connect: !err || !err.status };
  }

  function setBusy(next) {
    busy = next;
    submit.disabled = busy;
    runBtn.disabled = busy || !workflow || (run && run.status === 'RUNNING');
    prompt.setAttribute('aria-busy', String(busy));
  }

  function showTip(text, anchor) {
    tip.textContent = text;
    tip.hidden = !text;
    if (anchor && !reducedMotion) {
      anchor.classList.remove('wfc-shake');
      void anchor.offsetWidth;
      anchor.classList.add('wfc-shake');
    }
    clearTimeout(showTip.timer);
    if (text) showTip.timer = setTimeout(() => { tip.hidden = true; }, 4000);
  }

  // ---- rendering ----------------------------------------------------------------------------------------------
  function renderCommand() {
    const changing = mode === 'change' && workflow;
    submit.textContent = busy ? (changing ? 'Applying…' : 'Generating…') : changing ? 'Apply' : 'Generate';
    prompt.placeholder = changing
      ? 'Change this workflow, e.g. "Add an agent to review the code before deployment"'
      : 'Describe a goal, e.g. "Research competitor pricing, write a landing page and deploy it"';
    hint.textContent = changing
      ? 'Changes "' + workflow.title + '" on Aether_Engine. Ctrl+Enter to apply.'
      : 'Aether_Engine designs the agents, A2A hand-offs and tool bindings. Ctrl+Enter to generate.';
    newBtn.textContent = changing ? 'New workflow' : 'Change the open workflow';
    newBtn.hidden = !workflow;
  }

  function renderToolbar() {
    picker.replaceChildren(
      ...(list.length ? list : [{ workflow_id: '', title: 'No workflows yet' }]).map((w) =>
        el(doc, 'option', { value: w.workflow_id, text: w.title + (w.agents !== undefined ? ' · ' + w.agents + ' agent' + (w.agents === 1 ? '' : 's') : '') }),
      ),
    );
    if (workflow) picker.value = workflow.workflow_id;
    picker.disabled = !list.length;
    version.hidden = !workflow;
    version.textContent = workflow ? 'v' + workflow.version + (saving ? ' · saving…' : ' ▾') : '';
    hintsBtn.textContent = hintsOn ? 'Hints on' : 'Hints';
    hintsBtn.setAttribute('aria-pressed', String(hintsOn));
    editBtn.textContent = editable ? 'Editing on' : 'Edit';
    editBtn.setAttribute('aria-pressed', String(editable));
    arrangeBtn.disabled = !workflow || !editable;
    runBtn.disabled = busy || !workflow || Boolean(run && run.status === 'RUNNING');
    runBtn.textContent = run && run.status === 'RUNNING' ? 'Running…' : 'Run';
    container.setAttribute('data-editable', String(editable));
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
    if (message) {
      status.textContent = message;
      return;
    }
    if (!workflow) {
      status.textContent = loaded ? 'No workflow open. Describe a goal in the Command Bar to generate one.' : 'Loading workflows…';
      return;
    }
    const agents = workflow.nodes.filter((n) => n.kind === 'agent').length;
    status.textContent = agents + ' agent' + (agents === 1 ? '' : 's') + ' · ' + workflow.cables.length + ' cable' + (workflow.cables.length === 1 ? '' : 's') + (editable ? ' · drag headers to move, drag from a port to wire' : '');
  }

  function renderBanner() {
    const halted = run && run.status === 'HALTED';
    banner.hidden = !halted;
    banner.textContent = halted ? 'HALTED: ' + (run.error || 'the circuit breaker stopped this run') + '. Reset the breaker, then run again.' : '';
    container.setAttribute('data-halted', String(Boolean(halted)));
  }

  function renderCanvas() {
    nodeLayer.replaceChildren();
    cableGroup.replaceChildren();
    if (!workflow) {
      stage.style.width = '';
      stage.style.height = '';
      return;
    }
    const { width, height } = stageSize(workflow.nodes);
    stage.style.width = width + 'px';
    stage.style.height = height + 'px';
    cableLayer.setAttribute('width', String(width));
    cableLayer.setAttribute('height', String(height));
    cableLayer.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    for (const cable of workflow.cables) cableGroup.append(renderCable(cable));
    if (!camTouched) fitView();
    for (const node of workflow.nodes) nodeLayer.append(renderNode(node));
  }

  function renderCable(cable) {
    const pts = ends(cable);
    const g = svg(doc, 'g', { class: 'wfc-cable', 'data-cable': cable.id, 'data-kind': cable.kind, 'data-selected': String(selected && selected.type === 'cable' && selected.id === cable.id), 'data-new': String(fresh.has(cable.id)) });
    if (!pts) return g;
    const d = cablePath(pts[0], pts[1]);
    if (cable.kind === 'a2a') g.append(svg(doc, 'path', { class: 'wfc-line wfc-line-outer', d }), svg(doc, 'path', { class: 'wfc-line wfc-line-inner', d }));
    else g.append(svg(doc, 'path', { class: 'wfc-line', d, 'marker-end': cable.kind === 'action' ? 'url(#wfc-arrow)' : null }));
    if (cable.kind === 'action') {
      const mid = cablePoint(pts[0], pts[1], 0.5);
      const bolt = svg(doc, 'text', { class: 'wfc-bolt', x: mid.x, y: mid.y + 4, 'text-anchor': 'middle', 'aria-hidden': 'true' });
      bolt.textContent = '⚡';
      g.append(bolt);
    }
    g.append(svg(doc, 'path', { class: 'wfc-hit', d, tabindex: '0', role: 'button', 'aria-label': cableLabel(cable, workflow.nodes) + (editable ? '. Press Delete to remove.' : '') }));
    return g;
  }

  const readiness = () => workflowReadiness(workflow, connectors, mcpServers);

  function renderNode(node) {
    const runStatus = run && run.node_status ? run.node_status[node.id] : undefined;
    const card = el(doc, 'div', {
      class: 'wfc-node',
      'data-node': node.id,
      'data-kind': node.kind,
      'data-selected': String(selected && selected.type === 'node' && selected.id === node.id),
      'data-new': String(fresh.has(node.id)),
      'data-run': runStatus || null,
      style: 'left:' + node.x + 'px;top:' + node.y + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px',
    });
    const head = el(doc, 'div', { class: 'wfc-node-head', tabindex: '0', role: 'button', 'aria-label': KIND_TEXT[node.kind] + ' ' + node.label + (editable ? '. Enter to inspect, arrow keys to move, Delete to remove.' : '. Enter to inspect.') }, [
      el(doc, 'span', { class: 'wfc-kind', text: KIND_TEXT[node.kind] }),
      el(doc, 'span', { class: 'wfc-node-label', text: node.label }),
    ]);
    card.append(head);
    const needs = issuesFor(readiness(), node.id);
    const sub = needs.length ? 'Needs setup: ' + needs[0].problem : node.kind === 'mcp' ? (node.role || 'MCP server') : node.role || (node.kind === 'action' ? 'Not executed automatically' : '');
    if (needs.length) card.setAttribute('data-needs', 'true');
    card.append(el(doc, 'p', { class: 'wfc-node-sub', text: sub, title: needs.length ? needs.map((i) => i.problem).join(' ') : node.instructions || sub }));
    const pillText = node.kind === 'human' && runStatus === 'running' ? 'Waiting for you' : RUN_TEXT[runStatus] || runStatus;
    if (runStatus) card.append(el(doc, 'span', { class: 'pill wfc-run-pill', 'data-kind': RUN_KIND[runStatus] || 'queued' }, [el(doc, 'span', { class: 'pill-dot' }), pillText]));
    for (const dir of ['in', 'out']) {
      for (const port of PORTS[node.kind][dir]) {
        const off = portOffset(node.kind, dir, port);
        const name = node.label + ': ' + PORT_TEXT[port] + (dir === 'in' ? ' input' : ' output');
        card.append(
          el(doc, 'button', {
            type: 'button',
            class: 'wfc-port',
            'data-dir': dir,
            'data-port': port,
            'aria-label': name + (dir === 'out' && editable ? '. Enter to connect.' : ''),
            title: name,
            style: 'top:' + off.y + 'px;' + (dir === 'in' ? 'left:0' : 'left:' + NODE_W + 'px'),
            tabindex: dir === 'out' && editable ? '0' : '-1',
          }),
          el(doc, 'span', { class: 'wfc-port-label', 'data-dir': dir, style: 'top:' + off.y + 'px', text: PORT_TEXT[port] }),
        );
      }
    }
    return card;
  }

  // ---- toolbox: the connectors a workflow can reach out to (the engine's list), added to the canvas as action nodes --------------
  let connectors = [];
  let mcpServers = [];
  let setupOpen = false; // the Set up panel, shown when Run finds things that are not ready
  let toolboxOpen = false; // closed by default so the canvas gets the room; the button opens it
  const STATUS_TEXT = { ready: 'Ready', needs_setup: 'Needs setup', coming_soon: 'Coming soon' };
  // Version history: fetched when the toolbox is open on a workflow, and again whenever the workflow's version changes.
  let versionList = [];
  let versionsFor = '';
  async function loadVersions() {
    if (!workflow) return;
    const key = workflow.workflow_id + ':' + workflow.version;
    versionsFor = key;
    try {
      const result = await api.listWorkflowVersions(workflow.workflow_id);
      if (versionsFor === key) versionList = (result && result.versions) || [];
    } catch {
      if (versionsFor === key) versionList = [];
    }
    renderToolbox();
  }
  async function restoreVersion(number) {
    if (!workflow) return;
    const previous = workflow;
    message = 'Going back to version ' + number + '…';
    renderStatus();
    try {
      if (saving) await saving;
      const next = await api.restoreWorkflowVersion(previous.workflow_id, number, workflow.version);
      adopt(next, previous);
      camTouched = false;
      message = 'Went back to version ' + number + ' (now v' + next.version + '). Click a version again to go forward.';
      error = null;
    } catch (err) {
      message = '';
      error = describeError(err, 'Could not go back to version ' + number);
    }
    renderAll();
  }
  const SOURCE_SHORT = { model: 'Model', planner: 'Planner', operator: 'You' };
  const agoText = (iso) => {
    const seconds = Math.max(0, (now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    return seconds < 90 ? 'just now' : seconds < 5400 ? Math.round(seconds / 60) + ' min ago' : seconds < 129600 ? Math.round(seconds / 3600) + ' h ago' : Math.round(seconds / 86400) + ' d ago';
  };
  version.addEventListener('click', () => {
    toolboxOpen = true;
    versionsFor = '';
    renderToolbox();
    if (toolbox.scrollIntoView) toolbox.scrollIntoView({ block: 'nearest' });
  });
  const connectorOf = (id) => connectors.find((c) => c.id === id);
  async function loadConnectors() {
    try {
      const result = await api.listConnectors();
      connectors = (result && result.connectors) || [];
    } catch {
      connectors = []; // an engine without connectors: the toolbox says so
    }
    try {
      const result = await api.listMcpServers();
      mcpServers = (result && result.servers) || [];
    } catch {
      mcpServers = []; // an older engine: tools are not checked
    }
    renderAll();
  }

  function renderToolbox() {
    const toggle = el(doc, 'button', { type: 'button', class: 'wfc-toolbox-toggle', 'aria-expanded': String(toolboxOpen), text: 'Toolbox ' + (toolboxOpen ? '▾' : '▸') });
    toggle.addEventListener('click', () => {
      toolboxOpen = !toolboxOpen;
      renderToolbox();
    });
    const nodes = [toggle];
    if (toolboxOpen) {
      if (!connectors.length) nodes.push(el(doc, 'p', { class: 'mini-label', text: 'No connectors found. The engine may need updating.' }));
      else nodes.push(el(doc, 'p', { class: 'mini-label', text: editable ? 'Add one to the canvas; it is wired to the selected agent.' : 'Turn on editing to add these.' }));
      for (const c of connectors) {
        const card = el(doc, 'section', { class: 'wfc-connector', 'data-status': c.status, 'aria-label': c.name }, [
          el(doc, 'div', { class: 'wfc-connector-head' }, [el(doc, 'strong', { text: c.name }), el(doc, 'span', { class: 'wfc-connector-status', text: STATUS_TEXT[c.status] || c.status })]),
          el(doc, 'p', { class: 'mini-label', text: c.status === 'ready' ? c.description : c.status_detail }),
        ]);
        for (const a of c.actions) {
          const add = el(doc, 'button', { type: 'button', class: 'wfc-connector-add', 'data-connector': c.id, 'data-action': a.id, title: a.description, disabled: !editable, text: '+ ' + a.label });
          add.addEventListener('click', () => addConnectorNode(c, a));
          card.append(add);
        }
        nodes.push(card);
      }
    }
    if (toolboxOpen && workflow) {
      nodes.push(el(doc, 'h4', { class: 'wfc-versions-title', text: 'Versions' }));
      if (!versionList.length) nodes.push(el(doc, 'p', { class: 'mini-label', text: 'Loading versions…' }));
      for (const v of versionList) {
        const row = el(doc, 'button', {
          type: 'button', class: 'wfc-version-row', 'data-version': String(v.version), 'data-current': String(v.current), disabled: v.current || !v.restorable,
          title: v.current ? 'This is the version on the canvas.' : v.restorable ? 'Go back to this version.' : 'This version was not kept.',
        }, [
          el(doc, 'span', { class: 'wfc-version-head' }, [el(doc, 'strong', { text: 'v' + v.version }), el(doc, 'span', { class: 'mini-label', text: v.current ? 'on the canvas' : (SOURCE_SHORT[v.source] || v.source) + ' · ' + agoText(v.at) })]),
          el(doc, 'span', { class: 'wfc-version-summary', text: v.summary }),
        ]);
        row.addEventListener('click', () => restoreVersion(v.version));
        nodes.push(row);
      }
      if (versionsFor !== workflow.workflow_id + ':' + workflow.version) loadVersions();
    }
    toolbox.dataset.open = String(toolboxOpen);
    toolbox.replaceChildren(...nodes);
  }

  // Puts a connector action on the canvas as an action node, beside the agent it follows, and wires it from that agent.
  function addConnectorNode(connector, action) {
    if (!workflow || !editable) return showTip('Turn on editing to add to the workflow.', null);
    const anchor = (selected && selected.type === 'node' && nodeById(selected.id) && nodeById(selected.id).kind === 'agent' ? nodeById(selected.id) : null) || [...workflow.nodes].reverse().find((n) => n.kind === 'agent') || null;
    const taken = (x, y) => workflow.nodes.some((n) => Math.abs(n.x - x) < NODE_W + 16 && Math.abs(n.y - y) < NODE_H + 16);
    let x = anchor ? anchor.x + NODE_W + 64 : 32;
    let y = anchor ? anchor.y : 32;
    for (let i = 0; i < 40 && taken(x, y); i++) y += NODE_H + 24;
    const params = Object.fromEntries(action.fields.filter((f) => f.default).map((f) => [f.id, f.default]));
    const node = { id: localId('action'), kind: 'action', label: connector.name + ': ' + action.label, role: action.description.slice(0, 120), connector: connector.id, action: action.id, params, x, y, origin: 'operator' };
    workflow.nodes = [...workflow.nodes, node];
    selected = { type: 'node', id: node.id };
    message = 'Added ' + node.label + (anchor ? ' after ' + anchor.label + '.' : '. Wire it from an agent.');
    renderAll();
    if (anchor) connect(anchor.id, 'act', node.id, 'act', null);
    else scheduleSave();
    // Wiring selects the new cable; the node is what you are about to fill in.
    select({ type: 'node', id: node.id });
  }

  // The fields of a bound action node, and the buttons that try it. Test says what would happen and sends nothing.
  function renderConnectorPanel(node) {
    const connector = connectorOf(node.connector);
    const action = connector && connector.actions.find((a) => a.id === node.action);
    if (!connector || !action) {
      inspector.append(el(doc, 'p', { class: 'mini-label', text: 'Bound to ' + node.connector + '.' + node.action + ', which this engine does not list.' }));
      return;
    }
    inspector.append(el(doc, 'h4', { text: connector.name + ': ' + action.label }));
    if (connector.status !== 'ready') inspector.append(el(doc, 'p', { class: 'wfc-connector-note', text: STATUS_TEXT[connector.status] + '. ' + connector.status_detail }));
    node.params = node.params || {};
    for (const f of action.fields) {
      const id = 'wfc-param-' + f.id;
      const input = f.type === 'select'
        ? el(doc, 'select', { id, class: 'wfc-field', disabled: !editable }, f.options.map((o) => el(doc, 'option', { value: o, text: o })))
        : el(doc, f.type === 'longtext' ? 'textarea' : 'input', { id, class: 'wfc-field', rows: f.type === 'longtext' ? '4' : null, maxlength: '4000', placeholder: f.placeholder || '', disabled: !editable });
      input.value = node.params[f.id] !== undefined ? node.params[f.id] : f.default || '';
      input.addEventListener('change', () => updateNode(node.id, { params: { ...node.params, [f.id]: input.value } }));
      inspector.append(el(doc, 'label', { class: 'wfc-field-wrap', for: id }, [el(doc, 'span', { class: 'mini-label', text: f.label + (f.required ? ' *' : '') }), input]));
    }
    inspector.append(el(doc, 'p', { class: 'mini-label', text: '{{result}} becomes the previous step\'s answer when the workflow runs. A test uses a sample.' }));
    if (action.outward) inspector.append(el(doc, 'p', { class: 'wfc-connector-note', text: 'This reaches outside Aether, so it should come after an approval.' }));
    const result = el(doc, 'div', { class: 'wfc-test-result', role: 'status', 'aria-live': 'polite', hidden: true });
    const run = async (send) => {
      result.hidden = false;
      result.dataset.state = 'pending';
      result.textContent = send ? 'Sending…' : 'Testing…';
      try {
        const answer = await api.testConnector({ connector: node.connector, action: node.action, params: node.params, send });
        result.dataset.state = answer.ok ? 'ok' : 'fail';
        result.replaceChildren(el(doc, 'strong', { text: (answer.simulated ? 'Test: ' : '') + answer.summary }), ...(answer.detail ? [el(doc, 'p', { class: 'wfc-test-detail', text: answer.detail })] : []), ...(answer.error ? [el(doc, 'p', { class: 'wfc-test-detail', text: answer.error })] : []));
      } catch (err) {
        result.dataset.state = 'fail';
        result.textContent = (err && err.body && err.body.error) || (err && err.message) || 'The test could not run.';
      }
    };
    const test = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-test', text: 'Test (nothing is sent)' });
    test.addEventListener('click', () => run(false));
    inspector.append(test);
    if (action.live_test) {
      const live = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-test-live', text: 'Send a test to me' });
      live.addEventListener('click', () => run(true));
      inspector.append(live);
    }
    inspector.append(result);
  }

  // Where a card gets its data and where its result goes, read from the cables, in plain words. Only what a run really does:
  // an agent gets the goal and the previous agent's written answer; tools bound to it are described to it, not called.
  function renderDataFlow(node) {
    if (node.kind === 'trigger') return;
    const labelOf = (id) => (nodeById(id) || {}).label || id;
    const into = workflow.cables.filter((c) => c.to === node.id && c.kind !== 'mcp_read');
    const tools = workflow.cables.filter((c) => c.from === node.id && c.kind === 'mcp_read');
    const outOf = workflow.cables.filter((c) => c.from === node.id && c.kind !== 'mcp_read');
    const list = (title, rows, empty) => [
      el(doc, 'h4', { text: title }),
      rows.length ? el(doc, 'ul', { class: 'wfc-flow-list' }, rows.map((r) => el(doc, 'li', { text: r }))) : el(doc, 'p', { class: 'mini-label', text: empty }),
    ];
    const from = into.map((c) => {
      const source = nodeById(c.from);
      const what = source && source.kind === 'trigger' ? 'the workflow goal' : source && source.kind === 'human' ? 'your approval' : 'its written answer';
      return labelOf(c.from) + ': ' + what;
    });
    const toRows = outOf.map((c) => labelOf(c.to) + ' (' + CABLE_TEXT[c.kind] + ')');
    inspector.append(...list('Where its data comes from', from, node.kind === 'mcp' ? 'An MCP server is a source the agents read.' : 'Nothing is wired into this card yet.'));
    if (node.kind === 'agent') {
      inspector.append(...list('Tools it can read', tools.map((c) => labelOf(c.to)), 'No tools are connected to this agent.'));
      inspector.append(el(doc, 'p', { class: 'mini-label', text: 'How it works: this agent is an AI following the instructions above. It gets the goal and the answer of the agent before it as text. A tool listed here is described to it, but it cannot browse, scrape or call it yet, so a step like "analyze all scraped sources" works on what an earlier step wrote, not on live data.' }));
    }
    if (node.kind !== 'mcp') inspector.append(...list('Where its result goes', toRows, 'Nothing is wired out of this card.'));
  }

  // An approval card, in plain words: what waits for you, what happens when you approve, and where to answer.
  function renderApproval(node) {
    const labelOf = (id) => (nodeById(id) || {}).label || id;
    const before = workflow.cables.filter((c) => c.to === node.id).map((c) => labelOf(c.from));
    const released = workflow.cables.filter((c) => c.from === node.id && c.kind === 'start').map((c) => c.to);
    const effects = workflow.cables.filter((c) => released.includes(c.from) && c.kind === 'action').map((c) => nodeById(c.to)).filter((n) => n && n.kind === 'action');
    const effectText = (n) => n.label + (n.connector && n.action ? ' (runs for real: ' + n.connector + ')' : ' (only proposed, not connected)');
    const status = run && run.node_status ? run.node_status[node.id] : '';
    inspector.append(
      el(doc, 'p', { class: 'mini-label', text: 'An approval checkpoint. The run stops here until you answer.' }),
      el(doc, 'h4', { text: 'What is waiting for you' }),
      el(doc, 'p', { class: 'mini-label', text: before.length ? before.join(', ') + ' finishes first, then this asks you.' : 'Nothing is wired into this approval yet.' }),
      el(doc, 'h4', { text: 'When you approve' }),
    );
    inspector.append(released.length ? el(doc, 'ul', { class: 'wfc-flow-list' }, released.map((id) => el(doc, 'li', { text: labelOf(id) + ' continues.' })).concat(effects.map((n) => el(doc, 'li', { text: effectText(n) })))) : el(doc, 'p', { class: 'mini-label', text: 'Nothing continues after it.' }));
    inspector.append(el(doc, 'h4', { text: 'How to approve' }));
    const waiting = status === 'running' && run && run.status === 'RUNNING';
    if (waiting) {
      // The run is paused on this card: answer it here (the same answer the Runs page and Telegram give).
      const note = el(doc, 'p', { class: 'wfc-connector-note', text: 'Waiting for you now.' });
      const answer = async (option) => {
        approve.disabled = stop.disabled = true;
        try {
          await api.answerTaskChoice(run.agent_id, run.task_id, option);
          note.textContent = option === 1 ? 'Approved. The run is continuing.' : 'Stopped.';
          startPolling(false);
        } catch (err) {
          approve.disabled = stop.disabled = false;
          note.textContent = err && err.status === 409 ? 'Already answered somewhere else.' : 'Could not send the answer. Try the Runs page.';
        }
      };
      const approve = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-approve', text: 'Approve and continue' });
      const stop = el(doc, 'button', { type: 'button', class: 'btn btn-small btn-danger-lite', text: 'Stop the run here' });
      approve.addEventListener('click', () => answer(1));
      stop.addEventListener('click', () => answer(2));
      inspector.append(note, approve, stop);
    }
    const open = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: waiting ? 'Open it in Runs' : 'Where approvals are answered' });
    open.addEventListener('click', () => { win.location.hash = 'operator'; });
    inspector.append(open);
  }

  // Everything not ready, one line each; tapping a line opens that card. Run goes ahead only when you say so.
  function renderSetupPanel() {
    const issues = readiness();
    const close = el(doc, 'button', { type: 'button', class: 'btn btn-small inspector-close', text: 'Close' });
    close.addEventListener('click', () => {
      setupOpen = false;
      renderInspector();
    });
    inspector.append(el(doc, 'div', { class: 'inspector-head' }, [el(doc, 'h3', { text: 'Before you run' }), close]));
    inspector.append(el(doc, 'p', { class: 'mini-label', text: issues.length ? issues.length + (issues.length === 1 ? ' thing is' : ' things are') + ' not set up. Steps that are not connected are only proposed, nothing is sent or changed by them.' : 'Everything is set up.' }));
    for (const issue of issues) {
      const row = el(doc, 'button', { type: 'button', class: 'wfc-setup-row' }, [el(doc, 'strong', { text: issue.label }), el(doc, 'span', { text: issue.problem }), el(doc, 'span', { class: 'mini-label', text: issue.fix })]);
      row.addEventListener('click', () => {
        setupOpen = false;
        select({ type: 'node', id: issue.node_id });
      });
      inspector.append(row);
    }
    const go = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: issues.length ? 'Run anyway' : 'Run' });
    go.addEventListener('click', () => {
      setupOpen = false;
      renderInspector();
      startRun();
    });
    inspector.append(go);
  }

  function renderInspector() {
    inspector.replaceChildren();
    // It floats over the canvas only while something is selected; otherwise the canvas has the whole width.
    inspector.hidden = Boolean(workflow) && !selected && !setupOpen;
    if (!workflow) {
      inspector.append(
        el(doc, 'h3', { text: 'Workflow console' }),
        el(doc, 'p', { class: 'mini-label', text: 'Generated workflows appear here: a trigger, agents that hand work to each other (A2A), the MCP servers they read, and actions behind human approvals.' }),
      );
      return;
    }
    const node = selected && selected.type === 'node' ? nodeById(selected.id) : null;
    const cable = selected && selected.type === 'cable' ? cableById(selected.id) : null;
    if (setupOpen && !node && !cable) {
      renderSetupPanel();
      return;
    }
    const close = el(doc, 'button', { type: 'button', class: 'btn btn-small inspector-close', text: 'Close', 'aria-label': 'Close the inspector' });
    close.addEventListener('click', () => select(null));
    if (node) {
      inspector.append(el(doc, 'div', { class: 'inspector-head' }, [el(doc, 'h3', { text: KIND_TEXT[node.kind] }), close]));
      const field = (label, key, multiline, max) => {
        const id = 'wfc-field-' + key;
        const input = el(doc, multiline ? 'textarea' : 'input', { id, class: 'wfc-field', maxlength: String(max), rows: multiline ? '5' : null, disabled: !editable });
        input.value = node[key] || '';
        input.addEventListener('change', () => {
          const value = input.value.trim();
          if (key === 'label' && !value) {
            input.value = node.label;
            return;
          }
          updateNode(node.id, { [key]: value });
        });
        return el(doc, 'label', { class: 'wfc-field-wrap', for: id }, [el(doc, 'span', { class: 'mini-label', text: label }), input]);
      };
      inspector.append(field('Name', 'label', false, 80));
      if (node.kind !== 'mcp') inspector.append(field(node.kind === 'agent' ? 'Role' : 'Note', 'role', false, 120));
      if (node.kind === 'agent') inspector.append(field('Instructions', 'instructions', true, 2000));
      if (node.kind === 'mcp') inspector.append(el(doc, 'p', { class: 'mini-label', text: 'MCP server "' + (node.server || node.label) + '" from the engine\'s mcp-config.json. Agents get its description as context; tool calls are not made by this run.' }));
      const needs = issuesFor(readiness(), node.id);
      if (needs.length) inspector.append(el(doc, 'h4', { text: 'Needs setup' }), ...needs.map((i) => el(doc, 'p', { class: 'wfc-connector-note', text: i.problem + ' ' + i.fix + '.' })));
      renderDataFlow(node);
      if (node.kind === 'action' && node.connector) renderConnectorPanel(node);
      else if (node.kind === 'action') inspector.append(el(doc, 'p', { class: 'mini-label', text: 'Actions are proposed by the agent that acts on them. They are never executed automatically.' }));
      if (node.kind === 'human') renderApproval(node);
      const meta = [['Id', node.id], ['Origin', node.origin === 'operator' ? 'Edited by you' : node.origin === 'prompt' ? 'Added by a prompt' : 'Generated']];
      if (run && run.node_status && run.node_status[node.id]) meta.push(['Last run', RUN_TEXT[run.node_status[node.id]]]);
      inspector.append(el(doc, 'dl', { class: 'inspector-meta' }, meta.flatMap(([k, v]) => [el(doc, 'dt', { text: k }), el(doc, 'dd', { text: v })])));
      if (node.kind === 'agent') {
        const index = workflow.nodes.filter((n) => n.kind === 'agent').findIndex((n) => n.id === node.id) + 1;
        const tweak = el(doc, 'button', { type: 'button', class: 'btn btn-small wfc-tweak', title: 'Save your edits, then run the workflow again', disabled: !editable || busy, text: '🔄 Tweak & Rerun Node' });
        tweak.addEventListener('click', () => startRun());
        inspector.append(stepChatMenu(doc, index, node.label), tweak);
      }
      if (editable && node.kind !== 'trigger') {
        const remove = el(doc, 'button', { type: 'button', class: 'btn btn-small btn-danger-lite', text: 'Remove ' + KIND_TEXT[node.kind].toLowerCase() });
        remove.addEventListener('click', () => removeNode(node.id));
        inspector.append(remove);
      }
      return;
    }
    if (cable) {
      inspector.append(
        el(doc, 'div', { class: 'inspector-head' }, [el(doc, 'h3', { text: CABLE_TEXT[cable.kind] + ' cable' }), close]),
        el(doc, 'p', { class: 'inspector-route' }, [el(doc, 'strong', { text: (nodeById(cable.from) || {}).label || cable.from }), ' · ' + PORT_TEXT[cable.from_port] + ' → ', el(doc, 'strong', { text: (nodeById(cable.to) || {}).label || cable.to }), ' · ' + PORT_TEXT[cable.to_port]]),
        el(doc, 'p', { class: 'mini-label', text: cable.kind === 'mcp_read' ? 'Read-only tool context for the agent.' : cable.kind === 'a2a' ? 'Agent-to-agent hand-off: the next agent builds on this one\'s work.' : cable.kind === 'action' ? 'A side effect or approval request. Proposed only, never executed automatically.' : 'Starts the agent.' }),
        el(doc, 'dl', { class: 'inspector-meta' }, [['Id', cable.id], ['Origin', cable.origin === 'operator' ? 'Wired by you' : cable.origin === 'prompt' ? 'Added by a prompt' : 'Generated']].flatMap(([k, v]) => [el(doc, 'dt', { text: k }), el(doc, 'dd', { text: v })])),
      );
      if (editable) {
        const remove = el(doc, 'button', { type: 'button', class: 'btn btn-small btn-danger-lite', text: 'Remove cable' });
        remove.addEventListener('click', () => removeCable(cable.id));
        inspector.append(remove);
      }
      return;
    }
    inspector.append(el(doc, 'h3', { text: workflow.title }), el(doc, 'p', { class: 'wfc-goal', text: workflow.goal }));
    if (run) {
      inspector.append(el(doc, 'h4', { text: 'Last run' }), el(doc, 'p', { class: 'mini-label', text: run.status.charAt(0) + run.status.slice(1).toLowerCase() + (run.error ? ': ' + run.error : '') + ' · ' + new Date(run.started_at).toLocaleTimeString() }));
    }
    inspector.append(el(doc, 'h4', { text: 'Changes' }));
    inspector.append(
      el(doc, 'ol', { class: 'wfc-history' }, workflow.history.slice(-6).reverse().map((h) => el(doc, 'li', {}, [el(doc, 'span', { class: 'wfc-source', 'data-source': h.source, text: SOURCE_TEXT[h.source] || h.source }), ' v' + h.version + ' · ' + h.summary]))),
    );
  }

  function renderAll() {
    renderToolbox();
    renderCommand();
    renderToolbar();
    renderStatus();
    renderBanner();
    renderCanvas();
    renderInspector();
  }

  // Moves one node and redraws only its cables (drag and arrow keys).
  function moveNode(id, x, y) {
    const node = nodeById(id);
    if (!node) return;
    node.x = Math.max(0, x);
    node.y = Math.max(0, y);
    const card = nodeEl(id);
    if (card) {
      card.style.left = node.x + 'px';
      card.style.top = node.y + 'px';
    }
    for (const cable of workflow.cables) {
      if (cable.from !== id && cable.to !== id) continue;
      const old = cableEl(cable.id);
      if (old) old.replaceWith(renderCable(cable));
    }
  }

  // ---- loading and saving -------------------------------------------------------------------------------------
  // Positions every node (new ones are auto-arranged); ids in `previous` that are missing count as new.
  function adopt(next, previous) {
    const prevNodes = previous ? new Map(previous.nodes.map((n) => [n.id, n])) : null;
    const prevCables = previous ? new Set(previous.cables.map((c) => c.id)) : null;
    // Keep positions this browser already shows for nodes the engine has no position for yet.
    const nodes = next.nodes.map((n) => (Number.isFinite(n.x) && Number.isFinite(n.y)) || !prevNodes || !prevNodes.has(n.id) ? { ...n } : { ...n, x: prevNodes.get(n.id).x, y: prevNodes.get(n.id).y });
    workflow = { ...next, nodes: autoLayout({ nodes, cables: next.cables }) };
    if (previous && previous.workflow_id === next.workflow_id) {
      const t = now();
      for (const n of next.nodes) if (!prevNodes.has(n.id)) fresh.set(n.id, t);
      for (const c of next.cables) if (!prevCables.has(c.id)) fresh.set(c.id, t);
      if (fresh.size) setTimeout(() => {
        for (const [id, at] of fresh) if (now() - at >= NEW_FLAG_MS - 50) fresh.delete(id);
        for (const n of nodeLayer.querySelectorAll('.wfc-node[data-new="true"], .wfc-cable[data-new="true"]')) n.setAttribute('data-new', 'false');
        for (const n of cableGroup.querySelectorAll('.wfc-cable[data-new="true"]')) n.setAttribute('data-new', 'false');
      }, NEW_FLAG_MS);
    }
    if (selected && !(selected.type === 'node' ? nodeById(selected.id) : cableById(selected.id))) selected = null;
    const listed = list.find((w) => w.workflow_id === next.workflow_id);
    const item = { workflow_id: next.workflow_id, title: next.title, goal: next.goal, version: next.version, updated_at: next.updated_at, agents: next.nodes.filter((n) => n.kind === 'agent').length, run_status: next.run ? next.run.status : null };
    list = listed ? list.map((w) => (w.workflow_id === next.workflow_id ? item : w)) : [item, ...list];
  }

  async function loadList() {
    try {
      const result = await api.listWorkflows();
      list = result.workflows || [];
      error = null;
    } catch (err) {
      error = describeError(err, 'Could not load workflows');
    }
    loaded = true;
  }

  async function open(id) {
    if (!id) return;
    stopPolling();
    clearPulses();
    try {
      const next = await api.getWorkflow(id);
      selected = null;
      camTouched = false;
      adopt(next, null);
      run = next.run ? { ...next.run } : null;
      lastSeq = 0;
      error = null;
      message = '';
      mode = 'change';
      if (run && run.status === 'RUNNING') startPolling(true);
    } catch (err) {
      error = describeError(err, 'Could not open the workflow');
    }
    renderAll();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), options.saveDelayMs ?? SAVE_DELAY_MS);
    renderToolbar();
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!workflow) return;
    if (saving) {
      saveAgain = true;
      return saving;
    }
    const sent = workflow;
    const graph = graphForSave(sent.nodes, sent.cables);
    saving = (async () => {
      try {
        const saved = await api.saveWorkflowGraph(sent.workflow_id, sent.version, graph.nodes, graph.cables);
        if (workflow && workflow.workflow_id === saved.workflow_id) {
          // Keep what the operator sees (they may have moved on), take the engine's version and history.
          workflow = { ...workflow, version: saved.version, history: saved.history, updated_at: saved.updated_at, cables: workflow.cables.map((c) => saved.cables.find((s) => s.id === c.id) || c) };
          adopt(workflow, null);
        }
        error = null;
        message = 'Saved v' + saved.version + ' to Aether_Engine.';
      } catch (err) {
        if (err && err.status === 409 && err.body && err.body.workflow) {
          adopt(err.body.workflow, null);
          message = 'This workflow changed on the engine (v' + err.body.workflow.version + '), so the latest version was loaded. Your last edit was not saved; make it again if you still need it.';
          saveAgain = false;
          renderAll();
        } else {
          error = describeError(err, 'Could not save your change');
        }
      } finally {
        saving = null;
        renderToolbar();
        renderStatus();
        renderInspector();
      }
      if (saveAgain) {
        saveAgain = false;
        await save();
      }
    })();
    renderToolbar();
    return saving;
  }

  // ---- operator edits -----------------------------------------------------------------------------------------
  function updateNode(id, changes) {
    const node = nodeById(id);
    if (!node) return;
    Object.assign(node, changes, { origin: 'operator' });
    renderCanvas();
    renderInspector();
    scheduleSave();
  }

  function removeNode(id) {
    const node = nodeById(id);
    if (!node || node.kind === 'trigger') return;
    workflow.nodes = workflow.nodes.filter((n) => n.id !== id);
    workflow.cables = workflow.cables.filter((c) => c.from !== id && c.to !== id);
    selected = null;
    message = 'Removed ' + node.label + '.';
    renderAll();
    scheduleSave();
  }

  function removeCable(id) {
    const cable = cableById(id);
    if (!cable) return;
    workflow.cables = workflow.cables.filter((c) => c.id !== id);
    selected = null;
    message = 'Removed the ' + CABLE_TEXT[cable.kind] + ' cable.';
    renderAll();
    scheduleSave();
  }

  // Wires an output port to an input port. Returns { kind } or { error } (shown as an inline tip).
  function connect(fromId, fromPort, toId, toPort, anchor) {
    if (!workflow || !editable) return { error: 'Turn on editing to wire nodes.' };
    const result = checkConnect(workflow, fromId, fromPort, toId, toPort);
    if (result.error) {
      showTip(result.error, anchor);
      return result;
    }
    const cable = { id: localId('c'), from: fromId, from_port: fromPort, to: toId, to_port: toPort, kind: result.kind, origin: 'operator' };
    workflow.cables = workflow.cables.concat(cable);
    fresh.set(cable.id, now());
    selected = { type: 'cable', id: cable.id };
    message = 'Connected ' + cableLabel(cable, workflow.nodes).replace(/^./, (c) => c.toLowerCase()) + '.';
    showTip('');
    renderAll();
    scheduleSave();
    return result;
  }

  function select(next) {
    selected = next;
    for (const n of nodeLayer.querySelectorAll('.wfc-node')) n.setAttribute('data-selected', String(Boolean(next && next.type === 'node' && n.getAttribute('data-node') === next.id)));
    for (const c of cableGroup.querySelectorAll('.wfc-cable')) c.setAttribute('data-selected', String(Boolean(next && next.type === 'cable' && c.getAttribute('data-cable') === next.id)));
    renderInspector();
  }

  // ---- command bar ----------------------------------------------------------------------------------------------
  async function command(text) {
    const value = String(text || '').trim();
    if (!value || busy) return;
    const changing = mode === 'change' && workflow;
    setBusy(true);
    message = changing ? 'Asking Aether_Engine to change the workflow…' : 'Aether_Engine is designing the workflow…';
    error = null;
    renderCommand();
    renderStatus();
    try {
      if (changing) {
        if (saving) await saving;
        const previous = workflow;
        const result = await api.mutateWorkflow(previous.workflow_id, value, previous.version);
        adopt(result.workflow, previous);
        message = result.summary + (result.skipped && result.skipped.length ? ' Skipped: ' + result.skipped.map((s) => s.reason).join(' ') : '') + ' (' + SOURCE_TEXT[result.source] + ')' + (result.note ? ' ' + result.note : '');
      } else {
        stopPolling();
        clearPulses();
        const result = await api.generateWorkflow(value);
        run = null;
        lastSeq = 0;
        selected = null;
        adopt(result.workflow, null);
        mode = 'change';
        const agents = result.workflow.nodes.filter((n) => n.kind === 'agent').length;
        message = 'Generated "' + result.workflow.title + '" with ' + agents + ' agent' + (agents === 1 ? '' : 's') + ' (' + SOURCE_TEXT[result.source] + ').' + (result.note ? ' ' + result.note : '');
      }
      prompt.value = '';
    } catch (err) {
      if (err && err.status === 409 && err.body && err.body.workflow) {
        adopt(err.body.workflow, null);
        message = 'The workflow changed on the engine, so the latest version was loaded. Send the change again.';
      } else if (err && err.status === 422) {
        const reasons = err.body && Array.isArray(err.body.skipped) ? err.body.skipped.map((s) => s.reason).join(' ') : '';
        error = { text: err.message + (reasons ? ' ' + reasons : ''), connect: false };
        message = '';
      } else {
        error = describeError(err, changing ? 'Could not change the workflow' : 'Could not generate a workflow');
        message = '';
      }
    } finally {
      setBusy(false);
      renderAll();
    }
  }

  // ---- runs, events and pulses ----------------------------------------------------------------------------------
  async function startRun() {
    if (!workflow || busy) return;
    if (saving || saveTimer) await save();
    clearPulses();
    frozen = false;
    try {
      const result = await api.runWorkflow(workflow.workflow_id);
      run = { ...result.run };
      lastSeq = 0;
      error = null;
      message = 'Running on Aether_Engine…';
      renderAll();
      startPolling(false);
    } catch (err) {
      error = err && err.status === 422 ? { text: err.message, connect: false } : describeError(err, 'Could not start the run');
      renderStatus();
    }
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function startPolling(catchUp) {
    stopPolling();
    const tick = async () => {
      if (destroyed || !workflow) return;
      const id = workflow.workflow_id;
      try {
        const result = await api.getWorkflowEvents(id, lastSeq);
        if (!workflow || workflow.workflow_id !== id) return;
        applyEvents(result.events || [], catchUp);
        catchUp = false;
        if (result.run) run = { ...run, ...result.run };
        renderToolbar();
        renderBanner();
        if (run && run.status !== 'RUNNING') {
          message = run.status === 'COMPLETED' ? 'Run finished.' + (lastRunSummary ? ' ' + lastRunSummary : '') : run.status === 'HALTED' ? 'Run halted by the circuit breaker.' : 'Run failed: ' + (run.error || 'see Run history') + '.';
          renderStatus();
          renderInspector();
          return;
        }
      } catch (err) {
        error = describeError(err, 'Lost the run events');
        renderStatus();
      }
      if (active) pollTimer = setTimeout(tick, pollMs);
    };
    tick();
  }

  function applyEvents(events, catchUp) {
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq);
      if (event.type === 'node_status' && event.node_id) {
        if (!run.node_status) run.node_status = {};
        run.node_status[event.node_id] = event.status;
        const card = nodeEl(event.node_id);
        if (card) {
          const updated = renderNode(nodeById(event.node_id));
          card.replaceWith(updated);
          if (event.summary && !catchUp) badge(updated, event.summary);
        }
      } else if (event.type === 'flow' && event.cable_id) {
        // Old events seen when reopening a running workflow are applied without animation.
        if (!catchUp) pulse(event.cable_id, event.summary);
      } else if (event.type === 'run_status') {
        run.status = event.status;
        lastRunSummary = event.summary || '';
        if (event.status === 'HALTED') freeze();
      }
    }
  }

  function badge(card, text) {
    const b = el(doc, 'span', { class: 'wfc-badge', text });
    card.append(b);
    setTimeout(() => b.remove(), BADGE_MS);
  }

  // One pulse along a cable (or a 300ms thickening under reduced motion). Extra events beyond the cap count on a badge.
  function pulse(cableId, summary) {
    const cable = cableById(cableId);
    const group = cableEl(cableId);
    if (!cable || !group) return false;
    if (reducedMotion) {
      group.setAttribute('data-flash', 'true');
      setTimeout(() => group.setAttribute('data-flash', 'false'), 300);
      if (summary) {
        const card = nodeEl(cable.to);
        if (card) badge(card, summary);
      }
      return true;
    }
    if (pulses.filter((p) => p.cableId === cableId).length >= MAX_PULSES_PER_CABLE) {
      overflow.set(cableId, (overflow.get(cableId) || 0) + 1);
      renderOverflow(cableId);
      return false;
    }
    const halo = svg(doc, 'circle', { class: 'wfc-pulse-halo', r: '14', 'data-kind': cable.kind });
    const dot = svg(doc, 'circle', { class: 'wfc-pulse', r: '3', 'data-kind': cable.kind });
    pulseGroup.append(halo, dot);
    pulses.push({ cableId, start: now(), dot, halo, summary, to: cable.to });
    if (!animating) {
      animating = true;
      raf(frame);
    }
    return true;
  }

  function renderOverflow(cableId) {
    const count = overflow.get(cableId) || 0;
    const existing = pulseGroup.querySelector('.wfc-overflow[data-cable="' + cssEscape(cableId) + '"]');
    if (existing) existing.remove();
    const cable = cableById(cableId);
    const pts = cable && ends(cable);
    if (!count || !pts) return;
    const mid = cablePoint(pts[0], pts[1], 0.5);
    const text = svg(doc, 'text', { class: 'wfc-overflow', 'data-cable': cableId, x: mid.x, y: mid.y - 10, 'text-anchor': 'middle' });
    text.textContent = '+' + count;
    pulseGroup.append(text);
  }

  function frame() {
    if (frozen || destroyed) {
      animating = false;
      return;
    }
    const t0 = now();
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const cable = cableById(p.cableId);
      const pts = cable && ends(cable);
      const t = (t0 - p.start) / PULSE_MS;
      if (!pts || t >= 1) {
        p.dot.remove();
        p.halo.remove();
        pulses.splice(i, 1);
        if (pts && p.summary) {
          const card = nodeEl(p.to);
          if (card) badge(card, p.summary);
        }
        if (!pulses.some((q) => q.cableId === p.cableId) && overflow.has(p.cableId)) {
          overflow.delete(p.cableId);
          renderOverflow(p.cableId);
        }
        continue;
      }
      const pos = cablePoint(pts[0], pts[1], ease(t));
      for (const c of [p.dot, p.halo]) {
        c.setAttribute('cx', pos.x.toFixed(1));
        c.setAttribute('cy', pos.y.toFixed(1));
      }
    }
    if (pulses.length) raf(frame);
    else animating = false;
  }

  function freeze() {
    frozen = true;
    for (const p of pulses) {
      p.dot.setAttribute('data-frozen', 'true');
      p.halo.setAttribute('data-frozen', 'true');
    }
  }

  function clearPulses() {
    for (const p of pulses) {
      p.dot.remove();
      p.halo.remove();
    }
    pulses.length = 0;
    overflow.clear();
    pulseGroup.replaceChildren();
    frozen = false;
  }

  // ---- pointer: node drag and port wiring -------------------------------------------------------------------------
  let drag = null;
  let wiring = null;

  const stagePoint = (event) => {
    const rect = stage.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / cam.k, y: (event.clientY - rect.top) / cam.k };
  };

  function markCompatible(fromId, fromPort) {
    const ok = new Set(compatibleTargets(workflow, fromId, fromPort).map((t) => t.node.id + '|' + t.port));
    for (const port of nodeLayer.querySelectorAll('.wfc-port[data-dir="in"]')) {
      const id = port.closest('.wfc-node').getAttribute('data-node');
      port.setAttribute('data-compat', String(ok.has(id + '|' + port.getAttribute('data-port'))));
    }
    container.setAttribute('data-wiring', 'true');
  }

  function clearCompatible() {
    for (const port of nodeLayer.querySelectorAll('.wfc-port[data-compat]')) port.removeAttribute('data-compat');
    container.removeAttribute('data-wiring');
    ghost.setAttribute('d', '');
  }

  nodeLayer.addEventListener('pointerdown', (event) => {
    if (!workflow || event.button > 0) return;
    const port = event.target.closest && event.target.closest('.wfc-port');
    const card = event.target.closest && event.target.closest('.wfc-node');
    if (!card) return;
    const id = card.getAttribute('data-node');
    // A tap (press and release without moving) opens the node's details, whether or not editing is on.
    tap = { id, x: event.clientX, y: event.clientY };
    if (port && port.getAttribute('data-dir') === 'out' && editable) {
      tap = null;
      event.preventDefault();
      wiring = { from: id, port: port.getAttribute('data-port'), anchor: port };
      markCompatible(id, wiring.port);
      return;
    }
    if (event.target.closest('.wfc-node-head') && editable) {
      const node = nodeById(id);
      tap = null;
      drag = { id, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y, moved: false };
      card.setAttribute('data-dragging', 'true');
      if (card.setPointerCapture && event.pointerId !== undefined) {
        try { card.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
      }
    }
  });

  const onPointerMove = (event) => {
    if (drag) {
      const dx = (event.clientX - drag.startX) / cam.k;
      const dy = (event.clientY - drag.startY) / cam.k;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4 / cam.k) return;
      drag.moved = true;
      moveNode(drag.id, snap(drag.x + dx), snap(drag.y + dy));
    } else if (wiring) {
      const from = nodeById(wiring.from);
      const a = from && portPoint(from, 'out', wiring.port);
      if (a) ghost.setAttribute('d', cablePath(a, stagePoint(event)));
    }
  };

  const onPointerUp = (event) => {
    if (tap) {
      const t = tap;
      tap = null;
      if (!drag && !wiring && Math.hypot(event.clientX - t.x, event.clientY - t.y) < 8 && nodeById(t.id)) select({ type: 'node', id: t.id });
    }
    if (drag) {
      const card = nodeEl(drag.id);
      if (card) card.removeAttribute('data-dragging');
      if (drag.moved) {
        const node = nodeById(drag.id);
        node.origin = 'operator';
        message = 'Moved ' + node.label + '.';
        renderStatus();
        scheduleSave();
      } else {
        select({ type: 'node', id: drag.id });
      }
      drag = null;
      return;
    }
    if (wiring) {
      const hit = doc.elementFromPoint ? doc.elementFromPoint(event.clientX, event.clientY) : event.target;
      const port = hit && hit.closest ? hit.closest('.wfc-port[data-dir="in"]') : null;
      const w = wiring;
      wiring = null;
      clearCompatible();
      if (port) connect(w.from, w.port, port.closest('.wfc-node').getAttribute('data-node'), port.getAttribute('data-port'), port);
    }
  };
  win.addEventListener('pointermove', onPointerMove);
  win.addEventListener('pointerup', onPointerUp);

  // ---- keyboard ---------------------------------------------------------------------------------------------------
  function openConnectMenu(fromId, fromPort, anchor) {
    const from = nodeById(fromId);
    const targets = compatibleTargets(workflow, fromId, fromPort);
    menu.replaceChildren(el(doc, 'p', { class: 'wfc-menu-title', text: 'Connect ' + from.label + ' · ' + PORT_TEXT[fromPort] + ' to…' }));
    if (!targets.length) menu.append(el(doc, 'p', { class: 'mini-label', text: 'Nothing can take this output yet.' }));
    for (const t of targets) {
      const btn = el(doc, 'button', { type: 'button', class: 'wfc-menu-item', text: t.node.label + ' · ' + PORT_TEXT[t.port] + ' (' + CABLE_TEXT[t.kind] + ')' });
      btn.addEventListener('click', () => {
        closeMenu();
        connect(fromId, fromPort, t.node.id, t.port, null);
      });
      menu.append(btn);
    }
    const cancel = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: 'Cancel' });
    cancel.addEventListener('click', () => closeMenu(anchor));
    menu.append(cancel);
    menu.hidden = false;
    menu.anchor = anchor;
    const first = menu.querySelector('button');
    if (first && options.focusMenu !== false) first.focus();
  }

  function closeMenu(returnFocus) {
    menu.hidden = true;
    menu.replaceChildren();
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }

  container.addEventListener('keydown', (event) => {
    const t = event.target;
    // + and - zoom, 0 frames the whole flow (not while typing in a field).
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !(t.closest && t.closest('input, textarea, select'))) {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); return zoomCentre(1.25); }
      if (event.key === '-' || event.key === '_') { event.preventDefault(); return zoomCentre(0.8); }
      if (event.key === '0') { event.preventDefault(); return fitView(); }
    }
    if (event.key === 'Escape') {
      if (!menu.hidden) closeMenu(menu.anchor);
      else if (selected) select(null);
      return;
    }
    if (t === prompt && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      command(prompt.value);
      return;
    }
    if (!workflow || t.closest('.wfc-inspector') || t === prompt) return;
    if (t.classList.contains('wfc-port') && t.getAttribute('data-dir') === 'out' && (event.key === 'Enter' || event.key === ' ') && editable) {
      event.preventDefault();
      openConnectMenu(t.closest('.wfc-node').getAttribute('data-node'), t.getAttribute('data-port'), t);
      return;
    }
    if (t.classList.contains('wfc-node-head')) {
      const id = t.closest('.wfc-node').getAttribute('data-node');
      const node = nodeById(id);
      const step = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[event.key];
      if (step && editable) {
        event.preventDefault();
        moveNode(id, node.x + step[0], node.y + step[1]);
        node.origin = 'operator';
        scheduleSave();
        nodeEl(id).querySelector('.wfc-node-head').focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select({ type: 'node', id });
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && editable) {
        event.preventDefault();
        removeNode(id);
      }
      return;
    }
    if (t.classList.contains('wfc-hit')) {
      const id = t.closest('.wfc-cable').getAttribute('data-cable');
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select({ type: 'cable', id });
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && editable) {
        event.preventDefault();
        removeCable(id);
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected && editable && !t.closest('input, textarea, select')) {
      event.preventDefault();
      if (selected.type === 'node') removeNode(selected.id);
      else removeCable(selected.id);
    }
  });

  cableGroup.addEventListener('click', (event) => {
    const g = event.target.closest && event.target.closest('.wfc-cable');
    if (g) select({ type: 'cable', id: g.getAttribute('data-cable') });
  });

  // ---- toolbar and form ---------------------------------------------------------------------------------------------
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    command(prompt.value);
  });
  newBtn.addEventListener('click', () => {
    mode = mode === 'change' ? 'generate' : 'change';
    renderCommand();
    prompt.focus();
  });
  picker.addEventListener('change', () => open(picker.value));
  arrangeBtn.addEventListener('click', () => {
    if (!workflow || !editable) return;
    workflow = { ...workflow, nodes: autoLayout(workflow, { force: true }) };
    camTouched = false;
    message = 'Auto-arranged. Positions saved.';
    renderAll();
    scheduleSave();
  });
  editBtn.addEventListener('click', () => {
    editable = !editable;
    renderAll();
  });
  runBtn.addEventListener('click', () => {
    if (workflow && readiness().length && !run) {
      selected = null;
      setupOpen = true;
      renderAll();
      return;
    }
    startRun();
  });

  renderAll();

  return {
    // The Studio view calls this when it is shown or hidden; event polling only runs while it is visible.
    async setActive(next) {
      active = Boolean(next);
      if (!active) {
        stopPolling();
        return;
      }
      if (!loaded) {
        loadConnectors();
        await loadList();
        if (list.length) await open(list[0].workflow_id);
        else renderAll();
      } else if (run && run.status === 'RUNNING') startPolling(true);
      // Shown now (it had no size while hidden): frame the flow unless the view was moved by hand.
      raf(() => { if (!camTouched) fitView(); });
    },
    command,
    connect,
    open,
    // The workflow list again (a project's map was made since it was loaded).
    async refreshList() {
      await loadList();
      renderToolbar();
    },
    save,
    run: startRun,
    pulse,
    select,
    removeNode,
    removeCable,
    setEditable(next) {
      editable = Boolean(next);
      renderAll();
    },
    getState: () => ({ workflow, selected, mode, run, lastSeq, error, message, editable, pulses: pulses.length, overflow: Object.fromEntries(overflow), frozen }),
    destroy() {
      destroyed = true;
      hintEl.remove();
      if (sizeWatch) sizeWatch.disconnect();
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('pointerup', onPointerUp);
      stopPolling();
      clearTimeout(saveTimer);
      clearPulses();
    },
  };
}
