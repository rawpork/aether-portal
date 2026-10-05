// Mission Control workforce overview (public/js/engine/workforce.js) in happy-dom against a simulated engine.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import {
  BREAKER_OFF_REASON,
  EMERGENCY_REASON,
  PAUSE_REASON,
  activityItems,
  nextAction,
  runPulse,
  mountWorkforce,
  outputLines,
  summarizeAgent,
  summarizeWorkforce,
  taskRows,
} from '../../public/js/engine/workforce.js';

const NOW = Date.parse('2026-10-02T10:42:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const runningTask = {
  task_id: 'customer-migration',
  agent_id: 'atlas',
  run_id: 'r1',
  status: 'RUNNING',
  total_steps: 4,
  completed_steps: 2,
  current_step: { index: 2, step_id: 'generate-sequence' },
  interrupted_step_index: null,
  total_tokens: { input: 1200, output: 300 },
  started_at: iso(120000),
  finished_at: null,
};
const runningRecord = {
  ...runningTask,
  requested_by: 'u',
  results: [
    { step_index: 0, step_id: 'map-schema', action: 'prompt', status: 'COMPLETED', output: { response: 'Schema mapped.' }, tokens: { input: 1, output: 1 }, cost_usd: null, started_at: iso(120000), duration_ms: 40000 },
    { step_index: 1, step_id: 'validate-deps', action: 'echo', status: 'COMPLETED', output: '12,480 records checked', tokens: { input: 0, output: 0 }, cost_usd: null, started_at: iso(80000), duration_ms: 20000 },
  ],
  history: [
    { at: iso(120000), event: 'STARTED' },
    { at: iso(120000), event: 'STEP_STARTED', step_index: 0, step_id: 'map-schema' },
    { at: iso(80000), event: 'STEP_COMPLETED', step_index: 0, step_id: 'map-schema' },
    { at: iso(80000), event: 'STEP_STARTED', step_index: 1, step_id: 'validate-deps' },
    { at: iso(60000), event: 'STEP_COMPLETED', step_index: 1, step_id: 'validate-deps' },
    { at: iso(60000), event: 'STEP_STARTED', step_index: 2, step_id: 'generate-sequence' },
  ],
};

describe('view models', () => {
  it('summarizes a running agent with progress, ETA and success rate', () => {
    const done = { ...runningTask, run_id: 'r0', status: 'COMPLETED', completed_steps: 4, finished_at: iso(500000), started_at: iso(600000) };
    const a = summarizeAgent('atlas', [runningTask, done], { agent_id: 'atlas', state: 'ACTIVE' }, NOW);
    expect(a).toMatchObject({ name: 'Atlas', code: 'ATLAS', status: 'running', pill: 'Running', progress: 50, done: 2, total: 4, successRate: 100, halted: false });
    // 2 steps in 120s, 2 to go: about 2 minutes.
    expect(a.etaMs).toBe(120000);
    expect(a.eta).toBe('2m');
    expect(a.objective).toBe('Running step 3: generate-sequence');
  });

  it('tells a pause from a tripped breaker, and a failed run from an idle one', () => {
    expect(summarizeAgent('atlas', [runningTask], { state: 'HALTED', reason: PAUSE_REASON }, NOW)).toMatchObject({ status: 'paused', pill: 'Paused', eta: 'Halted' });
    expect(summarizeAgent('atlas', [runningTask], { state: 'HALTED', reason: 'loop' }, NOW)).toMatchObject({ status: 'tripped', pillKind: 'off' });
    expect(summarizeAgent('atlas', [{ ...runningTask, status: 'FAILED' }], { state: 'ACTIVE' }, NOW)).toMatchObject({ status: 'needs-input', eta: 'Blocked' });
    expect(summarizeAgent('master-brain', [], { state: 'ACTIVE' }, NOW)).toMatchObject({ name: 'Elarion', role: 'Master Brain', status: 'waiting', progress: 0 });
  });

  it('builds the four summary metrics', () => {
    const agents = [summarizeAgent('atlas', [runningTask], { state: 'ACTIVE' }, NOW), summarizeAgent('master-brain', [], { state: 'ACTIVE' }, NOW)];
    const m = summarizeWorkforce(agents, { running: 1, completed: 5, halted: 1, failed: 1 }, NOW);
    expect(m.map((x) => [x.label, x.value, x.sub])).toEqual([
      ['Overall progress', '50%', '2 of 4 steps'],
      ['Active workers', '1', 'of 2 assigned'],
      ['Tasks completed', '5', 'of 8 total'],
      ['Est. completion', 'Today', expect.stringMatching(/^at /)],
    ]);
  });

  it('lists steps, timeline and output from a run record', () => {
    const rows = taskRows(runningRecord);
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['Map Schema', 'complete'],
      ['Validate Deps', 'complete'],
      ['Generate Sequence', 'running'],
      ['Step 4', 'waiting'],
    ]);
    const halted = taskRows({ ...runningRecord, status: 'HALTED', halt: { halted_at: iso(1), reason: 'loop' } });
    expect(halted[2]).toMatchObject({ state: 'tripped', label: 'Auto-tripped · loop' });
    expect(activityItems(runningRecord)[0]).toMatchObject({ title: 'Step started', detail: 'Generate Sequence', kind: 'spark' });
    expect(outputLines(runningRecord)).toEqual(['[map-schema] Schema mapped.', '[validate-deps] 12,480 records checked']);
  });
});

