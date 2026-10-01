// Engine connection: token bootstrap order (portal-minted, stored, none) and the connection panel.
import { describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { bootstrapEngineToken, checkEngineUrl, describeToken, mountConnection, sanitizeEngineUrl } from '../../public/js/engine/connection.js';

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

  it('keeps the HTTP status when the token endpoint fails', async () => {
    const state = await bootstrapEngineToken({ fetch: portal(500, { error: 'boom' }).fetchImpl, ...memoryToken() });
    expect(state).toMatchObject({ source: 'none', portal: 'error', portalStatus: 500 });
  });

  it('describes token claims', () => {
    expect(describeToken(null)).toEqual({ present: false });
    expect(describeToken('a.b')).toEqual({ present: true, malformed: true });
    expect(describeToken(makeJwt({ sub: 'u', exp: 1 }))).toMatchObject({ sub: 'u', expired: true });
  });
});

describe('connection panel', () => {
  async function panel(status, body, initial, extra = {}) {
    const details = document.createElement('details');
    document.body.append(details);
    const store = memoryToken(initial);
    const connection = await mountConnection(details, { baseUrl: 'http://localhost:3333', fetch: portal(status, body).fetchImpl, ...store, ...extra });
    return { details, store, connection };
  }

  it('shows the portal session token and no manual form', async () => {
    const { details, connection } = await panel(200, { token: makeJwt({ sub: 'portal:u', exp: inSeconds(3600) }) });
    expect(details.querySelector('summary').textContent).toBe('Engine connection · localhost:3333 · portal session token');
    expect(details.querySelector('.mc-connection-manual').hidden).toBe(true);
    expect(details.querySelector('.mc-connection-why').hidden).toBe(true);
    connection.destroy();
  });

  it('offers a pasted-token fallback, with the reason, when the portal cannot mint tokens', async () => {
    const { details, store, connection } = await panel(404, { configured: false });
    expect(details.querySelector('summary').textContent).toBe('Engine connection · localhost:3333 · no token');
    expect(details.querySelector('.mc-connection-why').textContent).toBe('The portal can’t mint engine tokens: ENGINE_JWT_SECRET is not set on the Worker (HTTP 404).');
    const form = details.querySelector('.mc-connection-manual');
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
    expect(details.querySelector('summary').textContent).toBe('Engine connection · localhost:3333 · stored token');
    connection.destroy();
  });

  it('names other token endpoint failures by status', async () => {
    const { details, connection } = await panel(500, { error: 'boom' });
    expect(details.querySelector('.mc-connection-why').textContent).toBe('The portal’s token endpoint failed (HTTP 500).');
    expect(details.querySelector('.mc-connection-manual').hidden).toBe(false);
    connection.destroy();
  });

  it('saves an https engine URL and reloads; rejects plain http to another machine', async () => {
    let reloads = 0;
    const { details, connection } = await panel(200, { token: makeJwt({ sub: 'portal:u', exp: inSeconds(3600) }) }, null, { reload: () => reloads++, pageProtocol: 'https:' });
    const form = details.querySelector('.mc-connection-url');
    const input = form.querySelector('input');
    expect(input.value).toBe('http://localhost:3333');
    input.value = 'http://192.168.1.20:3333';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(form.querySelector('.modal-error').textContent).toMatch(/browsers block a plain-http engine/);
    expect(reloads).toBe(0);
    input.value = 'https://engine-abc.trycloudflare.com/';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(localStorage.getItem('aether.engine.baseUrl')).toBe('https://engine-abc.trycloudflare.com');
    expect(reloads).toBe(1);
    localStorage.removeItem('aether.engine.baseUrl');
    connection.destroy();
  });

  it('takes a pasted host without https://, saves it, and the next page load uses it (no reset to localhost)', async () => {
    let reloads = 0;
    const { details, connection } = await panel(404, {}, null, { reload: () => reloads++, pageProtocol: 'https:' });
    const form = details.querySelector('.mc-connection-url');
    const input = form.querySelector('input');
    // No native URL validation that could block the tap on "Use this engine".
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('url');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(form.hasAttribute('novalidate')).toBe(true);

    input.value = '  xyz.trycloudflare.com/ ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(input.value).toBe('https://xyz.trycloudflare.com');
    expect(localStorage.getItem('aether.engine.baseUrl')).toBe('https://xyz.trycloudflare.com');
    expect(form.querySelector('.modal-error').textContent).toBe('Saved. Connecting to xyz.trycloudflare.com…');
    expect(reloads).toBe(1);
    // What the reloaded page builds: a default client reads the saved address.
    expect(createEngineApi().baseUrl).toBe('https://xyz.trycloudflare.com');
    connection.destroy();

    // After the reload, the panel shows the saved engine, and re-saving it doesn't reload again.
    const again = await panel(404, {}, null, { baseUrl: 'https://xyz.trycloudflare.com', reload: () => reloads++, pageProtocol: 'https:' });
    const form2 = again.details.querySelector('.mc-connection-url');
    expect(form2.querySelector('input').value).toBe('https://xyz.trycloudflare.com');
    expect(again.details.querySelector('summary').textContent).toBe('Engine connection · xyz.trycloudflare.com · no token');
    form2.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(reloads).toBe(1);
    expect(form2.querySelector('.modal-error').textContent).toBe('Already using xyz.trycloudflare.com.');
    // Back to localhost clears the setting.
    [...form2.querySelectorAll('button')].find((b) => b.textContent === 'Back to localhost').click();
    expect(localStorage.getItem('aether.engine.baseUrl')).toBe(null);
    expect(reloads).toBe(2);
    again.connection.destroy();
  });

  it('reports blocked storage instead of reloading into localhost', async () => {
    let reloads = 0;
    const blocked = {
      setItem() {
        throw new Error('QuotaExceededError');
      },
      removeItem() {},
      getItem: () => null,
    };
    const { details, connection } = await panel(404, {}, null, { reload: () => reloads++, pageProtocol: 'https:', storage: blocked });
    const form = details.querySelector('.mc-connection-url');
    form.querySelector('input').value = 'xyz.trycloudflare.com';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(form.querySelector('.modal-error').textContent).toMatch(/didn’t let the page save/);
    expect(reloads).toBe(0);
    connection.destroy();
  });
});

