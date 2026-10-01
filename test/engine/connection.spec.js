// Engine connection: token bootstrap order (portal-minted, stored, none) and the connection panel.
import { describe, expect, it } from 'vitest';
import { bootstrapEngineToken, describeToken, mountConnection } from '../../public/js/engine/connection.js';

const b64url = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const makeJwt = (claims) => b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url(claims) + '.sig';
const inSeconds = (s) => Math.floor(Date.now() / 1000) + s;

function portal(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (status === 'offline') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(body || {}), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function memoryToken(initial = null) {
  const box = { value: initial };
  return { box, getToken: () => box.value, setToken: (v) => (box.value = v) };
}

describe('bootstrapEngineToken', () => {
  it('stores a portal-minted token with no manual step', async () => {
    const jwt = makeJwt({ sub: 'portal:user_1', exp: inSeconds(3600) });
    const { calls, fetchImpl } = portal(200, { token: jwt, expires_at: 'x' });
    const store = memoryToken();
    const state = await bootstrapEngineToken({ fetch: fetchImpl, ...store });
    expect(calls[0].url).toBe('/api/engine/token');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(store.box.value).toBe(jwt);
    expect(state.source).toBe('portal');
    expect(state.portal).toBe('ok');
  });

  it('prefers a fresh portal token over an older stored one', async () => {
    const fresh = makeJwt({ sub: 'portal:user_1', exp: inSeconds(3600) });
    const store = memoryToken(makeJwt({ sub: 'pasted', exp: inSeconds(600) }));
    await bootstrapEngineToken({ fetch: portal(200, { token: fresh }).fetchImpl, ...store });
    expect(store.box.value).toBe(fresh);
  });

  it('falls back to a valid stored token when the portal cannot mint (404)', async () => {
    const stored = makeJwt({ sub: 'pasted', exp: inSeconds(600) });
    const store = memoryToken(stored);
    const state = await bootstrapEngineToken({ fetch: portal(404, { configured: false }).fetchImpl, ...store });
    expect(state).toMatchObject({ source: 'stored', sub: 'pasted', portal: 'unconfigured' });
    expect(store.box.value).toBe(stored);
  });

  it('uses no token (engine bypass) and drops an expired one', async () => {
    const store = memoryToken(makeJwt({ sub: 'old', exp: inSeconds(-10) }));
    const state = await bootstrapEngineToken({ fetch: portal('offline').fetchImpl, ...store });
    expect(state).toMatchObject({ source: 'none', portal: 'unavailable' });
    expect(store.box.value).toBe(null);
  });

  it('reports a signed-out portal session', async () => {
    const state = await bootstrapEngineToken({ fetch: portal(401, { error: 'Unauthorized' }).fetchImpl, ...memoryToken() });
    expect(state).toMatchObject({ source: 'none', portal: 'signed-out' });
  });

  it('describes token claims', () => {
    expect(describeToken(null)).toEqual({ present: false });
    expect(describeToken('a.b')).toEqual({ present: true, malformed: true });
    expect(describeToken(makeJwt({ sub: 'u', exp: 1 }))).toMatchObject({ sub: 'u', expired: true });
  });
});

describe('connection panel', () => {
  async function panel(status, body, initial) {
    const details = document.createElement('details');
    document.body.append(details);
    const store = memoryToken(initial);
    const connection = await mountConnection(details, { baseUrl: 'http://localhost:3333', fetch: portal(status, body).fetchImpl, ...store });
    return { details, store, connection };
  }

  it('shows the portal session token and no manual form', async () => {
    const { details, connection } = await panel(200, { token: makeJwt({ sub: 'portal:u', exp: inSeconds(3600) }) });
    expect(details.querySelector('summary').textContent).toBe('Engine connection · portal session token');
    expect(details.querySelector('form').hidden).toBe(true);
    connection.destroy();
  });

  it('offers a pasted-token fallback only when the portal cannot mint tokens', async () => {
    const { details, store, connection } = await panel(404, { configured: false });
    expect(details.querySelector('summary').textContent).toBe('Engine connection · no token (local bypass)');
    const form = details.querySelector('form');
    expect(form.hidden).toBe(false);

    const textarea = form.querySelector('textarea');
    textarea.value = 'nope';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(form.querySelector('.modal-error').textContent).toMatch(/Paste a JWT/);

    const jwt = makeJwt({ sub: 'pasted', exp: inSeconds(600) });
    textarea.value = jwt;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.box.value).toBe(jwt);
    expect(details.querySelector('summary').textContent).toBe('Engine connection · stored token');
    connection.destroy();
  });
});