describe('mounted overview', () => {
  let wf;
  afterEach(() => {
    if (wf) wf.destroy();
    wf = null;
    document.body.replaceChildren();
  });

  function engine() {
    const states = { 'master-brain': { state: 'ACTIVE' }, atlas: { state: 'ACTIVE' } };
    const posts = [];
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url, init) => {
      const { pathname } = new URL(url);
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push({ pathname, body });
        if (pathname === '/api/agents/trip-breaker') states[body.agent_id] = { state: 'HALTED', reason: body.reason };
        if (pathname === '/api/agents/reset') states[body.agent_id] = { state: 'ACTIVE' };
        return reply({ status: states[body.agent_id].state, logged: true, timestamp: 'x', reset: true });
      }
      const state = /^\/api\/agents\/([^/]+)\/state$/.exec(pathname);
      if (state) return reply({ agent_id: state[1], ...states[state[1]] });
      if (pathname === '/api/tasks') return reply({ tasks: [runningTask], counts: { running: 1, completed: 0, halted: 0, failed: 0 } });
      if (pathname === '/api/agents/atlas/tasks/customer-migration') return reply(runningRecord);
      return reply({}, 404);
    };
    return { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch, getToken: () => 'jwt' }), posts, states };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('renders cards, selects the running agent and drives its breaker from the card, the detail panel and the task list', async () => {
    const { api, posts } = engine();
    const skillsRequests = [];
    const portalFetch = async (url) => {
      skillsRequests.push(url);
      return new Response(JSON.stringify({ skills: [{ id: 'triage', name: 'Lead triage', description: 'Scores leads', path: '.aether/skills/AEPS/triage/SKILL.md', body: '# Lead triage' }] }), { status: 200 });
    };
    const container = document.createElement('div');
    document.body.append(container);
    wf = mountWorkforce(container, { api, portalFetch, now: () => NOW });
    await settle();

    const cards = container.querySelectorAll('.agent-card');
    expect([...cards].map((c) => c.querySelector('.card-name').textContent)).toEqual(['Atlas', 'Elarion']);
    expect(cards[0].dataset.selected).toBe('true');
    expect(cards[0].querySelector('.pill').textContent).toBe('Running');
    expect(cards[0].querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('50');
    expect(container.querySelector('.wf-detail h2').textContent).toBe('Atlas');
    expect(container.querySelectorAll('.timeline .tl-item')).toHaveLength(6);

    // Card Pause: trips Atlas with the pause reason; the card then offers Resume and its pill reads Paused.
    cards[0].querySelector('.card-head .btn-small').click();
    await settle();
    expect(posts.at(-1)).toEqual({ pathname: '/api/agents/trip-breaker', body: { agent_id: 'atlas', reason: PAUSE_REASON } });
    const atlas = container.querySelector('.agent-card');
    expect(atlas.querySelector('.pill').textContent).toBe('Paused');
    expect(atlas.querySelector('.card-head .btn-small').textContent).toContain('Resume');
    expect(atlas.querySelector('.switch').getAttribute('aria-checked')).toBe('false');

    // Card breaker switch back on resets Atlas.
    atlas.querySelector('.switch').click();
    await settle();
    expect(posts.at(-1)).toEqual({ pathname: '/api/agents/reset', body: { agent_id: 'atlas' } });
    expect(container.querySelector('.agent-card .switch').getAttribute('aria-checked')).toBe('true');

    // Switching it off uses the breaker reason.
    container.querySelector('.agent-card .switch').click();
    await settle();
    expect(posts.at(-1).body).toEqual({ agent_id: 'atlas', reason: BREAKER_OFF_REASON });
    container.querySelector('.agent-card .switch').click();
    await settle();

    // Tasks tab: only the running step's switch is live.
    wf.setTab('tasks');
    const switches = [...container.querySelectorAll('.checklist .switch')];
    expect(switches.map((s) => s.disabled)).toEqual([true, true, false, true]);
    switches[2].click();
    await settle();
    expect(posts.at(-1).pathname).toBe('/api/agents/trip-breaker');
    container.querySelector('.agent-card .switch').click();
    await settle();

    // Output tab: the embedded terminal.
    wf.setTab('output');
    expect(container.querySelector('.terminal-head').textContent).toContain('agent.output');
    expect(container.querySelector('.terminal-body').textContent).toBe('[map-schema] Schema mapped.\n[validate-deps] 12,480 records checked');

    // Skills tab: AEPS playbooks from the portal.
    wf.setTab('skills');
    await settle();
    expect(skillsRequests).toEqual(['/api/skills/aeps']);
    expect(container.querySelector('.skill-name').textContent).toBe('Lead triage');
    expect(container.querySelector('.skill-path').textContent).toBe('.aether/skills/AEPS/triage/SKILL.md');

    // API Bridge tab: endpoints for this agent.
    wf.setTab('bridge');
    expect(container.querySelector('.endpoints').textContent).toContain('/api/agents/atlas/state');

    // Emergency breaker.
    container.querySelector('.emergency .btn-danger').click();
    await settle();
    expect(posts.at(-1).body).toEqual({ agent_id: 'atlas', reason: EMERGENCY_REASON });
    expect(container.querySelector('.agent-card .pill').textContent).toBe('Tripped');
    expect(container.querySelector('.emergency .btn-danger').textContent).toBe('Restart');

    // Selecting Elarion switches the detail panel.
    container.querySelectorAll('.card-select')[1].click();
    await settle();
    expect(container.querySelector('.wf-detail h2').textContent).toBe('Elarion');
  });

  it('shows an offline banner with a way to the connection settings', async () => {
    const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async () => { throw new TypeError('failed'); }, getToken: () => null });
    let connectOpened = 0;
    const container = document.createElement('div');
    document.body.append(container);
    wf = mountWorkforce(container, { api, onConnect: () => connectOpened++ });
    await settle();
    const banner = container.querySelector('.wf-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('not reachable');
    banner.querySelector('button').click();
    expect(connectOpened).toBe(1);
    expect(container.querySelector('.metric-value').textContent).toBe('—');
  });
});