describe('sanitizeEngineUrl', () => {
  it('adds https:// when the scheme is missing (http:// for localhost)', () => {
    expect(sanitizeEngineUrl('xyz.trycloudflare.com')).toBe('https://xyz.trycloudflare.com');
    expect(sanitizeEngineUrl('engine.example.com/base/')).toBe('https://engine.example.com/base');
    expect(sanitizeEngineUrl('localhost:3333')).toBe('http://localhost:3333');
    expect(sanitizeEngineUrl('127.0.0.1:3333/')).toBe('http://127.0.0.1:3333');
    expect(sanitizeEngineUrl('//xyz.trycloudflare.com')).toBe('https://xyz.trycloudflare.com');
  });

  it('strips whitespace, invisible characters, quotes and trailing slashes from pasted text', () => {
    expect(sanitizeEngineUrl('  "https://xyz.trycloudflare.com///"\n')).toBe('https://xyz.trycloudflare.com');
    expect(sanitizeEngineUrl('\u200bxyz.try\u00a0cloudflare.com\ufeff')).toBe('https://xyz.trycloudflare.com');
    expect(sanitizeEngineUrl('<https://xyz.trycloudflare.com>')).toBe('https://xyz.trycloudflare.com');
    expect(sanitizeEngineUrl('HTTPS://XYZ.trycloudflare.com')).toBe('HTTPS://XYZ.trycloudflare.com');
    expect(sanitizeEngineUrl('   ')).toBe('');
  });
});

describe('checkEngineUrl', () => {
  it('accepts a bare tunnel host and normalizes it', () => {
    expect(checkEngineUrl('xyz.trycloudflare.com ', 'https:')).toEqual({ ok: true, url: 'https://xyz.trycloudflare.com', warning: '' });
    expect(checkEngineUrl('HTTPS://XYZ.trycloudflare.com/', 'https:').url).toBe('https://xyz.trycloudflare.com');
    expect(checkEngineUrl('', 'https:').error).toMatch(/Enter the engine address/);
    expect(checkEngineUrl('engine', 'https:').ok).toBe(false);
  });

  it('accepts https and local http, refuses http elsewhere from an https page', () => {
    expect(checkEngineUrl('https://e.example.com/x/', 'https:')).toEqual({ ok: true, url: 'https://e.example.com/x', warning: '' });
    expect(checkEngineUrl('http://localhost:3333', 'https:')).toMatchObject({ ok: true, url: 'http://localhost:3333' });
    expect(checkEngineUrl('http://10.0.0.5:3333', 'https:').ok).toBe(false);
    expect(checkEngineUrl('http://10.0.0.5:3333', 'http:').ok).toBe(true);
    expect(checkEngineUrl('ftp://x', 'https:').ok).toBe(false);
    expect(checkEngineUrl('not a url', 'https:').ok).toBe(false);
  });
});
