// Mission Control Studio canvas (public/js/engine/studio-canvas.js) in happy-dom against a simulated engine.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import {
  DEFAULT_THRESHOLD,
  THRESHOLD_STORAGE_KEY,
  bezierPath,
  bridgeVisible,
  clampThreshold,
  edgeLabel,
  filterBridges,
  layoutGraph,
  mountStudioCanvas,
} from '../../public/js/engine/studio-canvas.js';

const bridge = (from, to, confidence, extra = {}) => ({
  id: 'bridge:' + from + '->' + to.replace('mcp:', ''),
  kind: 'bridge',
  from,
  to,
  confidence,
  depth: confidence >= 0.6 ? 'logic' : confidence >= 0.3 ? 'associative' : 'abstract',
  rationale: 'Step "' + from.split(':').pop() + '" names ' + to.replace('mcp:', '') + ' directly.',
  signals: [
    { type: 'name', terms: [to.replace('mcp:', '')], weight: 0.55 },
    { type: 'category', terms: ['message', 'channel'], weight: 0.24 },
  ],
  metadata: {
    agent_id: 'atlas', task_id: 'launch-brief', run_id: 'r1', step_id: 'announce', step_index: 1, step_action: 'prompt', step_status: 'COMPLETED',
    step_excerpt: 'Draft a Slack message for the launch channel.', elarion_excerpt: 'Here is the launch announcement for #launch.',
    server: to.replace('mcp:', ''), category: 'communication', transport: 'stdio', server_status: 'ready', scoring: 'deterministic term match',
  },
  ...extra,
});

const GRAPH = {
  generated_at: '2026-10-03T20:00:00Z',
  nodes: [
    { id: 'mcp:slack', kind: 'mcp', label: 'slack', category: 'communication', status: 'ready', transport: 'stdio', description: 'Slack', missing_env: [] },
    { id: 'mcp:notion', kind: 'mcp', label: 'notion', category: 'knowledge', status: 'missing_keys', transport: 'stdio', description: 'Notion', missing_env: ['NOTION_TOKEN'] },
    { id: 'task:atlas:launch-brief', kind: 'task', label: 'launch-brief', agent_id: 'atlas', run_id: 'r1', status: 'COMPLETED', completed_steps: 2, total_steps: 2, started_at: 'x', finished_at: 'y' },
    { id: 'task:atlas:launch-brief:0', kind: 'step', label: 'collect-notes', task: 'task:atlas:launch-brief', index: 0, action: 'prompt', status: 'COMPLETED' },
    { id: 'task:atlas:launch-brief:1', kind: 'step', label: 'announce', task: 'task:atlas:launch-brief', index: 1, action: 'prompt', status: 'COMPLETED' },
  ],
  edges: [
    { id: 'tree:0', kind: 'tree', from: 'task:atlas:launch-brief', to: 'task:atlas:launch-brief:0' },
    { id: 'tree:1', kind: 'tree', from: 'task:atlas:launch-brief', to: 'task:atlas:launch-brief:1' },
    bridge('task:atlas:launch-brief:1', 'mcp:slack', 0.77),
    bridge('task:atlas:launch-brief:0', 'mcp:notion', 0.45, { metadata: { ...bridge('a', 'mcp:notion', 0).metadata, step_id: 'collect-notes', step_index: 0, server_status: 'missing_keys', elarion_excerpt: null, step_status: 'PENDING' } }),
    bridge('task:atlas:launch-brief:1', 'mcp:notion', 0.12),
  ],
  counts: { tasks: 1, steps: 2, mcp_servers: 2, bridges: 3 },
  mcp_error: null,
};

