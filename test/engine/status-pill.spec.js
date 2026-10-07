// The header status pill: its priority order, its popover behaviour, and the stop-all-agents wiring through the breaker bar.
// Markup comes from the real page template so the data attributes stay in step with src/mission-control-page.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { mountBreakerBar } from '../../public/js/engine/breaker-bar.js';
import { formatAge, mountStatusPill, summarizeStatus } from '../../public/js/engine/status-pill.js';
import { renderMissionControlPage } from '../../src/mission-control-page.js';

describe('summarizeStatus priority', () => {
  const idle = { breaker: { state: 'ACTIVE' }, agents: { working: 0, total: 1 }, waiting: 0, elarion: { hidden: false, kind: 'running' } };

  it('is All idle when nothing needs anything', () => {
    expect(summarizeStatus(idle)).toEqual({ kind: 'idle', text: 'All idle' });
  });

  it('ranks Halted over engine trouble over Needs you over working over setup', () => {
    const busy = { ...idle, agents: { working: 2, total: 3 }, waiting: 1, elarion: { hidden: false, kind: 'alert' } };
    expect(summarizeStatus({ ...busy, breaker: { state: 'HALTED' } }).text).toBe('Halted');
    expect(summarizeStatus({ ...busy, breaker: { state: 'OFFLINE' } }).text).toBe('Engine offline');
    expect(summarizeStatus({ ...busy, breaker: { state: 'AUTH' } }).text).toBe('Sign-in needed');
    expect(summarizeStatus({ ...busy, breaker: { state: 'ERROR' } }).text).toBe('Engine error');
    expect(summarizeStatus(busy)).toEqual({ kind: 'alert', text: 'Needs you · 1' });
    expect(summarizeStatus({ ...busy, waiting: 0 })).toEqual({ kind: 'running', text: '2 working' });
    expect(summarizeStatus({ ...busy, waiting: 0, agents: { working: 0, total: 3 } })).toEqual({ kind: 'alert', text: 'Setup needed' });
    expect(summarizeStatus({ breaker: { state: 'CONNECTING' } }).text).toBe('Checking');
  });

  it('formats how long ago the engine answered', () => {
    expect(formatAge(1000)).toBe('just now');
    expect(formatAge(4000)).toBe('just now');
    expect(formatAge(12000)).toBe('12 s ago');
    expect(formatAge(125000)).toBe('2 min ago');
    expect(formatAge(7300000)).toBe('2 h ago');
  });
});

