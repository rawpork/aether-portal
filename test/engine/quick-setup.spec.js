// Quick Setup: Test & Pair Engine checks /health, sends the Miserly key to POST /api/engine/config, and drives the
// header's Elarion Ready badge.
import { afterEach, describe, expect, it } from 'vitest';
import { badgeState, mountQuickSetup, publicUrlFor } from '../../public/js/engine/quick-setup.js';

const READY = { miserly_key_configured: true, miserly_key_hint: '…abcd', miserly_key_status: 'verified', miserly_key_detail: 'ok', public_url: null, elarion_ready: true };
const MISSING = { miserly_key_configured: false, miserly_key_hint: null, miserly_key_status: 'missing', miserly_key_detail: 'No key', public_url: null, elarion_ready: false };

function fakeApi({ baseUrl = 'http://localhost:3333', config = MISSING, health = { status: 'healthy', system: 'Aether Engine Compiler' }, save } = {}) {
  const calls = [];
  return {
    calls,
    baseUrl,
    async getEngineHealth() {
      calls.push(['health']);
      if (health instanceof Error) throw health;
      return health;
    },
    async getEngineConfig() {
      calls.push(['config']);
      if (config instanceof Error) throw config;
      return config;
    },
    async saveEngineConfig(changes) {
      calls.push(['save', changes]);
      if (save instanceof Error) throw save;
      return save || READY;
    },
  };
}

const apiError = (status, message) => Object.assign(new Error(message), { status, isUnauthorized: status === 401 });
const flush = () => new Promise((r) => setTimeout(r, 0));

let qs;
afterEach(() => {
  qs && qs.destroy();
  qs = null;
  document.body.replaceChildren();
});

function mount(api, extra = {}) {
  document.body.innerHTML = '<button id="mc-ready" hidden><span class="ready-text"></span></button><div id="qs"></div>';
  qs = mountQuickSetup(document.getElementById('qs'), { api, badge: document.getElementById('mc-ready'), pageProtocol: 'https:', storage: localStorage, ...extra });
  return document.getElementById('mc-ready');
}

describe('quick setup', () => {
  it('shows Elarion Ready when the engine reports a verified key', async () => {
    const badge = mount(fakeApi({ config: READY }));
    await flush();
    expect(badge.hidden).toBe(false);
    expect(badge.dataset.kind).toBe('running');
    expect(badge.textContent).toBe('Elarion Ready');
    expect(qs.elements.keyHint.textContent).toContain('…abcd');
  });

  it('offers setup when the key is missing and hides the badge when the engine is unreachable', async () => {
    expect(badgeState(MISSING)).toMatchObject({ hidden: false, kind: 'alert', text: 'Set up Elarion' });
    const badge = mount(fakeApi({ config: apiError(0, 'unreachable') }));
    await flush();
    expect(badge.hidden).toBe(true);
  });

  it('pairs the current engine: health, then saves the key, clears the field and turns the badge green', async () => {
    const api = fakeApi();
    const badge = mount(api);
    await flush();
    qs.elements.key.value = '  sk-miserly-1234abcd  ';
    await qs.pair();
    expect(api.calls).toContainEqual(['save', { miserly_client_key: 'sk-miserly-1234abcd' }]);
    expect(qs.elements.key.value).toBe('');
    expect(Object.values(qs.elements.steps).map((s) => s.li.dataset.state)).toEqual(['ok', 'ok', 'ok']);
    expect(badge.textContent).toBe('Elarion Ready');
  });

  it('reports a rejected key on the key step', async () => {
    const api = fakeApi({ save: apiError(422, 'Miserly.io rejected the key (HTTP 401).') });
    mount(api);
    qs.elements.key.value = 'sk-wrong-key-000';
    await qs.pair();
    expect(qs.elements.steps.key.li.dataset.state).toBe('fail');
    expect(qs.elements.message.textContent).toContain('rejected');
  });

  it('stops at the first step when the engine is down', async () => {
    const api = fakeApi({ health: apiError(0, 'Aether Engine at x is unreachable.') });
    mount(api);
    await qs.pair();
    expect(qs.elements.steps.reach.li.dataset.state).toBe('fail');
    expect(api.calls.some((c) => c[0] === 'save')).toBe(false);
  });

  it('pairs a new address: saves it with a stable public URL, then reloads', async () => {
    const other = fakeApi({ baseUrl: 'https://engine.example.com' });
    let reloaded = false;
    mount(fakeApi(), { engineFor: () => other, reload: () => (reloaded = true) });
    qs.elements.address.value = 'https://engine.example.com';
    qs.elements.key.value = 'sk-miserly-1234abcd';
    await qs.pair();
    expect(other.calls).toContainEqual(['save', { miserly_client_key: 'sk-miserly-1234abcd', public_url: 'https://engine.example.com' }]);
    expect(localStorage.getItem('aether.engine.baseUrl')).toBe('https://engine.example.com');
    await new Promise((r) => setTimeout(r, 1000));
    expect(reloaded).toBe(true);
    localStorage.removeItem('aether.engine.baseUrl');
  });

  it('never saves a quick tunnel or localhost as the public URL', () => {
    expect(publicUrlFor('https://abc-def.trycloudflare.com')).toBeNull();
    expect(publicUrlFor('http://localhost:3333')).toBeNull();
    expect(publicUrlFor('https://engine.example.com/x')).toBe('https://engine.example.com');
  });
});

describe('free sandbox mode', () => {
  const SANDBOX = { miserly_key_configured: true, miserly_key_hint: '…dbox', miserly_key_status: 'sandbox', miserly_key_detail: 'Free Sandbox Mode Active', public_url: null, execution_mode: 'miserly-free', elarion_ready: true };

  it('labels the badge Elarion Ready · Sandbox', async () => {
    expect(badgeState(SANDBOX)).toMatchObject({ hidden: false, kind: 'running', text: 'Elarion Ready · Sandbox' });
    const badge = mount(fakeApi({ config: SANDBOX }));
    await flush();
    expect(badge.textContent).toBe('Elarion Ready · Sandbox');
    expect(qs.elements.keyHint.textContent).toContain('Free Sandbox Mode Active');
  });

  it('pairs with the sandbox key and reports Free Sandbox Mode Active on the key step', async () => {
    const api = fakeApi({ save: SANDBOX });
    const badge = mount(api);
    qs.elements.key.value = 'miserly_free_sandbox';
    await qs.pair();
    expect(api.calls).toContainEqual(['save', { miserly_client_key: 'miserly_free_sandbox' }]);
    expect(qs.elements.steps.key.li.dataset.state).toBe('ok');
    expect(qs.elements.steps.key.detail.textContent).toContain('Free Sandbox Mode Active');
    expect(badge.textContent).toBe('Elarion Ready · Sandbox');
  });
});