describe('finger on the pulse', () => {
  const withPlan = {
    ...runningRecord,
    plan: [
      { step_id: 'map-schema', action: 'prompt', summary: 'Map the old schema to the new one.' },
      { step_id: 'validate-deps', action: 'echo', summary: '' },
      { step_id: 'generate-sequence', action: 'prompt', summary: 'Write the migration SQL for every table.' },
      { step_id: 'ship', action: 'prompt', summary: 'Ship it.' },
    ],
  };

  it('timeline entries carry what a step was asked and what it wrote', () => {
    const items = activityItems(withPlan);
    expect(items[0]).toMatchObject({ title: 'Step started', text: 'Write the migration SQL for every table.', textLabel: 'What it was asked' });
    expect(items.find((i) => i.title === 'Step completed' && i.detail.startsWith('Map Schema'))).toMatchObject({ text: 'Schema mapped.', textLabel: 'What it wrote' });
  });

  it('runPulse names the step being worked on, since when, and the latest output', () => {
    expect(runPulse(withPlan)).toMatchObject({ state: 'working', index: 2, step: 'Generate Sequence', asked: 'Write the migration SQL for every table.', since: iso(60000), done: 2, total: 4, last: { step: 'Validate Deps', text: '12,480 records checked' } });
    expect(runPulse({ ...withPlan, awaiting: { question: 'Ship to prod?', options: ['Yes', 'No'] } })).toMatchObject({ state: 'waiting', question: 'Ship to prod?' });
    expect(runPulse({ ...withPlan, status: 'FAILED', failure: { step_index: 2, error: 'HTTP 503: overloaded' } })).toMatchObject({ state: 'failed', error: 'HTTP 503: overloaded' });
    expect(runPulse(null)).toBeNull();
  });

  it('nextAction names one thing to do, in priority order', () => {
    const done = { task_id: 'deploy-bp_1', status: 'COMPLETED', completed_steps: 5, total_steps: 5, finished_at: '2026-10-05T01:00:00Z' };
    expect(nextAction({ error: { isUnreachable: true } })).toMatchObject({ title: 'Start the engine', action: { view: 'connect' } });
    expect(nextAction({ tasks: [{ ...runningTask, awaiting: { question: 'Ship?' } }] })).toMatchObject({ title: 'Elarion is waiting for your answer', action: { view: 'operator' } });
    expect(nextAction({ tasks: [runningTask] }).text).toMatch(/^customer-migration · step 3 of 4\./);
    expect(nextAction({ tasks: [done], runs: { 'deploy-bp_1': { siteSlug: 'kit', nodeId: 'n' } } })).toMatchObject({ title: 'Your website draft is ready', action: { view: 'blueprints' } });
    expect(nextAction({ tasks: [done], runs: {} }).title).toBe('Your project finished');
    expect(nextAction({ tasks: [{ ...done, status: 'FAILED' }] }).title).toBe('The last project run failed');
    expect(nextAction({ tasks: [] }).title).toBe('Start your first project');
    expect(nextAction({ tasks: [done], runs: { 'deploy-bp_1': { nodeId: 'n', siteSlug: 'kit', sitePublished: true } } }).text).toMatch(/website is live/);
  });

  it('the overview shows the banner and the pulse card, and a poll never scrolls the page', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const fetch = async (url) => {
      const { pathname } = new URL(url);
      const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
      if (pathname === '/api/tasks') return json({ tasks: [runningTask], counts: { running: 1, completed: 0, halted: 0, failed: 0 } });
      if (pathname.endsWith('/state')) return json({ agent_id: 'atlas', state: 'ACTIVE' });
      return json(withPlan);
    };
    const navigated = [];
    const view = mountWorkforce(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch }), now: () => NOW, onNavigate: (v) => navigated.push(v), storage: { getItem: () => null } });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('.wf-next-title').textContent).toBe('A run is in progress');
    expect(container.querySelector('.pulse-step').textContent).toBe('Generate Sequence');
    expect(container.querySelector('[data-pulse-since]').textContent).toBe('00:01:00');
    expect(container.querySelector('.pulse-last summary').textContent).toBe('Just finished: Validate Deps');
    const focusCalls = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (opts) { focusCalls.push(opts); };
    try {
      container.querySelector('.subtabs [role="tab"]').focus = original;
      container.querySelector('.subtabs [role="tab"]').focus();
      withPlanTick(withPlan);
      await view.refresh();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      HTMLElement.prototype.focus = original;
    }
    expect(focusCalls.length).toBeGreaterThan(0);
    expect(focusCalls.every((o) => o && o.preventScroll === true)).toBe(true);
    view.destroy();
    container.remove();
  });
});

// A poll that moves the run along (one more history entry), so the detail panel is rebuilt.
function withPlanTick(record) {
  record.history = [...record.history, { at: iso(30000), event: 'STEP_COMPLETED', step_index: 2, step_id: 'generate-sequence' }];
}
