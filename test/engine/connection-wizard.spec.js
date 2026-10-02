// Connection setup wizard: Local vs Cloud, tunnel detection, QR pairing, cloud URL saving, and pairing links.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { MODE_STORAGE_KEY, guessMode, mountConnectionWizard, pairingLink } from '../../public/js/engine/connection-wizard.js';

const PORTAL = 'https://lingering-water-de49.klo377.workers.dev';
const TUNNEL = 'https://optimum-ind-tablet-jeremy.trycloudflare.com';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

function engine({ publicUrl = TUNNEL, source = 'cloudflared', status = 200, offline = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url).pathname);
    if (offline) throw new TypeError('Failed to fetch');
    if (status === 401) return new Response(JSON.stringify({ error: 'Invalid token signature.' }), { status: 401 });
    return new Response(JSON.stringify({ public_url: publicUrl, source: publicUrl ? source : null }), { status: 200 });
  };
  return { calls, fetchImpl };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

let container, wizard, storage, reloads, copied, health;

async function mount({ baseUrl = 'http://localhost:3333', eng = engine(), ...extra } = {}) {
  container = document.createElement('div');
  document.body.append(container);
  const api = createEngineApi({ baseUrl, fetch: eng.fetchImpl, getToken: () => 'portal.jwt.sig' });
  wizard = mountConnectionWizard(container, {
    api,
    storage,
    reload: () => reloads++,
    pageProtocol: 'https:',
    portalOrigin: PORTAL,
    copyText: async (t) => copied.push(t),
    healthCheck: async (url) => {
      health.push(url);
      if (url.includes('down')) throw new Error('Aether Engine at ' + url + ' is unreachable.');
      return { status: 'healthy', system: 'Aether Engine Compiler' };
    },
    ...extra,
  });
  await flush();
  return wizard;
}

beforeEach(() => {
  storage = memoryStorage();
  reloads = 0;
  copied = [];
  health = [];
});

afterEach(() => {
  wizard && wizard.destroy();
  container && container.remove();
  wizard = container = null;
});

describe('helpers', () => {
  it('guesses the mode from the current engine address', () => {
    expect(guessMode('http://localhost:3333')).toBe('local');
    expect(guessMode(TUNNEL)).toBe('local');
    expect(guessMode('https://engine.example.com')).toBe('cloud');
  });

  it('builds a pairing link that opens Connection with the engine address', () => {
    expect(pairingLink(PORTAL + '/', TUNNEL)).toBe(PORTAL + '/mission-control?engine=https%3A%2F%2Foptimum-ind-tablet-jeremy.trycloudflare.com#connect');
  });
});

describe('Local vs Cloud', () => {
  it('offers the two options and remembers the choice', async () => {
    await mount({ autoDetect: false });
    const cards = [...container.querySelectorAll('.cw-mode')];
    expect(cards.map((c) => c.querySelector('.cw-mode-title').textContent + ' · ' + c.querySelector('.cw-mode-sub').textContent)).toEqual([
      'Local Engine · Private & Local Compute',
      'Dedicated Cloud Engine · Always-On SaaS',
    ]);
    expect(wizard.getMode()).toBe('local');
    expect(wizard.elements.cloudPanel.hidden).toBe(true);
    cards[1].querySelector('input').click();
    expect(wizard.getMode()).toBe('cloud');
    expect(wizard.elements.localPanel.hidden).toBe(true);
    expect(wizard.elements.cloudPanel.hidden).toBe(false);
    expect(storage.getItem(MODE_STORAGE_KEY)).toBe('cloud');
  });

  it('shows the local commands with copy buttons', async () => {
    await mount({ autoDetect: false });
    const code = [...wizard.elements.localPanel.querySelectorAll('.cw-code code')].map((c) => c.textContent);
    expect(code).toEqual(['cd Aether_Engine\nnpm run dev', 'cloudflared tunnel --url http://localhost:3333']);
    wizard.elements.localPanel.querySelector('.cw-copy').click();
    await flush();
    expect(copied).toEqual(['cd Aether_Engine\nnpm run dev']);
  });

  it('shows the cloud deployment steps (secret, PM2, Docker, HTTPS)', async () => {
    storage.setItem(MODE_STORAGE_KEY, 'cloud');
    await mount({ autoDetect: false });
    const text = wizard.elements.cloudPanel.textContent;
    for (const part of ['SUPABASE_JWT_SECRET', 'npx wrangler secret put ENGINE_JWT_SECRET', 'pm2 start', 'docker run', 'reverse_proxy 127.0.0.1:3333', 'ENGINE_PUBLIC_URL=https://engine.yourdomain.com']) {
      expect(text, part).toContain(part);
    }
  });
});

