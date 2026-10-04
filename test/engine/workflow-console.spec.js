// Studio Workflow console (public/js/engine/workflow-console.js + workflow-model.js) in happy-dom against a simulated
// Aether_Engine (/api/workflows*), through the real engine client bundle.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { MAX_PULSES_PER_CABLE, PULSE_MS, mountWorkflowConsole } from '../../public/js/engine/workflow-console.js';
import { NODE_W, autoLayout, cableKindFor, cablePoint, checkConnect, compatibleTargets, ease, graphForSave, snap } from '../../public/js/engine/workflow-model.js';

const node = (id, kind, label, extra = {}) => ({ id, kind, label, x: null, y: null, origin: 'generated', ...extra });
const cable = (id, from, from_port, to, to_port, kind) => ({ id, from, from_port, to, to_port, kind, origin: 'generated' });

function sampleWorkflow(version = 1) {
  return {
    workflow_id: 'wf_0000beef',
    requested_by: 'local-ipc',
    title: 'Launch page',
    goal: 'Research pricing, write a landing page and deploy it',
    version,
    created_at: '2026-10-03T20:00:00.000Z',
    updated_at: '2026-10-03T20:00:00.000Z',
    nodes: [
      node('trigger_1', 'trigger', 'Manual start'),
      node('agent_r', 'agent', 'Researcher', { role: 'Gathers facts' }),
      node('agent_b', 'agent', 'Builder', { role: 'Builds the page', instructions: 'Write it.' }),
      node('mcp_n', 'mcp', 'notion', { server: 'notion', role: 'knowledge' }),
      node('action_d', 'action', 'Deploy'),
    ],
    cables: [
      cable('c_1', 'trigger_1', 'start', 'agent_r', 'start', 'start'),
      cable('c_2', 'agent_r', 'a2a', 'agent_b', 'a2a', 'a2a'),
      cable('c_3', 'agent_r', 'mcp', 'mcp_n', 'read', 'mcp_read'),
      cable('c_4', 'agent_b', 'act', 'action_d', 'act', 'action'),
    ],
    history: [{ at: '2026-10-03T20:00:00.000Z', version: 1, source: 'planner', summary: 'Generated 2 agents from the goal.' }],
    run: null,
  };
}

