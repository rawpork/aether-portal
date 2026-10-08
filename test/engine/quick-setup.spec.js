// Quick Setup: Test & Pair Engine checks /health, sends the Miserly key to POST /api/engine/config, and drives the
// header's Elarion Ready badge.
import { afterEach, describe, expect, it } from 'vitest';
import { badgeState, keyProblem, mountQuickSetup, publicUrlFor } from '../../public/js/engine/quick-setup.js';

const READY = { miserly_key_configured: true, miserly_key_hint: '…abcd', miserly_key_status: 'verified', miserly_key_detail: 'ok', public_url: null, elarion_ready: true };
// No Miserly key saved, and the engine calls the model provider directly with its own key: Miserly is optional.
const DIRECT = { miserly_key_configured: false, miserly_key_hint: null, miserly_key_status: 'missing', miserly_key_detail: 'No key', public_url: null, elarion_ready: true, execution_mode: 'direct-anthropic' };
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

describe('key problems', () => {
  it('treats a missing Miserly key as fine when the engine can answer without it, and as a problem when it cannot', () => {
    expect(keyProblem(READY)).toBe(null);
    // Neither a Miserly key nor a provider key: nothing can answer.
    expect(keyProblem(MISSING)).toMatchObject({ kind: 'missing', detail: 'The engine has no AI model key.' });
    expect(badgeState(MISSING)).toMatchObject({ hidden: false, kind: 'alert', text: 'Set up Elarion', title: 'No AI model key on the engine' });
    // Miserly is optional: the engine's own provider key is enough.
    expect(keyProblem(DIRECT)).toBe(null);
    expect(keyProblem({ ...MISSING, elarion_ready: true })).toBe(null);
    expect(badgeState(DIRECT)).toMatchObject({ hidden: false, kind: 'running', text: 'Elarion Ready' });
    expect(badgeState(DIRECT).title).toContain('Claude (Anthropic)');
    expect(badgeState(DIRECT).title).toContain('optional');
    expect(badgeState({ ...DIRECT, execution_mode: 'direct-gemini' }).title).toContain('Gemini (Google)');
    // A saved key takes priority over the provider key, so a bad one is still a problem.
    expect(keyProblem({ ...READY, miserly_key_status: 'invalid', miserly_key_detail: 'Rejected (401)' })).toEqual({ kind: 'invalid', detail: 'Rejected (401)' });
    expect(keyProblem({ ...READY, miserly_key_status: 'unreachable' })).toMatchObject({ kind: 'unverified' });
    expect(keyProblem({ miserly_key_status: 'sandbox', execution_mode: 'miserly-free', elarion_ready: true })).toBe(null);
    expect(keyProblem(null)).toBe(null);
  });
});

describe('Miserly is optional', () => {
  const stepStates = () => Object.values(qs.elements.steps).map((s) => s.li.dataset.state);

  it('says so in the form: the field is labelled optional and the hint names the provider in use', async () => {
    mount(fakeApi({ config: DIRECT }));
    await flush();
    expect(document.querySelector('label[for="qs-key"]').textContent).toBe('Miserly Client Key (optional)');
    expect(qs.elements.key.placeholder).toMatch(/optional/i);
    expect(qs.elements.keyHint.textContent).toContain('Not needed');
    expect(qs.elements.keyHint.textContent).toContain('Claude (Anthropic)');
    expect(qs.elements.keyHint.dataset.kind).toBe('ok');
    expect(qs.elements.removeKey.hidden).toBe(true);
    // Not a failure: every check is green with no Miserly key.
    expect(stepStates()).toEqual(['ok', 'ok', 'ok']);
    expect(qs.elements.steps.key.li.textContent).toContain('AI model ready');
    expect(qs.elements.steps.key.detail.textContent).toContain('Miserly is optional');
  });

  it('pairs with no key typed and reports ready, using the provider key', async () => {
    const api = fakeApi({ config: DIRECT });
    mount(api);
    await flush();
    await qs.pair();
    expect(api.calls.some((c) => c[0] === 'save')).toBe(false);
    expect(qs.elements.message.dataset.kind).toBe('ok');
    expect(qs.elements.message.textContent).toBe('Paired. Elarion is ready, using your Claude (Anthropic) key.');
  });

  it('is only a failure when the engine has no model key of any kind', async () => {
    mount(fakeApi({ config: MISSING }));
    await flush();
    expect(stepStates()).toEqual(['ok', 'ok', 'fail']);
    expect(qs.elements.keyHint.textContent).toContain('no AI model key');
    expect(qs.elements.keyHint.dataset.kind).toBe('error');
  });

  it('offers to remove a saved Miserly key, which hands the engine back to its own provider key', async () => {
    const api = fakeApi({ config: READY, save: DIRECT });
    const badge = mount(api);
    await flush();
    expect(qs.elements.removeKey.hidden).toBe(false);
    expect(qs.elements.removeKey.textContent).toBe('Remove Miserly key');
    qs.elements.removeKey.click();
    await flush();
    expect(api.calls).toContainEqual(['save', { clear_miserly_key: true }]);
    expect(qs.elements.removeKey.hidden).toBe(true);
    expect(qs.elements.message.textContent).toBe('Removed. Elarion now uses your Claude (Anthropic) key directly.');
    expect(badge.title).toContain('optional');
  });

  it('calls the sandbox "Leave sandbox", and reports when removing leaves no model key at all', async () => {
    const SANDBOX = { ...READY, miserly_key_status: 'sandbox', execution_mode: 'miserly-free' };
    mount(fakeApi({ config: SANDBOX, save: MISSING }));
    await flush();
    expect(qs.elements.removeKey.textContent).toBe('Leave sandbox');
    qs.elements.removeKey.click();
    await flush();
    expect(qs.elements.message.dataset.kind).toBe('error');
    expect(qs.elements.message.textContent).toContain('no AI model key');
  });

  it('suggests removing a Miserly key that is not accepted, since the provider key would work', async () => {
    mount(fakeApi({ config: { ...READY, miserly_key_status: 'invalid', miserly_key_detail: 'Miserly.io rejected the key (HTTP 401).', elarion_ready: false } }));
    await flush();
    expect(qs.elements.keyHint.textContent).toContain('remove it to use the engine’s own provider key');
    expect(qs.elements.keyHint.dataset.kind).toBe('error');
    expect(qs.elements.removeKey.hidden).toBe(false);
  });
});

describe('key state reaches the rest of the page', () => {
  const steps = () => [...document.querySelectorAll('.qs-step')].map((li) => li.dataset.state);

  it('reports the engine summary to the page, and null when the engine cannot answer', async () => {
    const seen = [];
    mount(fakeApi({ config: MISSING }), { onSummary: (s) => seen.push(s) });
    await flush();
    expect(seen).toEqual([MISSING]);
    seen.length = 0;
    qs.destroy();
    mount(fakeApi({ config: apiError(0, 'unreachable') }), { onSummary: (s) => seen.push(s) });
    await flush();
    expect(seen).toEqual([null]);
  });

  it('fills the checklist from what the engine already says, instead of three empty circles', async () => {
    mount(fakeApi({ config: MISSING }));
    expect(steps()).toEqual(['idle', 'idle', 'idle']);
    await flush();
    expect(steps()).toEqual(['ok', 'ok', 'fail']);
    qs.destroy();
    mount(fakeApi({ config: READY }));
    await flush();
    expect(steps()).toEqual(['ok', 'ok', 'ok']);
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
