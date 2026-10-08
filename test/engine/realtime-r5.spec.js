// Phase 10 R5: spoken and screen-reader alerts for task.awaiting, and adaptive polling while the stream covers the engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { HEARTBEAT_MAX_MS, HEARTBEAT_MIN_MS, heartbeatMs, isCovered, mountPollRate, pollDelay } from '../../public/js/engine/poll-rate.js';
import { alertText, mountRealtimeAlerts, SPEAK_PREFERENCE_KEY } from '../../public/js/engine/realtime-alerts.js';
import { mountTaskMonitor } from '../../public/js/engine/task-monitor.js';

const status = (win, live, engine) => win.dispatchEvent(new CustomEvent('aether-realtime-status', { detail: { live, engine } }));

describe('heartbeatMs', () => {
  it('stretches a normal interval six times, between 15 s and 60 s', () => {
    expect(heartbeatMs(2000)).toBe(HEARTBEAT_MIN_MS);
    expect(heartbeatMs(4000)).toBe(24000);
    expect(heartbeatMs(5000)).toBe(30000);
    expect(heartbeatMs(30000)).toBe(HEARTBEAT_MAX_MS);
  });
});

describe('poll rate', () => {
  let rate;
  afterEach(() => rate && rate.stop());

  it('leaves intervals alone until the stream is live and the engine is pushing behind it', () => {
    const win = new EventTarget();
    rate = mountPollRate(win);
    expect(isCovered()).toBe(false);
    expect(pollDelay(2000)).toBe(2000);
    status(win, true, false); // socket up, engine not connected: nothing would tell us about changes
    expect(pollDelay(2000)).toBe(2000);
    status(win, false, false);
    expect(pollDelay(2000)).toBe(2000);
    status(win, true, true);
    expect(isCovered()).toBe(true);
    expect(pollDelay(2000)).toBe(15000);
    expect(pollDelay(5000)).toBe(30000);
  });

  it('refreshes everything once when coverage is lost, and not when it was never there', () => {
    const win = new EventTarget();
    const lost = vi.fn();
    rate = mountPollRate(win, { onUncovered: lost });
    status(win, false, false);
    expect(lost).not.toHaveBeenCalled();
    status(win, true, true);
    status(win, true, true);
    expect(lost).not.toHaveBeenCalled();
    status(win, true, false); // the engine said goodbye
    expect(lost).toHaveBeenCalledTimes(1);
    expect(pollDelay(5000)).toBe(5000);
    status(win, true, true);
    status(win, false, false); // the socket dropped
    expect(lost).toHaveBeenCalledTimes(2);
  });

  it('starts from the status the boot script already recorded', () => {
    const win = new EventTarget();
    win.AetherRealtimeStatus = { live: true, engine: true };
    rate = mountPollRate(win);
    expect(pollDelay(4000)).toBe(24000);
  });

  it('goes back to normal when stopped', () => {
    const win = new EventTarget();
    mountPollRate(win).stop();
    expect(isCovered()).toBe(false);
  });
});

// The task monitor, which polls every 2 s while something runs, against a fake engine.
describe('a poller on the stretched schedule', () => {
  let monitor, container, win, rate, calls;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = 0;
    const running = { task_id: 't', agent_id: 'a', run_id: 'r', status: 'RUNNING', total_steps: 2, completed_steps: 0, current_step: null, interrupted_step_index: null, total_tokens: { input: 0, output: 0 }, started_at: '2026-10-08T00:00:00.000Z', finished_at: null };
    const fetch = async (url) => {
      const { pathname } = new URL(url);
      const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      if (pathname === '/api/tasks') {
        calls++;
        return reply({ tasks: [running], counts: { running: 1, completed: 0, halted: 0, failed: 0 } });
      }
      return reply({ success: true, count: 0, artifacts: [] });
    };
    container = document.createElement('div');
    document.body.append(container);
    monitor = mountTaskMonitor(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch }) });
    win = new EventTarget();
  });

  afterEach(() => {
    monitor.destroy();
    rate && rate.stop();
    container.remove();
    vi.useRealTimers();
  });

  it('polls every 2 s normally, every 15 s while covered, and again at 2 s once coverage is lost', async () => {
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);

    rate = mountPollRate(win, { onUncovered: () => monitor.refresh() });
    status(win, true, true);
    monitor.refresh(); // a poll re-arms the timer, now on the slow schedule
    await vi.advanceTimersByTimeAsync(0);
    const slowStart = calls;
    await vi.advanceTimersByTimeAsync(14000);
    expect(calls).toBe(slowStart);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(slowStart + 1);

    status(win, true, false); // coverage lost: refresh now, back to 2 s
    await vi.advanceTimersByTimeAsync(0);
    const afterLoss = calls;
    expect(afterLoss).toBeGreaterThan(slowStart + 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(afterLoss + 1);
  });
});