describe('pure helpers', () => {
  it('filters bridges by whole-percent confidence and clamps the slider value', () => {
    expect(clampThreshold(-5)).toBe(0);
    expect(clampThreshold(140)).toBe(100);
    expect(clampThreshold('abc')).toBe(DEFAULT_THRESHOLD);
    expect(bridgeVisible({ confidence: 0.3 }, 30)).toBe(true);
    expect(bridgeVisible({ confidence: 0.29 }, 30)).toBe(false);
    expect(filterBridges(GRAPH.edges, 0).visible).toHaveLength(3);
    expect(filterBridges(GRAPH.edges, 30).visible.map((e) => e.confidence)).toEqual([0.77, 0.45]);
    expect(filterBridges(GRAPH.edges, 100).visible).toHaveLength(0);
    expect(filterBridges(GRAPH.edges, 50).bridges).toHaveLength(3);
  });

  it('lays tasks, steps and servers out in three columns', () => {
    const { pos, width, height } = layoutGraph(GRAPH);
    const task = pos.get('task:atlas:launch-brief');
    const s0 = pos.get('task:atlas:launch-brief:0');
    const s1 = pos.get('task:atlas:launch-brief:1');
    const slack = pos.get('mcp:slack');
    expect(task.x).toBeLessThan(s0.x);
    expect(s0.x).toBeLessThan(slack.x);
    expect(s1.y).toBeGreaterThan(s0.y);
    // The task sits beside the middle of its steps.
    expect(task.y + task.h / 2).toBeCloseTo((s0.y + s1.y + s1.h) / 2, 5);
    expect(width).toBeGreaterThan(slack.x + slack.w);
    expect(height).toBeGreaterThanOrEqual(160);
  });

  it('draws horizontal-tangent Béziers and names edges for assistive tech', () => {
    expect(bezierPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 100, w: 100, h: 40 })).toBe('M100 20 C200 20 200 120 300 120');
    expect(edgeLabel(GRAPH.edges[2], GRAPH.nodes)).toBe('Bridge from step announce to slack, confidence 77%');
  });
});