// A small stateful engine: version checks on save and mutate, a queue of run events.
function engine({ workflows = [sampleWorkflow()], events = [] } = {}) {
  const state = { workflows: workflows.map((w) => structuredClone(w)), events, runStatus: 'RUNNING', calls: [], conflictNext: false };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ method: init.method, pathname, body });
    const m = /^\/api\/workflows(?:\/([^/]+))?(?:\/(mutate|graph|run|events))?$/.exec(pathname);
    if (!m) return json({ error: 'Not found' }, 404);
    const [, id, action] = m;
    const wf = id && state.workflows.find((w) => w.workflow_id === id);
    if (!id && init.method === 'GET') return json({ workflows: state.workflows.map((w) => ({ workflow_id: w.workflow_id, title: w.title, goal: w.goal, version: w.version, updated_at: w.updated_at, agents: w.nodes.filter((n) => n.kind === 'agent').length, run_status: null })) });
    if (!id && init.method === 'POST') {
      const created = { ...sampleWorkflow(), workflow_id: 'wf_00000new', title: 'Generated', goal: body.goal };
      state.workflows.unshift(created);
      return json({ workflow: created, source: 'planner', note: 'Sandbox mode: laid out by the built-in planner (no model call).' }, 201);
    }
    if (!wf) return json({ error: 'No workflow with that id.' }, 404);
    if (!action) return json(wf);
    if (action === 'graph') {
      if (state.conflictNext || body.base_version !== wf.version) {
        state.conflictNext = false;
        wf.version += 1;
        wf.nodes = wf.nodes.concat(node('agent_x', 'agent', 'Someone else'));
        return json({ error: 'The workflow changed since you loaded it.', workflow: wf }, 409);
      }
      wf.version += 1;
      wf.nodes = body.nodes;
      wf.cables = body.cables;
      wf.history = wf.history.concat({ at: 'now', version: wf.version, source: 'operator', summary: 'Operator edit.' });
      return json(wf);
    }
    if (action === 'mutate') {
      if (body.base_version !== wf.version) return json({ error: 'stale', workflow: wf }, 409);
      if (/approval/.test(body.prompt)) return json({ error: 'None of the requested changes could be applied.', skipped: [{ op: { op: 'add_approval' }, reason: 'Builder already waits for an approval.' }], note: '' }, 422);
      wf.version += 1;
      wf.nodes = wf.nodes.concat(node('agent_q', 'agent', 'Code reviewer', { origin: 'prompt' }));
      wf.cables = wf.cables.filter((c) => c.id !== 'c_4').concat(cable('c_5', 'agent_b', 'a2a', 'agent_q', 'a2a', 'a2a'), cable('c_6', 'agent_q', 'act', 'action_d', 'act', 'action'));
      return json({ workflow: wf, applied: [{ op: 'add_agent' }], skipped: [], summary: 'Added Code reviewer before Deploy.', source: 'planner', note: null });
    }
    if (action === 'run') return json({ run: { run_id: 'r1', task_id: 't', agent_id: 'workflow:' + id, status: 'RUNNING', started_at: '2026-10-03T20:01:00.000Z', finished_at: null, node_status: { agent_r: 'waiting', agent_b: 'waiting' } } }, 202);
    if (action === 'events') {
      const after = Number(searchParams.get('after'));
      const out = state.events.filter((e) => e.seq > after);
      return json({ run: { run_id: 'r1', task_id: 't', agent_id: 'workflow:' + id, status: state.runStatus, started_at: '2026-10-03T20:01:00.000Z', finished_at: null, node_status: {} }, events: out });
    }
    return json({ error: 'Not found' }, 404);
  };
  return { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch, getToken: () => 'jwt' }), state };
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('workflow model', () => {
  const nodes = { a: node('a', 'agent', 'A'), b: node('b', 'agent', 'B'), m: node('m', 'mcp', 'M'), t: node('t', 'trigger', 'T'), h: node('h', 'human', 'H'), x: node('x', 'action', 'X') };

  it('derives the cable kind from the port pair, like the engine', () => {
    expect(cableKindFor(nodes.t, 'start', nodes.a, 'start')).toEqual({ kind: 'start' });
    expect(cableKindFor(nodes.a, 'mcp', nodes.m, 'read')).toEqual({ kind: 'mcp_read' });
    expect(cableKindFor(nodes.a, 'a2a', nodes.b, 'a2a')).toEqual({ kind: 'a2a' });
    expect(cableKindFor(nodes.a, 'act', nodes.x, 'act')).toEqual({ kind: 'action' });
    expect(cableKindFor(nodes.a, 'act', nodes.h, 'act')).toEqual({ kind: 'action' });
    expect(cableKindFor(nodes.h, 'start', nodes.a, 'start')).toEqual({ kind: 'start' });
  });

  it('refuses bad drops with a reason', () => {
    expect(cableKindFor(nodes.a, 'a2a', nodes.a, 'a2a').error).toMatch(/itself/);
    expect(cableKindFor(nodes.m, 'read', nodes.a, 'start').error).toMatch(/no "read" output/);
    expect(cableKindFor(nodes.a, 'a2a', nodes.m, 'read').error).toMatch(/MCP server is read from/);
    expect(cableKindFor(nodes.t, 'start', nodes.h, 'act').error).toMatch(/don't fit/);
    const wf = { nodes: Object.values(nodes), cables: [cable('c', 'a', 'a2a', 'b', 'a2a', 'a2a')] };
    expect(checkConnect(wf, 'b', 'a2a', 'a', 'a2a').error).toMatch(/already have an A2A cable/);
    expect(compatibleTargets(wf, 'a', 'mcp').map((t) => t.node.id + ':' + t.port)).toEqual(['m:read']);
  });

  it('lays out flow in columns, servers underneath, and keeps operator positions', () => {
    const wf = sampleWorkflow();
    const laid = autoLayout(wf);
    const at = (id) => laid.find((n) => n.id === id);
    expect(at('trigger_1').x).toBeLessThan(at('agent_r').x);
    expect(at('agent_r').x).toBeLessThan(at('agent_b').x);
    expect(at('action_d').x).toBeGreaterThan(at('agent_b').x);
    expect(at('mcp_n').y).toBeGreaterThan(at('agent_r').y);
    for (const n of laid) expect(n.x % 8 + n.y % 8).toBe(0);
    wf.nodes[2] = { ...wf.nodes[2], x: 1000, y: 40 };
    expect(autoLayout(wf).find((n) => n.id === 'agent_b')).toMatchObject({ x: 1000, y: 40 });
    expect(autoLayout(wf, { force: true }).find((n) => n.id === 'agent_b').x).not.toBe(1000);
  });

  it('pulse geometry and easing', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 300, y: 100 };
    expect(cablePoint(a, b, 0)).toEqual(a);
    expect(cablePoint(a, b, 1)).toEqual(b);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.3)).toBeGreaterThan(0.5); // fast start, gentle landing
    expect(snap(13)).toBe(16);
    const saved = graphForSave([{ ...node('a', 'agent', 'A', { role: '' }), x: 10.4, y: 7.6, extra: 1 }], [{ ...cable('c', 'a', 'a2a', 'b', 'a2a', 'a2a'), junk: true }]);
    expect(saved.nodes[0]).toEqual({ id: 'a', kind: 'agent', label: 'A', origin: 'generated', x: 10, y: 8 });
    expect(saved.cables[0].junk).toBeUndefined();
  });
});