describe('local pairing', () => {
  it('detects the tunnel through the engine and shows a scannable pairing code', async () => {
    const eng = engine();
    await mount({ eng });
    expect(eng.calls).toContain('/api/public-url');
    expect(wizard.elements.detectMsg.textContent).toBe('Found the tunnel: optimum-ind-tablet-jeremy.trycloudflare.com.');
    expect(wizard.elements.tunnelInput.value).toBe(TUNNEL);
    expect(wizard.elements.pairBox.hidden).toBe(false);
    const link = PORTAL + '/mission-control?engine=https%3A%2F%2Foptimum-ind-tablet-jeremy.trycloudflare.com#connect';
    expect(wizard.elements.pairLinkText.textContent).toBe(link);
    const svg = wizard.elements.qrBox.querySelector('svg');
    expect(svg.getAttribute('aria-label')).toBe('Pairing code for optimum-ind-tablet-jeremy.trycloudflare.com');
    expect(svg.querySelector('path').getAttribute('d').length).toBeGreaterThan(1000);
    wizard.elements.copyPair.click();
    await flush();
    expect(copied).toEqual([link]);
  });

  it('accepts a pasted bare tunnel host and can switch this device to it', async () => {
    await mount({ eng: engine({ publicUrl: null }) });
    expect(wizard.elements.detectMsg.textContent).toMatch(/^No tunnel found/);
    wizard.elements.tunnelInput.value = '  optimum-ind-tablet-jeremy.trycloudflare.com/ ';
    wizard.elements.tunnelInput.dispatchEvent(new Event('change'));
    expect(wizard.elements.tunnelInput.value).toBe(TUNNEL);
    expect(wizard.elements.pairBox.hidden).toBe(false);
    wizard.elements.useTunnel.click();
    expect(storage.getItem('aether.engine.baseUrl')).toBe(TUNNEL);
    expect(reloads).toBe(1);
  });

  it('explains why detection failed', async () => {
    await mount({ eng: engine({ offline: true }) });
    expect(wizard.elements.detectMsg.textContent).toMatch(/^Can’t reach the engine at http:\/\/localhost:3333\. Detecting works on the computer running the engine/);
    wizard.destroy();
    container.remove();
    await mount({ eng: engine({ status: 401 }) });
    expect(wizard.elements.detectMsg.textContent).toMatch(/^The engine rejected the token \(Invalid token signature\)/);
  });

  it('only auto-detects on the computer running the engine', async () => {
    const eng = engine();
    await mount({ baseUrl: TUNNEL, eng });
    expect(eng.calls).not.toContain('/api/public-url');
    expect(wizard.elements.useLocalhost.hidden).toBe(false);
    wizard.elements.useLocalhost.click();
    expect(storage.getItem('aether.engine.baseUrl')).toBe(null);
    expect(reloads).toBe(1);
  });
});

describe('cloud engine', () => {
  it('sanitizes, tests and saves the cloud URL', async () => {
    storage.setItem(MODE_STORAGE_KEY, 'cloud');
    await mount({ autoDetect: false });
    const { cloudInput, cloudTest, cloudForm, cloudMsg } = wizard.elements;
    cloudInput.value = '  engine.example.com/ ';
    cloudTest.click();
    await flush();
    expect(health).toEqual(['https://engine.example.com']);
    expect(cloudMsg.textContent).toBe('Reachable: engine.example.com (Aether Engine Compiler).');
    cloudForm.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(cloudInput.value).toBe('https://engine.example.com');
    expect(storage.getItem('aether.engine.baseUrl')).toBe('https://engine.example.com');
    expect(cloudMsg.textContent).toBe('Saved. Connecting to engine.example.com…');
    expect(reloads).toBe(1);
  });

  it('reports an unreachable server and refuses plain http elsewhere', async () => {
    storage.setItem(MODE_STORAGE_KEY, 'cloud');
    await mount({ autoDetect: false });
    const { cloudInput, cloudTest, cloudForm, cloudMsg } = wizard.elements;
    cloudInput.value = 'down.example.com';
    cloudTest.click();
    await flush();
    expect(cloudMsg.dataset.kind).toBe('error');
    expect(cloudMsg.textContent).toMatch(/^Can’t reach down\.example\.com/);
    cloudInput.value = 'http://203.0.113.7:3333';
    cloudForm.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(cloudMsg.textContent).toMatch(/browsers block a plain-http engine/);
    expect(reloads).toBe(0);
  });

  it('pre-fills the current cloud engine', async () => {
    await mount({ baseUrl: 'https://engine.example.com', autoDetect: false });
    expect(wizard.getMode()).toBe('cloud');
    expect(wizard.elements.cloudInput.value).toBe('https://engine.example.com');
  });
});

describe('pairing links', () => {
  it('asks before switching, then pairs', async () => {
    await mount({ baseUrl: 'https://engine.example.com', autoDetect: false });
    wizard.offerPairing(TUNNEL);
    const { offer, offerAccept } = wizard.elements;
    expect(offer.hidden).toBe(false);
    expect(offer.textContent).toContain('Connect this device to the engine at optimum-ind-tablet-jeremy.trycloudflare.com?');
    expect(offer.textContent).toContain('Only pair with an engine you run.');
    expect(storage.getItem('aether.engine.baseUrl')).toBe(null);
    expect(reloads).toBe(0);
    offerAccept.click();
    expect(storage.getItem('aether.engine.baseUrl')).toBe(TUNNEL);
    expect(reloads).toBe(1);
  });

  it('can be declined, and handles bad or already-paired addresses', async () => {
    await mount({ baseUrl: TUNNEL, autoDetect: false });
    wizard.offerPairing('https://other.trycloudflare.com');
    wizard.elements.offerDecline.click();
    expect(wizard.elements.offer.hidden).toBe(true);
    expect(storage.getItem('aether.engine.baseUrl')).toBe(null);
    wizard.offerPairing(TUNNEL);
    expect(wizard.elements.offer.textContent).toContain('already paired with optimum-ind-tablet-jeremy.trycloudflare.com');
    expect(wizard.elements.offerAccept.hidden).toBe(true);
    wizard.offerPairing('javascript:alert(1)');
    expect(wizard.elements.offer.textContent).toContain('unusable engine address');
    expect(wizard.elements.offerAccept.hidden).toBe(true);
  });
});
