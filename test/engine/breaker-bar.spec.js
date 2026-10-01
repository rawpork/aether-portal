// Breaker bar against the real client bundle, with fetch answered by a simulated engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { BREAKER_AGENT_ID, MANUAL_TRIP_REASON, describeToken, mountBreakerBar } from '../../public/js/engine/breaker-bar.js';

const b64url = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const makeJwt = (claims) => b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url(claims) + '.sig';

// Simulated Aether_Engine: one agent record, plus switches for outages.
function createEngine() {
  const engine = {
    state: 'ACTIVE',
    reason: undefined,
    mode: 'ok', // 'ok' | 'offline' | 'unauthorized' | 'trip-fails'
    calls: [],
    async fetch(url, init = {}) {
      const path = new URL(url).pathname;
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      engine.calls.push({ method, path, body, auth: init.headers && init.headers.Authorization });
      const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

      if (engine.mode === 'offline') throw new TypeError('Failed to fetch');
      if (engine.mode === 'unauthorized') return reply(401, { error: 'Missing or malformed Authorization header.' });

      if (method === 'GET' && path === '/api/agents/' + BREAKER_AGENT_ID + '/state') {
        return reply(200, { agent_id: BREAKER_AGENT_ID, state: engine.state, reason: engine.reason, updated_at: '2026-10-01T00:00:00.000Z' });
      }
      if (method === 'POST' && path === '/api/agents/trip-breaker') {
        if (engine.mode === 'trip-fails') return reply(500, { error: 'Auth misconfigured: SUPABASE_JWT_SECRET is not set.' });
        engine.state = 'HALTED';
        engine.reason = body.reason;
        return reply(200, { status: 'HALTED', logged: true, timestamp: '2026-10-01T00:00:01.000Z' });
      }
      if (method === 'POST' && path === '/api/agents/reset') {
        if (engine.state !== 'HALTED') return reply(409, { error: 'Agent ' + body.agent_id + ' is not HALTED; nothing to reset.', state: engine.state });
        engine.state = 'ACTIVE';
        engine.reason = undefined;
        return reply(200, { status: 'ACTIVE', reset: true, logged: true, timestamp: '2026-10-01T00:00:02.000Z' });
      }
      if (method === 'POST' && path === '/api/master-brain/chat') {
        if (engine.state === 'HALTED') {
          return reply(423, { error: 'Agent execution is currently HALTED by circuit breaker', agent_id: BREAKER_AGENT_ID, status: 'HALTED', reason: engine.reason });
        }
        return reply(200, { session_id: body.session_id, response: 'ok', tokens: { input: 1, output: 1 }, status: 'ACTIVE' });
      }
      return reply(404, { error: 'not found' });
    },
    count(method, path) {
      return engine.calls.filter((c) => c.method === method && c.path === path).length;
    },
  };
  return engine;
}

const STATE_PATH = '/api/agents/' + BREAKER_AGENT_ID + '/state';
const flush = () => vi.advanceTimersByTimeAsync(0);

let engine, token, api, bar, slot;

function mount() {
  slot = document.createElement('div');
  slot.id = 'engine-bar-test';
  document.body.append(slot);
  bar = mountBreakerBar(slot, {
    api,
    getToken: () => token,
    setToken: (value) => {
      token = value;
    },
  });
  return bar;
}

beforeEach(() => {
  vi.useFakeTimers();
  engine = createEngine();
  token = null;
  api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch, getToken: () => token });
});

afterEach(() => {
  bar && bar.destroy();
  slot && slot.remove();
  bar = slot = null;
  vi.useRealTimers();
});

describe('status bar state', () => {
  it('shows ACTIVE (green) after a 200 ACTIVE poll, with RESET hidden', async () => {
    const { elements } = mount();
    expect(elements.badge.dataset.state).toBe('CONNECTING');
    await flush();
    expect(elements.badge.dataset.state).toBe('ACTIVE');
    expect(elements.badge.textContent).toContain('ACTIVE');
    expect(elements.resetButton.hidden).toBe(true);
    expect(elements.tripButton.disabled).toBe(false);
  });

  it('polls every 5 seconds and switches to HALTED when the engine reports it', async () => {
    const { elements } = mount();
    await flush();
    expect(engine.count('GET', STATE_PATH)).toBe(1);

    engine.state = 'HALTED';
    engine.reason = 'Budget cap reached';
    await vi.advanceTimersByTimeAsync(4999);
    expect(elements.badge.dataset.state).toBe('ACTIVE');
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.count('GET', STATE_PATH)).toBe(2);
    expect(elements.badge.dataset.state).toBe('HALTED');
    expect(elements.badge.title).toContain('Budget cap reached');
    expect(elements.resetButton.hidden).toBe(false);
    expect(elements.tripButton.disabled).toBe(true);
  });

  it('turns HALTED at once on a 423 from any other engine call, without waiting for a poll', async () => {
    const { elements } = mount();
    await flush();
    engine.state = 'HALTED';
    engine.reason = 'Tripped by a teammate';
    const polls = engine.count('GET', STATE_PATH);

    const error = await api.sendMasterBrainChat('status?', 's1').catch((e) => e);
    expect(error.status).toBe(423);
    expect(elements.badge.dataset.state).toBe('HALTED');
    expect(elements.badge.title).toContain('Tripped by a teammate');
    expect(engine.count('GET', STATE_PATH)).toBe(polls);
  });

  it('shows ENGINE OFFLINE when unreachable, backs off to 30s, and retries on badge click', async () => {
    engine.mode = 'offline';
    const { elements } = mount();
    await flush();
    expect(elements.badge.dataset.state).toBe('OFFLINE');
    expect(elements.tripButton.disabled).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.count('GET', STATE_PATH)).toBe(1);
    engine.mode = 'ok';
    elements.badge.click();
    await flush();
    expect(elements.badge.dataset.state).toBe('ACTIVE');
  });

  it('shows TOKEN NEEDED on 401 and opens the token modal from the badge', async () => {
    engine.mode = 'unauthorized';
    const { elements } = mount();
    await flush();
    expect(elements.badge.dataset.state).toBe('AUTH');
    elements.badge.click();
    expect(elements.tokenModal.hidden).toBe(false);
  });
});