describe('alertText', () => {
  const awaiting = { topic: 'engine', type: 'task.awaiting', data: { task_id: 't1', agent_id: 'master-brain', question: 'Ship it?' } };

  it('names the agent readably and gives the question', () => {
    expect(alertText(awaiting)).toBe('Elarion is waiting for your answer: Ship it?');
    expect(alertText({ ...awaiting, data: { ...awaiting.data, agent_id: 'build-bot' } })).toBe('Build bot is waiting for your answer: Ship it?');
  });

  it('announces a trip only as a change from a state it saw', () => {
    const known = new Map();
    const state = (agent_id, st, reason) => ({ topic: 'engine', type: 'agent.state', data: { agent_id, state: st, ...(reason ? { reason } : {}) } });
    expect(alertText(state('a1', 'HALTED', 'x'), known)).toBeNull(); // first sighting
    expect(alertText(state('a2', 'ACTIVE'), known)).toBeNull();
    expect(alertText(state('a2', 'HALTED', 'Paused from Mission Control'), known)).toBe('A2 has been halted: Paused from Mission Control');
    expect(alertText(state('a2', 'HALTED', 'again'), known)).toBeNull(); // still halted
  });

  it('ignores everything else', () => {
    for (const event of [null, { topic: 'graph', type: 'node.updated' }, { topic: 'engine', type: 'task.step', data: {} }, { topic: 'engine', type: 'engine.hello', data: { version: '1' } }]) {
      expect(alertText(event)).toBeNull();
    }
  });
});

describe('mountRealtimeAlerts', () => {
  const NOW = Date.parse('2026-10-08T12:00:00.000Z');
  const make = (extra = {}) => {
    const win = new EventTarget();
    const spoken = [];
    const said = [];
    class Utterance {
      constructor(text) {
        this.text = text;
      }
    }
    const storage = { values: {}, getItem(k) { return k in this.values ? this.values[k] : null; } };
    const alerts = mountRealtimeAlerts(win, { announce: (text) => said.push(text), synth: { speak: (u) => spoken.push(u.text) }, Utterance, storage, now: () => NOW, ...extra });
    const send = (seq, type, data, ageMs = 1000) => win.dispatchEvent(new CustomEvent('aether-realtime-event', { detail: { v: 1, seq, at: new Date(NOW - ageMs).toISOString(), topic: 'engine', type, data } }));
    return { win, alerts, send, spoken, said, storage };
  };
  const ask = { task_id: 't1', agent_id: 'master-brain', question: 'Ship it?' };

  it('announces and speaks a task waiting for the operator', () => {
    const { send, spoken, said } = make();
    send(10, 'task.awaiting', ask);
    expect(said).toEqual(['Elarion is waiting for your answer: Ship it?']);
    expect(spoken).toEqual(said);
  });

  it('only announces to the screen reader when voice replies are muted in the dock', () => {
    const { send, spoken, said, storage } = make();
    storage.values[SPEAK_PREFERENCE_KEY] = 'false';
    send(10, 'task.awaiting', ask);
    expect(said).toHaveLength(1);
    expect(spoken).toEqual([]);
  });

  it('still announces where speech synthesis does not exist', () => {
    const { send, said } = make({ synth: null });
    send(10, 'task.awaiting', ask);
    expect(said).toHaveLength(1);
  });

  it('skips events older than a minute (a replay after a reconnect) and repeats of the same seq', () => {
    const { send, said } = make();
    send(10, 'task.awaiting', ask, 61000);
    expect(said).toEqual([]);
    send(11, 'task.awaiting', { ...ask, task_id: 't2' });
    send(11, 'task.awaiting', { ...ask, task_id: 't2' });
    expect(said).toHaveLength(1);
  });

  it('stays quiet for the snapshot a reconnecting engine resends, but asks again for a re-run', () => {
    const { send, said } = make();
    send(10, 'task.awaiting', ask);
    send(20, 'task.awaiting', ask); // same task, same question, resent after the engine reconnected
    expect(said).toHaveLength(1);
    send(21, 'task.choice', { task_id: 't1', option: '1' });
    send(22, 'task.awaiting', ask); // the same task id, asked again after it was answered
    expect(said).toHaveLength(2);
    send(23, 'task.finished', { task_id: 't1', agent_id: 'master-brain', status: 'done' });
    send(24, 'task.awaiting', ask);
    expect(said).toHaveLength(3);
  });

  it('announces every trip, even with the same reason as the last, and not the first sighting', () => {
    const { send, said } = make();
    send(1, 'agent.state', { agent_id: 'a1', state: 'HALTED', reason: 'Paused' }); // joined while halted: silent
    send(2, 'agent.state', { agent_id: 'a1', state: 'ACTIVE' });
    send(3, 'agent.state', { agent_id: 'a1', state: 'HALTED', reason: 'Paused' });
    send(4, 'agent.state', { agent_id: 'a1', state: 'ACTIVE' });
    send(5, 'agent.state', { agent_id: 'a1', state: 'HALTED', reason: 'Paused' });
    expect(said).toEqual(['A1 has been halted: Paused', 'A1 has been halted: Paused']);
  });

  it('does not move focus', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const { send } = make();
    send(10, 'task.awaiting', ask);
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('stops listening when stopped', () => {
    const { alerts, send, said } = make();
    alerts.stop();
    send(10, 'task.awaiting', ask);
    expect(said).toEqual([]);
  });
});