describe('status pill popover', () => {
  let root, pill, status, outside;

  beforeEach(() => {
    const html = renderMissionControlPage({ assetVersion: 'v1' });
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    root = document.getElementById('mc-status');
    pill = root.querySelector('[data-status="pill"]');
    outside = document.createElement('button');
    document.body.append(outside);
    status = mountStatusPill(root);
  });

  afterEach(() => {
    status.destroy();
    document.body.innerHTML = '';
  });

  it('shows a worded state with a full accessible name, not colour alone', () => {
    status.update({ breaker: { state: 'ACTIVE' } });
    expect(pill.textContent.trim()).toBe('All idle');
    expect(pill.getAttribute('aria-label')).toBe('Fleet status: All idle. Open details.');
    expect(pill.getAttribute('aria-haspopup')).toBe('dialog');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    status.update({ agents: { working: 2, total: 3 } });
    expect(pill.dataset.kind).toBe('running');
    expect(pill.textContent.trim()).toBe('2 working');
  });

  it('opens on click with focus on the panel, and Escape closes it and returns focus to the pill', () => {
    pill.click();
    const panel = document.getElementById('mc-status-panel');
    expect(panel.hidden).toBe(false);
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(pill);
  });

  it('closes on an outside press but not on a press inside, and stays open while the stop dialog is up', () => {
    pill.click();
    const panel = document.getElementById('mc-status-panel');
    panel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(false);
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop engine-modal';
    document.body.append(dialog);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(false);
    dialog.hidden = true;
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it('announces changes politely, and Halted through the alert region', () => {
    status.update({ breaker: { state: 'ACTIVE' } });
    status.update({ agents: { working: 1, total: 1 } });
    expect(root.querySelector('[data-status="live"]').textContent).toBe('Fleet status: 1 working');
    status.update({ breaker: { state: 'HALTED', reason: 'Operator manual trip from Portal UI' } });
    expect(root.querySelector('[data-status="alert"]').textContent).toBe('Fleet status: Halted');
    expect(root.querySelector('[data-status="cutoff"]').textContent).toContain('On. Agents are stopped');
  });

  it('offers Retry when the engine is unreachable and reports the engine action', () => {
    const onEngineAction = vi.fn();
    status.destroy();
    status = mountStatusPill(root, { onEngineAction });
    status.update({ breaker: { state: 'OFFLINE' } });
    const action = root.querySelector('[data-status="engine-action"]');
    expect(action.hidden).toBe(false);
    expect(action.textContent).toBe('Retry');
    action.click();
    expect(onEngineAction).toHaveBeenCalledWith('OFFLINE');
    status.update({ breaker: { state: 'AUTH' } });
    expect(action.textContent).toBe('Check connection');
    status.update({ breaker: { state: 'ACTIVE' } });
    expect(action.hidden).toBe(true);
  });
});

describe('stop all agents through the breaker bar', () => {
  let calls, api, failing, bar, slot;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    failing = new Set();
    let state = 'ACTIVE';
    const fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      const reply = (code, data) => new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } });
      if ((init.method || 'GET') === 'GET') return reply(200, { agent_id: 'master-brain', state, updated_at: 'x' });
      calls.push({ path, agent: body.agent_id });
      if (failing.has(body.agent_id)) return reply(500, { error: 'boom' });
      if (path === '/api/agents/trip-breaker' && body.agent_id === 'master-brain') state = 'HALTED';
      return reply(200, { status: 'HALTED', logged: true });
    };
    api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch, getToken: () => null });
    slot = document.createElement('div');
    document.body.append(slot);
  });

  afterEach(() => {
    if (bar) bar.destroy();
    slot.remove();
    bar = null;
    vi.useRealTimers();
  });

  const mount = (extra = {}) => {
    bar = mountBreakerBar(slot, {
      api,
      labels: { trip: { long: 'Stop all agents', short: 'Stop', aria: 'Stop all agents' }, confirmTitle: 'Stop all agents?', confirmAction: 'Stop all agents', confirmText: (id, others) => 'Stops ' + id + ' and ' + others.length + ' others' },
      getTripTargets: () => ['master-brain', 'atlas', 'quartz'],
      ...extra,
    });
    return bar;
  };

  it('uses the plain labels and names the agents it will stop', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const { tripButton, confirmModal } = bar.elements;
    expect(tripButton.getAttribute('aria-label')).toBe('Stop all agents');
    tripButton.click();
    expect(confirmModal.hidden).toBe(false);
    expect(confirmModal.querySelector('h3').textContent).toBe('Stop all agents?');
    expect(confirmModal.querySelector('.engine-modal-text').textContent).toBe('Stops master-brain and 2 others');
  });

  it('trips the master and every other agent, once each', async () => {
    const onStopped = vi.fn();
    mount({ onStopped });
    await vi.advanceTimersByTimeAsync(0);
    bar.elements.tripButton.click();
    bar.elements.confirmTrip.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.agent).sort()).toEqual(['atlas', 'master-brain', 'quartz']);
    expect(bar.getState()).toBe('HALTED');
    expect(onStopped).toHaveBeenCalled();
    expect(bar.elements.confirmModal.hidden).toBe(true);
  });

  it('keeps the dialog open and names the agents that did not stop, and Stop again retries only those', async () => {
    failing.add('quartz');
    mount();
    await vi.advanceTimersByTimeAsync(0);
    bar.elements.tripButton.click();
    bar.elements.confirmTrip.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bar.getState()).toBe('HALTED');
    expect(bar.elements.confirmModal.hidden).toBe(false);
    expect(bar.elements.confirmModal.querySelector('.modal-error').textContent).toContain('quartz');
    expect(bar.elements.tripButton.disabled).toBe(false);

    calls.length = 0;
    failing.clear();
    bar.elements.confirmTrip.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.agent).sort()).toEqual(['atlas', 'quartz']);
    expect(bar.elements.confirmModal.hidden).toBe(true);
  });

  it('reports state and sync time to onChange', async () => {
    const seen = [];
    mount({ onChange: (b) => seen.push(b) });
    await vi.advanceTimersByTimeAsync(0);
    const last = seen[seen.length - 1];
    expect(last.state).toBe('ACTIVE');
    expect(typeof last.syncedAt).toBe('number');
  });
});