describe('workflow console', () => {
  let ui;
  afterEach(() => {
    if (ui) ui.destroy();
    ui = null;
    document.body.replaceChildren();
  });

  function mount(api, opts = {}) {
    const container = document.createElement('div');
    container.className = 'wfc-console';
    document.body.append(container);
    const frames = [];
    let clock = 1_000;
    ui = mountWorkflowConsole(container, {
      api,
      pollMs: 60_000,
      saveDelayMs: 0,
      focusMenu: false,
      reducedMotion: false,
      editable: true,
      now: () => clock,
      requestAnimationFrame: (fn) => frames.push(fn),
      ...opts,
    });
    const tick = (ms) => {
      clock += ms;
      const due = frames.splice(0);
      due.forEach((fn) => fn(clock));
    };
    return { root: container, tick, frames };
  }

  const saves = (state) => state.calls.filter((c) => c.pathname.endsWith('/graph'));

  it('opens the most recent workflow and draws nodes, ports and typed cables', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    expect(state.calls.slice(0, 2).map((c) => c.method + ' ' + c.pathname)).toEqual(['GET /api/workflows', 'GET /api/workflows/wf_0000beef']);
    expect(root.querySelectorAll('.wfc-node')).toHaveLength(5);
    expect([...root.querySelectorAll('.wfc-cable')].map((c) => c.getAttribute('data-kind')).sort()).toEqual(['a2a', 'action', 'mcp_read', 'start']);
    expect(root.querySelector('.wfc-cable[data-kind="a2a"] .wfc-line-outer')).not.toBeNull();
    expect(root.querySelector('.wfc-cable[data-kind="action"] .wfc-line').getAttribute('marker-end')).toBe('url(#wfc-arrow)');
    expect(root.querySelector('.wfc-cable[data-kind="action"] .wfc-hit').getAttribute('aria-label')).toBe('Action cable from Builder to Deploy. Press Delete to remove.');
    const agent = root.querySelector('.wfc-node[data-node="agent_b"]');
    expect([...agent.querySelectorAll('.wfc-port')].map((p) => p.getAttribute('data-dir') + ':' + p.getAttribute('data-port'))).toEqual(['in:start', 'in:context', 'in:a2a', 'out:mcp', 'out:a2a', 'out:act']);
    expect(root.querySelector('.wfc-submit').textContent).toBe('Apply');
    expect(root.querySelector('.wfc-status').textContent).toMatch(/^2 agents · 4 cables/);
  });

  it('generates a workflow from the Command Bar when none exists', async () => {
    const { api, state } = engine({ workflows: [] });
    const { root } = mount(api);
    await ui.setActive(true);
    expect(root.querySelector('.wfc-status').textContent).toMatch(/No workflow open/);
    expect(root.querySelector('.wfc-submit').textContent).toBe('Generate');
    root.querySelector('#wfc-prompt').value = 'Research pricing and ship a page';
    root.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(state.calls.find((c) => c.method === 'POST').body).toEqual({ goal: 'Research pricing and ship a page' });
    expect(root.querySelectorAll('.wfc-node')).toHaveLength(5);
    expect(root.querySelector('.wfc-status').textContent).toMatch(/Generated "Generated" with 2 agents \(Built-in planner\)\. Sandbox mode/);
    expect(root.querySelector('#wfc-prompt').value).toBe('');
    expect(root.querySelector('.wfc-submit').textContent).toBe('Apply');
  });

  it('applies a prompt mutation and flags the new node and cables', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    await ui.command('Add an agent to review the code before deployment');
    const call = state.calls.find((c) => c.pathname.endsWith('/mutate'));
    expect(call.body).toEqual({ prompt: 'Add an agent to review the code before deployment', base_version: 1 });
    const added = root.querySelector('.wfc-node[data-node="agent_q"]');
    expect(added.getAttribute('data-new')).toBe('true');
    expect(root.querySelector('.wfc-node[data-node="agent_b"]').getAttribute('data-new')).toBe('false');
    expect(root.querySelector('.wfc-cable[data-cable="c_6"]').getAttribute('data-new')).toBe('true');
    expect(root.querySelector('.wfc-cable[data-cable="c_4"]')).toBeNull();
    expect(Number.isFinite(parseFloat(added.style.left))).toBe(true);
    expect(root.querySelector('.wfc-status').textContent).toBe('Added Code reviewer before Deploy. (Built-in planner)');
  });

  it('shows why a prompt could not be applied', async () => {
    const { api } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    await ui.command('add an approval before the Builder');
    expect(root.querySelector('.wfc-status').getAttribute('data-kind')).toBe('error');
    expect(root.querySelector('.wfc-status').textContent).toBe('None of the requested changes could be applied. Builder already waits for an approval. ');
    expect(ui.getState().workflow.version).toBe(1);
  });

  it('wires ports from the keyboard "Connect to…" menu and saves against the version', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    const port = root.querySelector('.wfc-node[data-node="agent_b"] .wfc-port[data-dir="out"][data-port="mcp"]');
    port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const menu = root.querySelector('.wfc-connect-menu');
    expect(menu.hidden).toBe(false);
    const items = [...menu.querySelectorAll('.wfc-menu-item')].map((b) => b.textContent);
    expect(items).toEqual(['notion · Read (MCP Read)']);
    menu.querySelector('.wfc-menu-item').click();
    await flush();
    expect(menu.hidden).toBe(true);
    const save = saves(state)[0];
    expect(save.body.base_version).toBe(1);
    expect(save.body.cables.find((c) => c.from === 'agent_b' && c.to === 'mcp_n')).toMatchObject({ from_port: 'mcp', to_port: 'read', kind: 'mcp_read', origin: 'operator' });
    expect(save.body.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(ui.getState().workflow.version).toBe(2);
    expect(root.querySelector('.wfc-version').textContent).toBe('v2');
  });

  it('refuses incompatible wiring with an inline reason and saves nothing', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    const result = ui.connect('agent_r', 'a2a', 'mcp_n', 'read');
    expect(result.error).toMatch(/MCP server is read from/);
    expect(root.querySelector('.wfc-tip').hidden).toBe(false);
    expect(root.querySelector('.wfc-tip').textContent).toMatch(/MCP server is read from/);
    expect(ui.connect('agent_r', 'a2a', 'agent_b', 'a2a').error).toBe('Those ports are already connected.');
    expect(ui.connect('agent_b', 'a2a', 'agent_r', 'a2a').error).toMatch(/already have an A2A cable/);
    await flush();
    expect(saves(state)).toHaveLength(0);
  });

  it('drags a node by its header on the 8px grid and saves the position', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    const before = { ...ui.getState().workflow.nodes.find((n) => n.id === 'agent_b') };
    const head = root.querySelector('.wfc-node[data-node="agent_b"] .wfc-node-head');
    head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 150, clientY: 133 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 150, clientY: 133 }));
    await flush();
    const moved = saves(state)[0].body.nodes.find((n) => n.id === 'agent_b');
    expect(moved.x).toBe(before.x + 48);
    expect(moved.y).toBe(before.y + 32);
    expect(moved.origin).toBe('operator');
    expect(root.querySelector('.wfc-node[data-node="agent_b"]').style.left).toBe(before.x + 48 + 'px');
  });

  it('moves with arrow keys, removes cables with Delete and edits agents in the inspector', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    const hit = root.querySelector('.wfc-cable[data-cable="c_4"] .wfc-hit');
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await flush();
    expect(saves(state).at(-1).body.cables.map((c) => c.id)).not.toContain('c_4');
    root.querySelector('.wfc-node[data-node="agent_b"] .wfc-node-head').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const field = root.querySelector('#wfc-field-instructions');
    expect(field.value).toBe('Write it.');
    field.value = 'Write the page in plain HTML.';
    field.dispatchEvent(new Event('change'));
    await flush();
    expect(saves(state).at(-1).body.nodes.find((n) => n.id === 'agent_b')).toMatchObject({ instructions: 'Write the page in plain HTML.', origin: 'operator' });
    const x0 = ui.getState().workflow.nodes.find((n) => n.id === 'agent_r').x;
    root.querySelector('.wfc-node[data-node="agent_r"] .wfc-node-head').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(saves(state).at(-1).body.nodes.find((n) => n.id === 'agent_r').x).toBe(x0 + 8);
  });

  it('reloads the newer version when a save conflicts (409)', async () => {
    const { api, state } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    state.conflictNext = true;
    ui.removeCable('c_3');
    await flush();
    expect(ui.getState().workflow.version).toBe(2);
    expect(root.querySelector('.wfc-node[data-node="agent_x"]')).not.toBeNull();
    expect(root.querySelector('.wfc-cable[data-cable="c_3"]')).not.toBeNull();
    expect(root.querySelector('.wfc-status').textContent).toMatch(/changed on the engine \(v2\).*not saved/);
  });

  it('runs the workflow: node statuses update and pulses travel along cables', async () => {
    const events = [
      { seq: 1, ts: 1, type: 'flow', cable_id: 'c_1', kind: 'start', from: 'trigger_1', to: 'agent_r', summary: 'start' },
      { seq: 2, ts: 1, type: 'node_status', node_id: 'agent_r', status: 'running' },
      { seq: 3, ts: 1, type: 'flow', cable_id: 'c_3', kind: 'mcp_read', from: 'agent_r', to: 'mcp_n', summary: 'context attached' },
    ];
    const { api, state } = engine({ events });
    const { root, tick } = mount(api);
    await ui.setActive(true);
    await ui.run();
    await flush();
    expect(state.calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/run'))).toBe(true);
    expect(root.querySelector('.wfc-node[data-node="agent_r"]').getAttribute('data-run')).toBe('running');
    expect(root.querySelector('.wfc-node[data-node="agent_r"] .wfc-run-pill').textContent).toBe('Running');
    expect(root.querySelectorAll('.wfc-pulse')).toHaveLength(2);
    expect(root.querySelector('.wfc-pulse[data-kind="mcp_read"]')).not.toBeNull();
    expect(root.querySelector('.wfc-run').disabled).toBe(true);
    tick(PULSE_MS / 2);
    const mid = root.querySelector('.wfc-pulse[data-kind="start"]');
    expect(Number(mid.getAttribute('cx'))).toBeGreaterThan(0);
    tick(PULSE_MS);
    expect(root.querySelectorAll('.wfc-pulse')).toHaveLength(0);
    expect(root.querySelector('.wfc-node[data-node="mcp_n"] .wfc-badge').textContent).toBe('context attached');
    expect(ui.getState().lastSeq).toBe(3);
  });

  it('caps pulses per cable and counts the rest on a badge', async () => {
    const { api } = engine();
    const { root } = mount(api);
    await ui.setActive(true);
    for (let i = 0; i < 5; i++) ui.pulse('c_2', 'hand-off');
    expect(root.querySelectorAll('.wfc-pulse')).toHaveLength(MAX_PULSES_PER_CABLE);
    expect(ui.getState().overflow).toEqual({ c_2: 2 });
    expect(root.querySelector('.wfc-overflow').textContent).toBe('+2');
  });

  it('reduced motion: no travelling dots, the cable thickens briefly instead', async () => {
    const { api } = engine();
    const { root } = mount(api, { reducedMotion: true });
    await ui.setActive(true);
    ui.pulse('c_2', 'hand-off');
    expect(root.querySelectorAll('.wfc-pulse')).toHaveLength(0);
    expect(root.querySelector('.wfc-cable[data-cable="c_2"]').getAttribute('data-flash')).toBe('true');
  });

  it('a breaker halt freezes pulses and shows the HALTED banner', async () => {
    const events = [
      { seq: 1, ts: 1, type: 'flow', cable_id: 'c_1', kind: 'start', from: 'trigger_1', to: 'agent_r' },
      { seq: 2, ts: 1, type: 'node_status', node_id: 'agent_r', status: 'halted', summary: 'operator trip' },
      { seq: 3, ts: 1, type: 'run_status', status: 'HALTED', summary: 'operator trip' },
    ];
    const { api, state } = engine({ events });
    state.runStatus = 'HALTED';
    const { root } = mount(api);
    await ui.setActive(true);
    await ui.run();
    await flush();
    expect(root.querySelector('.wfc-halted').hidden).toBe(false);
    expect(root.getAttribute('data-halted')).toBe('true');
    expect(ui.getState().frozen).toBe(true);
    expect(root.querySelector('.wfc-pulse').getAttribute('data-frozen')).toBe('true');
    expect(root.querySelector('.wfc-status').textContent).toBe('Run halted by the circuit breaker.');
    expect(root.querySelector('.wfc-run').disabled).toBe(false);
  });

  it('view-only mode: no wiring, no dragging', async () => {
    const { api, state } = engine();
    const { root } = mount(api, { editable: false });
    await ui.setActive(true);
    expect(ui.connect('agent_b', 'mcp', 'mcp_n', 'read').error).toMatch(/Turn on editing/);
    expect(root.querySelector('.wfc-port[data-dir="out"]').getAttribute('tabindex')).toBe('-1');
    root.querySelector('.wfc-node-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 80 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 80, clientY: 80 }));
    await flush();
    expect(saves(state)).toHaveLength(0);
    expect(NODE_W).toBe(208);
  });

  it('on a phone with a localhost engine address, explains and offers Settings instead of "unreachable"', async () => {
    const original = window.location.href;
    window.happyDOM.setURL('https://aether.example.workers.dev/mission-control');
    try {
      const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async () => { throw new TypeError('Load failed'); }, getToken: () => null });
      let opened = 0;
      const { root } = mount(api, { onConnect: () => opened++ });
      await ui.setActive(true);
      const status = root.querySelector('.wfc-status');
      expect(status.textContent).toMatch(/^The engine runs on your computer \(localhost:3333\), which this device can’t reach\./);
      status.querySelector('button').click();
      expect(opened).toBe(1);
    } finally {
      window.happyDOM.setURL(original);
    }
  });

  it('explains a missing engine endpoint', async () => {
    const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async () => new Response('{"error":"Not found"}', { status: 404 }), getToken: () => null });
    const { root } = mount(api);
    await ui.setActive(true);
    expect(root.querySelector('.wfc-status').textContent).toMatch(/no workflow endpoints/);
  });
});