describe('TRIP BREAKER', () => {
  it('asks for confirmation first and does nothing on Cancel', async () => {
    const { elements } = mount();
    await flush();
    elements.tripButton.click();
    expect(elements.confirmModal.hidden).toBe(false);
    expect(document.activeElement).toBe(elements.confirmCancel);
    elements.confirmCancel.click();
    await flush();
    expect(elements.confirmModal.hidden).toBe(true);
    expect(engine.count('POST', '/api/agents/trip-breaker')).toBe(0);
    expect(elements.badge.dataset.state).toBe('ACTIVE');
  });

  it('closes on Escape without tripping', async () => {
    const { elements } = mount();
    await flush();
    elements.tripButton.click();
    elements.confirmModal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(elements.confirmModal.hidden).toBe(true);
    expect(engine.count('POST', '/api/agents/trip-breaker')).toBe(0);
  });

  it('trips master-brain with the operator reason on confirm and shows HALTED + RESET', async () => {
    const { elements } = mount();
    await flush();
    elements.tripButton.click();
    elements.confirmTrip.click();
    await flush();

    const trip = engine.calls.find((c) => c.path === '/api/agents/trip-breaker');
    expect(trip.body).toEqual({ agent_id: 'master-brain', reason: 'Operator manual trip from Portal UI' });
    expect(MANUAL_TRIP_REASON).toBe('Operator manual trip from Portal UI');
    expect(elements.confirmModal.hidden).toBe(true);
    expect(elements.badge.dataset.state).toBe('HALTED');
    expect(elements.resetButton.hidden).toBe(false);
    expect(elements.tripButton.disabled).toBe(true);
  });

  it('keeps the dialog open with the error when the trip fails', async () => {
    engine.mode = 'trip-fails';
    const { elements } = mount();
    await flush();
    elements.tripButton.click();
    elements.confirmTrip.click();
    await flush();
    expect(elements.confirmModal.hidden).toBe(false);
    expect(elements.confirmModal.textContent).toContain('Trip failed: Auth misconfigured');
    expect(elements.badge.dataset.state).toBe('ACTIVE');
    expect(elements.tripButton.disabled).toBe(false);
  });
});

describe('RESET AGENT', () => {
  it('resets a HALTED agent back to ACTIVE', async () => {
    engine.state = 'HALTED';
    engine.reason = 'Earlier trip';
    const { elements } = mount();
    await flush();
    expect(elements.badge.dataset.state).toBe('HALTED');

    elements.resetButton.click();
    await flush();
    expect(engine.calls.find((c) => c.path === '/api/agents/reset').body).toEqual({ agent_id: 'master-brain' });
    expect(elements.badge.dataset.state).toBe('ACTIVE');
    expect(elements.resetButton.hidden).toBe(true);
    expect(elements.tripButton.disabled).toBe(false);
  });

  it('re-reads the state when the agent was already reset elsewhere (409)', async () => {
    engine.state = 'HALTED';
    const { elements } = mount();
    await flush();
    engine.state = 'ACTIVE';
    elements.resetButton.click();
    await flush();
    expect(elements.badge.dataset.state).toBe('ACTIVE');
    expect(elements.resetButton.hidden).toBe(true);
  });
});

describe('engine token modal', () => {
  it('reports no stored token, rejects a non-JWT, and saves a valid one that later polls send', async () => {
    const { elements } = mount();
    await flush();
    elements.tokenButton.click();
    expect(elements.tokenModal.hidden).toBe(false);
    expect(elements.tokenStatus.textContent).toContain('No token stored');

    elements.tokenInput.value = 'not-a-jwt';
    elements.tokenForm.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(elements.tokenError.textContent).toContain('Paste a JWT');
    expect(token).toBe(null);

    const jwt = makeJwt({ sub: 'operator-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    elements.tokenInput.value = '  ' + jwt + '\n';
    elements.tokenForm.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(token).toBe(jwt);
    expect(elements.tokenModal.hidden).toBe(true);
    expect(engine.calls.at(-1).auth).toBe('Bearer ' + jwt);

    elements.tokenButton.click();
    expect(elements.tokenStatus.textContent).toContain('subject operator-1');
    elements.tokenClear.click();
    await flush();
    expect(token).toBe(null);
    expect(engine.calls.at(-1).auth).toBeUndefined();
  });

  it('describes token claims for display', () => {
    expect(describeToken(null)).toEqual({ present: false });
    expect(describeToken('a.b')).toEqual({ present: true, malformed: true });
    const info = describeToken(makeJwt({ sub: 'u', exp: 1 }));
    expect(info.sub).toBe('u');
    expect(info.expired).toBe(true);
  });
});

it('stops polling after destroy', async () => {
  mount();
  await flush();
  bar.destroy();
  bar = null;
  await vi.advanceTimersByTimeAsync(20000);
  expect(engine.count('GET', STATE_PATH)).toBe(1);
});