describe('mounted canvas', () => {
  let canvas = null;
  afterEach(() => {
    if (canvas) canvas.destroy();
    canvas = null;
    document.body.replaceChildren();
    try { localStorage.clear(); } catch {}
  });

  function engine(respond = () => GRAPH) {
    const calls = [];
    const fetch = async (url, init) => {
      const { pathname } = new URL(url);
      calls.push({ pathname, auth: init.headers.Authorization || init.headers.authorization });
      const out = respond(pathname);
      if (out instanceof Error) throw out;
      if (typeof out === 'number') return new Response(JSON.stringify({ error: 'HTTP ' + out }), { status: out, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch, getToken: () => 'jwt' }), calls };
  }

  function mount(api, opts = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    canvas = mountStudioCanvas(container, { api, focusInspector: false, pollMs: 60_000, ...opts });
    return container;
  }

  const visibleBridges = (root) => [...root.querySelectorAll('.bridge')].filter((g) => g.getAttribute('data-hidden') !== 'true');

  it('fetches the canvas graph and renders task trees, MCP servers and bridges', async () => {
    const { api, calls } = engine();
    const root = mount(api);
    await canvas.refresh();
    expect(calls.map((c) => c.pathname)).toEqual(['/api/canvas/graph']);
    expect(calls[0].auth).toBe('Bearer jwt');
    expect(root.querySelectorAll('.node-task')).toHaveLength(1);
    expect(root.querySelectorAll('.node-step')).toHaveLength(2);
    expect(root.querySelectorAll('.node-mcp')).toHaveLength(2);
    expect(root.querySelectorAll('.tree-edge')).toHaveLength(2);
    expect(root.querySelectorAll('.bridge')).toHaveLength(3);
    expect(root.querySelector('.node-mcp[data-node="mcp:notion"]').getAttribute('data-status')).toBe('missing_keys');
    expect(root.querySelector('.studio-status').textContent).toBe('1 task run · 2 steps · 2 MCP servers');
    // Stronger bridges are drawn thicker; abstract ones are marked for the dashed style.
    const width = (id) => Number(root.querySelector('.bridge[data-edge="' + id + '"] .bridge-line').getAttribute('stroke-width'));
    expect(width(GRAPH.edges[2].id)).toBeGreaterThan(width(GRAPH.edges[4].id));
    expect(root.querySelector('.bridge[data-edge="' + GRAPH.edges[4].id + '"]').getAttribute('data-depth')).toBe('abstract');
  });

  it('the Abstract ↔ Logic slider hides bridges below the threshold and remembers the setting', async () => {
    const { api } = engine();
    const root = mount(api);
    await canvas.refresh();
    const slider = root.querySelector('#studio-threshold');
    const note = root.querySelector('#studio-threshold-note');
    expect(slider.value).toBe(String(DEFAULT_THRESHOLD));
    expect(visibleBridges(root)).toHaveLength(2);
    expect(note.textContent).toBe('Min confidence 30% · 2 of 3 bridges');

    slider.value = '0';
    slider.dispatchEvent(new Event('input'));
    expect(visibleBridges(root)).toHaveLength(3);
    expect(note.textContent).toBe('Min confidence 0% · 3 of 3 bridges');

    slider.value = '60';
    slider.dispatchEvent(new Event('input'));
    expect(visibleBridges(root).map((g) => g.getAttribute('data-edge'))).toEqual([GRAPH.edges[2].id]);
    // Hidden bridges leave the tab order.
    expect(root.querySelector('.bridge[data-edge="' + GRAPH.edges[3].id + '"] .bridge-hit').getAttribute('tabindex')).toBe('-1');
    expect(localStorage.getItem(THRESHOLD_STORAGE_KEY)).toBe('60');

    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    expect(visibleBridges(root)).toHaveLength(0);

    // A new mount starts from the saved value.
    canvas.destroy();
    document.body.replaceChildren();
    const again = mount(api);
    expect(again.querySelector('#studio-threshold').value).toBe('100');
  });

  it('clicking a bridge opens the Edge Inspector with rationale, confidence metrics and metadata', async () => {
    const { api } = engine();
    const root = mount(api);
    await canvas.refresh();
    const inspector = root.querySelector('.studio-inspector');
    expect(inspector.hidden).toBe(true);

    root.querySelector('.bridge[data-edge="' + GRAPH.edges[2].id + '"] .bridge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(inspector.hidden).toBe(false);
    expect(root.querySelector('.bridge[data-edge="' + GRAPH.edges[2].id + '"]').getAttribute('data-selected')).toBe('true');
    expect(inspector.querySelector('.inspector-route').textContent).toBe('announce → slack');
    expect(inspector.textContent).not.toContain('null');
    expect(inspector.querySelector('.inspector-pct').textContent).toBe('77%');
    expect(inspector.querySelector('.pill').textContent).toBe('Logic');
    expect(inspector.querySelector('.meter').getAttribute('aria-valuenow')).toBe('77');
    expect(inspector.querySelector('.inspector-rationale').textContent).toBe('Step "1" names slack directly.');
    expect(inspector.querySelector('.inspector-quote p').textContent).toBe('Here is the launch announcement for #launch.');
    expect([...inspector.querySelectorAll('.inspector-signals li')].map((li) => li.textContent)).toEqual(['Names the server+0.55slack', 'Category terms+0.24message, channel']);
    const meta = Object.fromEntries([...inspector.querySelectorAll('.inspector-meta dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
    expect(meta).toMatchObject({ Agent: 'atlas', Task: 'launch-brief', Run: 'r1', Step: '#2 · prompt · Done', Server: 'slack · communication', Transport: 'stdio', Keys: 'Ready' });

    // A step that hasn't run says so instead of quoting Elarion.
    root.querySelector('.bridge[data-edge="' + GRAPH.edges[3].id + '"] .bridge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(inspector.querySelector('.inspector-quote')).toBe(null);
    expect(inspector.textContent).toContain("This step hasn't run yet");
    expect(inspector.textContent).toContain('Keys missing');

    // Hiding the inspected bridge with the slider keeps the inspector and says why the line is gone.
    canvas.setThreshold(80);
    expect(inspector.querySelector('.inspector-hidden-note').textContent).toBe('Hidden at the current slider setting (80% minimum).');

    inspector.querySelector('.inspector-close').click();
    expect(inspector.hidden).toBe(true);
    expect(root.querySelectorAll('.bridge[data-selected="true"]')).toHaveLength(0);
  });

  it('clicking a step or task node shows its instructions, reply, model and the exact failure', async () => {
    const record = {
      task_id: 'launch-brief', agent_id: 'atlas', run_id: 'r1', status: 'FAILED', total_steps: 2, completed_steps: 1, interrupted_step_index: null,
      plan: [{ step_id: 'collect-notes', action: 'prompt', summary: 'Gather the launch notes.' }, { step_id: 'announce', action: 'prompt', summary: 'Draft the announcement.' }],
      results: [{ step_index: 0, step_id: 'collect-notes', action: 'prompt', status: 'COMPLETED', output: { response: 'Notes:\n- ship Monday', model: 'gemini-3.8-flash', tier: 'direct-gemini' }, tokens: { input: 1200, output: 340 }, cost_usd: null, started_at: '2026-10-04T22:57:50.000Z', duration_ms: 4200 }],
      total_tokens: { input: 1200, output: 340 }, history: [], started_at: '2026-10-04T22:57:49.938Z', finished_at: '2026-10-04T22:58:02.103Z',
      failure: { step_index: 1, status: 502, error: 'Google Gemini API (direct) returned an error (HTTP 503): The model is overloaded.' },
    };
    const { api, calls } = engine((pathname) => (pathname === '/api/canvas/graph' ? GRAPH : record));
    const root = mount(api);
    await canvas.refresh();
    const inspector = root.querySelector('.studio-inspector');
    const step0 = root.querySelector('.node[data-node="task:atlas:launch-brief:0"]');
    expect(step0.getAttribute('role')).toBe('button');
    expect(step0.getAttribute('aria-label')).toBe('Step collect-notes, Done. Show details.');

    step0.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.at(-1).pathname).toBe('/api/agents/atlas/tasks/launch-brief');
    expect(inspector.hidden).toBe(false);
    expect(inspector.querySelector('h3').textContent).toBe('Step details');
    expect(step0.getAttribute('data-selected')).toBe('true');
    expect(inspector.querySelector('.inspector-reply').textContent).toBe('Notes:\n- ship Monday');
    expect(inspector.querySelector('.inspector-text').textContent).toBe('Gather the launch notes.');
    const meta = Object.fromEntries([...inspector.querySelectorAll('.inspector-meta dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
    expect(meta).toMatchObject({ Model: 'gemini-3.8-flash · direct-gemini', Tokens: '1,200 in / 340 out', Time: '4.2 s · started 2026-10-04 22:57:50' });

    root.querySelector('.node[data-node="task:atlas:launch-brief:1"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(inspector.querySelector('.pill').textContent).toBe('Failed');
    expect(inspector.querySelector('.inspector-error').textContent).toContain('HTTP 503): The model is overloaded. (HTTP 502)');
    expect(inspector.querySelector('.inspector-error').textContent).toContain('came from the model provider');

    root.querySelector('.node[data-node="task:atlas:launch-brief"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(inspector.querySelector('h3').textContent).toBe('Task details');
    expect(inspector.querySelector('.inspector-error strong').textContent).toBe('Failed at announce');
    expect([...inspector.querySelectorAll('.inspector-step-link')].map((b) => b.textContent)).toEqual(['✓ collect-notes', '✕ announce']);
    expect(calls.filter((c) => c.pathname.startsWith('/api/agents/'))).toHaveLength(1);
    inspector.querySelectorAll('.inspector-step-link')[1].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(inspector.querySelector('h3').textContent).toBe('Step details');

    // A bridge click replaces the node details; Escape closes.
    root.querySelector('.bridge[data-edge="' + GRAPH.edges[2].id + '"] .bridge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(inspector.querySelector('h3').textContent).toBe('Edge Inspector');
    expect(root.querySelectorAll('.node[data-selected="true"]')).toHaveLength(0);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(inspector.hidden).toBe(true);
  });

  it('opens the inspector from the keyboard and closes it with Escape', async () => {
    const { api } = engine();
    const root = mount(api);
    await canvas.refresh();
    const hit = root.querySelector('.bridge[data-edge="' + GRAPH.edges[2].id + '"] .bridge-hit');
    expect(hit.getAttribute('role')).toBe('button');
    expect(hit.getAttribute('aria-label')).toBe('Bridge from step announce to slack, confidence 77%');
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(root.querySelector('.studio-inspector').hidden).toBe(false);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.studio-inspector').hidden).toBe(true);
  });

  it('explains empty canvases, a missing endpoint, auth failures and an unreachable engine', async () => {
    let mode = 'empty';
    const { api } = engine(() => {
      if (mode === 'empty') return { ...GRAPH, nodes: GRAPH.nodes.filter((n) => n.kind === 'mcp'), edges: [], counts: { tasks: 0, steps: 0, mcp_servers: 2, bridges: 0 } };
      if (mode === '404') return 404;
      if (mode === '401') return 401;
      return new TypeError('Failed to fetch');
    });
    let connects = 0;
    const root = mount(api, { onConnect: () => connects++ });
    const status = () => root.querySelector('.studio-status');

    await canvas.refresh();
    expect(status().textContent).toBe('0 task runs · 0 steps · 2 MCP servers. No task runs yet: run a blueprint or a recipe and its steps appear here.');
    expect(root.querySelectorAll('.node-mcp')).toHaveLength(2);

    mode = '404';
    await canvas.refresh();
    expect(status().getAttribute('data-kind')).toBe('error');
    expect(status().textContent).toContain('no canvas endpoint');

    mode = '401';
    await canvas.refresh();
    expect(status().textContent).toContain('The engine rejected the token');
    status().querySelector('button').click();
    expect(connects).toBe(1);

    mode = 'offline';
    await canvas.refresh();
    expect(status().textContent).toContain('Could not load the canvas from the engine');
  });

  it('polls only while the Studio view is active', async () => {
    const { api, calls } = engine();
    mount(api, { pollMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(0);
    canvas.setActive(true);
    await new Promise((r) => setTimeout(r, 75));
    const whileActive = calls.length;
    expect(whileActive).toBeGreaterThanOrEqual(2);
    canvas.setActive(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBeLessThanOrEqual(whileActive + 1);
  });
});
