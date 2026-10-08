// Task loop monitor against the real client bundle, with a simulated engine task registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { buildStepRows, collapseRepeats, describeTask, formatDuration, mountTaskMonitor } from '../../public/js/engine/task-monitor.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

function summary(record) {
  const last = record.history[record.history.length - 1];
  return {
    task_id: record.task_id,
    agent_id: record.agent_id,
    run_id: 'run',
    status: record.status,
    total_steps: record.total_steps,
    completed_steps: record.results.length,
    current_step: record.status === 'RUNNING' && last && last.event === 'STEP_STARTED' ? { index: last.step_index, step_id: last.step_id } : null,
    interrupted_step_index: record.status === 'HALTED' ? record.results.length : null,
    total_tokens: record.results.reduce((t, r) => ({ input: t.input + r.tokens.input, output: t.output + r.tokens.output }), { input: 0, output: 0 }),
    started_at: record.started_at,
    finished_at: record.finished_at,
    ...(record.halt ? { halt: record.halt } : {}),
  };
}

const result = (i, id, tokens = { input: 0, output: 0 }) => ({ step_index: i, step_id: id, action: tokens.input ? 'prompt' : 'echo', status: 'COMPLETED', output: {}, tokens, cost_usd: null, started_at: iso(i * 1000), duration_ms: 250 });

function createEngine() {
  const engine = {
    records: new Map(),
    artifacts: [],
    offline: false,
    calls: [],
    add(record) {
      engine.records.set(record.agent_id + '/' + record.task_id, record);
    },
    async fetch(url) {
      const { pathname } = new URL(url);
      engine.calls.push(pathname);
      const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (engine.offline) throw new TypeError('Failed to fetch');
      if (pathname === '/api/tasks') {
        const tasks = [...engine.records.values()].map(summary).sort((a, b) => b.started_at.localeCompare(a.started_at));
        const count = (s) => tasks.filter((t) => t.status === s).length;
        return reply(200, { tasks, counts: { running: count('RUNNING'), completed: count('COMPLETED'), halted: count('HALTED'), failed: count('FAILED') } });
      }
      if (pathname === '/api/artifacts') return reply(200, { success: true, count: engine.artifacts.length, artifacts: engine.artifacts });
      const match = /^\/api\/agents\/([^/]+)\/tasks\/([^/]+)$/.exec(pathname);
      if (match) {
        const record = engine.records.get(decodeURIComponent(match[1]) + '/' + decodeURIComponent(match[2]));
        return record ? reply(200, record) : reply(404, { error: 'No task run found for this agent and task_id.' });
      }
      return reply(404, { error: 'not found' });
    },
  };
  return engine;
}

let engine, monitor, container, statusEl;

function mount() {
  container = document.createElement('div');
  statusEl = document.createElement('span');
  document.body.append(container, statusEl);
  const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch });
  monitor = mountTaskMonitor(container, { api, statusEl, now: () => T0 + 90_000 });
  return monitor;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const rowTexts = () => [...container.querySelectorAll('.mc-task')].map((li) => li.dataset.status + ' | ' + li.querySelector('.mc-task-name').textContent + ' | ' + li.querySelector('.mc-task-line').textContent);
const stat = (kind) => container.querySelector('.mc-stat[data-kind="' + kind + '"] .mc-stat-value').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  engine = createEngine();
});

afterEach(() => {
  monitor && monitor.destroy();
  container && container.remove();
  statusEl && statusEl.remove();
  monitor = null;
  vi.useRealTimers();
});

describe('task monitor', () => {
  it('shows an empty state before any task runs', async () => {
    mount();
    await flush();
    expect(monitor.elements.taskEmpty.hidden).toBe(false);
    expect(monitor.elements.projectEmpty.hidden).toBe(false);
    expect(statusEl.textContent).toBe('Up to date');
  });

  it('separates completed work from active, halted and failed tasks with live totals', async () => {
    engine.add({ task_id: 'build-1', agent_id: 'builder', status: 'COMPLETED', total_steps: 2, results: [result(0, 'plan'), result(1, 'ask', { input: 110, output: 42 })], history: [], started_at: iso(0), finished_at: iso(3400) });
    engine.add({ task_id: 'build-2', agent_id: 'builder', status: 'RUNNING', total_steps: 4, results: [result(0, 'plan')], history: [{ at: iso(10_000), event: 'STEP_STARTED', step_index: 1, step_id: 'draft' }], started_at: iso(10_000), finished_at: null });
    engine.add({ task_id: 'build-3', agent_id: 'builder', status: 'HALTED', total_steps: 3, results: [result(0, 'plan')], history: [{ at: iso(5000), event: 'HALTED', step_index: 1, step_id: 'deploy' }], started_at: iso(5000), finished_at: iso(6000), halt: { halted_at: iso(5500), reason: 'Operator manual trip from Portal UI' } });
    mount();
    await flush();

    expect(rowTexts()).toEqual([
      'RUNNING | Build 2 · Builder | 1/4 stepsRunning step 2: draft',
      'HALTED | Build 3 · Builder | 1/3 stepsHalted before step 2: Operator manual trip from Portal UI',
      'COMPLETED | Build 1 · Builder | 2/2 stepsAll 2 steps done110 in / 42 out',
    ]);
    expect([stat('running'), stat('completed'), stat('halted'), stat('failed'), stat('tokens')]).toEqual(['1', '1', '1', '0', '152']);
    const bar = container.querySelector('.mc-task[data-status="RUNNING"] .mc-progress');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('4');
    expect(bar.firstChild.style.width).toBe('25%');
    expect(statusEl.textContent).toBe('1 running · live');
  });

  it('polls every 2s while a task runs and shows it completing', async () => {
    const record = { task_id: 't', agent_id: 'a', status: 'RUNNING', total_steps: 2, results: [], history: [{ at: iso(0), event: 'STEP_STARTED', step_index: 0, step_id: 's1' }], started_at: iso(0), finished_at: null };
    engine.add(record);
    mount();
    await flush();
    const polls = () => engine.calls.filter((p) => p === '/api/tasks').length;
    expect(polls()).toBe(1);

    record.results.push(result(0, 's1'), result(1, 's2'));
    record.status = 'COMPLETED';
    record.finished_at = iso(1500);
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls()).toBe(2);
    expect(rowTexts()[0]).toBe('COMPLETED | T · A | 2/2 stepsAll 2 steps done');

    // Nothing running: back to the 5s idle cadence.
    await vi.advanceTimersByTimeAsync(4999);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(3);
  });

  it('expands a task into its step timeline', async () => {
    engine.add({ task_id: 'h', agent_id: 'b', status: 'HALTED', total_steps: 4, results: [result(0, 'h1'), result(1, 'h2', { input: 110, output: 42 })], history: [{ at: iso(1), event: 'HALTED', step_index: 2, step_id: 'h3' }], started_at: iso(0), finished_at: iso(1), halt: { halted_at: iso(1) } });
    mount();
    await flush();
    const head = container.querySelector('.mc-task-head');
    head.click();
    await flush();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const steps = [...container.querySelectorAll('.mc-step')].map((li) => li.dataset.state + ' ' + li.textContent);
    expect(steps).toEqual(['done ✓h1 · echo250ms', 'done ✓h2 · prompt250ms · 110 in / 42 out', 'halted ⏸h3not run: breaker tripped', 'queued ○1 more step not run']);
    head.click();
    expect(container.querySelector('.mc-steps').hidden).toBe(true);
  });

  it('lists the latest compiled blueprints as projects', async () => {
    engine.artifacts = [
      { filename: 'a.json', blueprint_id: 'bp_a', project_name: 'Older', created_at: iso(-86_400_000 * 2), status: 'DRAFT' },
      { filename: 'b.json', blueprint_id: 'bp_b', project_name: 'Newer', created_at: iso(30_000), status: 'APPROVED_FOR_EXECUTION' },
    ];
    mount();
    await flush();
    const projects = [...container.querySelectorAll('.mc-project')].map((li) => li.textContent);
    expect(projects).toEqual(['NewerApprovedCompiled 1m ago', 'OlderDraftCompiled 2d ago']);
  });

  it('reports an offline engine and recovers', async () => {
    engine.offline = true;
    mount();
    await flush();
    expect(statusEl.textContent).toBe('Engine offline · retrying');
    engine.offline = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(statusEl.textContent).toBe('Up to date');
  });
});

describe('formatting helpers', () => {
  it('formats durations and task lines', () => {
    expect([formatDuration(250), formatDuration(3400), formatDuration(75_000), formatDuration(3_900_000)]).toEqual(['250ms', '3.4s', '1m 15s', '1h 5m']);
    expect(describeTask({ status: 'FAILED', total_steps: 3, completed_steps: 1, failure: { step_index: 1, status: 422, error: 'declined' } })).toBe('Failed at step 2: declined');
    expect(buildStepRows({ status: 'RUNNING', total_steps: 3, results: [], history: [{ event: 'STEP_STARTED', step_index: 0, step_id: 'first' }] }).map((r) => r.state + ':' + r.name)).toEqual([
      'running:first',
      'queued:2 more steps queued',
    ]);
  });
});

describe('repeated rows read once', () => {
  const finished = (id, over = {}) => ({ task_id: id, agent_id: 'builder', status: 'COMPLETED', total_steps: 2, results: [result(0, 'plan'), result(1, 'ask')], history: [], started_at: iso(0), finished_at: iso(30_000), ...over });

  it('collapses consecutive identical step rows to one with a count, and leaves different ones alone', () => {
    const rows = [
      { state: 'done', name: 'echo · echo', detail: '1s' },
      { state: 'done', name: 'echo · echo', detail: '1s' },
      { state: 'done', name: 'echo · echo', detail: '1s' },
      { state: 'done', name: 'echo · echo', detail: '2s' },
      { state: 'failed', name: 'echo · echo', detail: '2s' },
    ];
    expect(collapseRepeats(rows)).toEqual([
      { state: 'done', name: 'echo · echo ×3', detail: '1s' },
      { state: 'done', name: 'echo · echo', detail: '2s' },
      { state: 'failed', name: 'echo · echo', detail: '2s' },
    ]);
    expect(collapseRepeats([])).toEqual([]);
  });

  it('folds identical runs under the newest, keeps different runs in the list, and says how long ago in words', async () => {
    // Three deploys that read the same (same title, agent, outcome, step count) and one that differs.
    engine.add(finished('deploy-bp_1'));
    engine.add(finished('deploy-bp_2'));
    engine.add(finished('deploy-bp_3'));
    engine.add(finished('deploy-bp_4', { status: 'FAILED', completed_steps: 1 }));
    mount();
    await flush();
    const top = [...container.querySelectorAll('[aria-label="Task runs"] > .mc-task, [aria-label="Task runs"] > .mc-task-group')];
    const groups = container.querySelectorAll('.mc-task-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector('summary').textContent).toBe('2 earlier runs with the same name');
    expect(groups[0].querySelectorAll('.mc-task-sub > .mc-task')).toHaveLength(2);
    // Two rows stand on their own in the list: the newest of the identical runs, and the failed one.
    expect(top.filter((n) => n.classList.contains('mc-task'))).toHaveLength(2);
    expect(container.querySelectorAll('.mc-task')).toHaveLength(4);
    // Time reads "duration · how long ago", not a clock time.
    expect(container.querySelector('.mc-task-time').textContent).toMatch(/^[\d.]+(ms|s|m)( \d+s)? · (just now|\d+[mhd] ago)$/);
  });

  it('keeps a folded group open across polls once the operator opened it', async () => {
    engine.add(finished('deploy-bp_1'));
    engine.add(finished('deploy-bp_2'));
    mount();
    await flush();
    const details = () => container.querySelector('.mc-task-group details');
    details().open = true;
    details().dispatchEvent(new Event('toggle'));
    await vi.advanceTimersByTimeAsync(6000);
    expect(details().open).toBe(true);
  });

  it('lists five compiles of the same blueprint as one project with four earlier versions, and does not fold different outcomes', async () => {
    const same = (n) => ({ filename: n + '.json', blueprint_id: 'bp_' + n, project_name: 'AI-Powered Micro SaaS', created_at: iso(-n * 3600_000), status: 'APPROVED_FOR_EXECUTION' });
    engine.artifacts = [same(1), same(2), same(3), same(4), { ...same(5), status: 'DRAFT' }, { ...same(6), project_name: 'Other' }];
    mount();
    await flush();
    const top = [...container.querySelectorAll('[aria-label="Projects"] > li')];
    // Three entries: the grouped project (newest first) with its fold, the draft, and the other project.
    expect(container.querySelectorAll('[aria-label="Projects"] > li.mc-project')).toHaveLength(3);
    const group = container.querySelector('.mc-project-group');
    expect(group.querySelector('summary').textContent).toBe('3 earlier versions with the same name');
    expect(group.querySelectorAll('.mc-project-sub > li.mc-project')).toHaveLength(3);
    expect(top.length).toBe(4);
  });
});
