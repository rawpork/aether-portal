// Mission Control end to end in happy-dom: the real page markup from the Worker template, the real modules, a
// simulated portal token endpoint and a simulated engine that records the Authorization header it receives.
import { afterEach, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { mountMissionControl } from '../../public/js/engine/mission-control.js';
import { renderMissionControlPage } from '../../src/mission-control-page.js';

const b64url = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const PORTAL_JWT = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: 'portal:user_1', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

let mc;
afterEach(() => {
  if (mc) {
    mc.breaker.destroy();
    mc.monitor.destroy();
    mc.dock.destroy();
    mc.blueprints.destroy();
    mc.connection.destroy();
  }
  document.body.replaceChildren();
});

it('mounts the breaker top-right, the task monitor and Elaron, authenticated by a portal-minted token', async () => {
  const html = renderMissionControlPage({ assetVersion: 'test', tier: 'pro' });
  expect(html).toContain('<script type="module" src="/js/engine/mission-control.js?v=test"></script>');
  expect(html).not.toMatch(/<script>/);
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.head.innerHTML = (html.match(/<meta name="aether-[^>]*>/g) || []).join('');

  let token = null;
  const engineCalls = [];
  const engineFetch = async (url, init) => {
    const { pathname } = new URL(url);
    engineCalls.push({ pathname, auth: init.headers.Authorization });
    const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/agents/master-brain/state') return reply({ agent_id: 'master-brain', state: 'ACTIVE' });
    if (pathname === '/api/tasks') return reply({ tasks: [], counts: { running: 0, completed: 0, halted: 0, failed: 0 } });
    if (pathname === '/api/artifacts') return reply({ success: true, count: 0, artifacts: [] });
    return new Response('{}', { status: 404 });
  };
  const portalFetch = async (url) => {
    expect(url).toBe('/api/engine/token');
    return new Response(JSON.stringify({ token: PORTAL_JWT, expires_at: 'x' }), { status: 200 });
  };
  const store = { getToken: () => token, setToken: (v) => (token = v) };
  const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch, getToken: store.getToken });

  mc = await mountMissionControl(document, { api, connection: { fetch: portalFetch, ...store }, dock: { storage: { get: () => null, set() {} }, Recognition: null, synth: null } });
  await new Promise((r) => setTimeout(r, 20));

  // Breaker lives in the header's top-right slot, after the tabs.
  const header = document.querySelector('header.mc-top');
  expect(header.lastElementChild.id).toBe('mc-breaker');
  expect(header.querySelector('.engine-badge').dataset.state).toBe('ACTIVE');
  expect(header.querySelector('.engine-trip')).not.toBe(null);
  expect(document.querySelector('a[aria-current="page"]').getAttribute('href')).toBe('/mission-control');

  // Monitor and Elaron are mounted in the workspace.
  expect(document.querySelectorAll('#mc-monitor .mc-stat')).toHaveLength(5);
  expect(document.getElementById('mc-monitor-status').textContent).toBe('Up to date');
  expect(document.querySelector('#mc-elaron .brain-dock h2').textContent).toBe('Elaron · Master Brain');

  // No key entry needed: every engine call carried the portal-minted token.
  expect(document.querySelector('#mc-connection summary').textContent).toBe('Engine connection · portal session token');
  expect(document.querySelector('#mc-connection form').hidden).toBe(true);
  expect(engineCalls.length).toBeGreaterThanOrEqual(3);
  expect(engineCalls.every((c) => c.auth === 'Bearer ' + PORTAL_JWT)).toBe(true);

  // Workspace tabs: the monitor shows first; Blueprints holds ingestion and the artifact dashboard.
  const monitorTab = document.getElementById('mc-tab-monitor');
  const blueprintsTab = document.getElementById('mc-tab-blueprints');
  expect(document.getElementById('mc-view-monitor').hidden).toBe(false);
  expect(document.getElementById('mc-view-blueprints').hidden).toBe(true);
  blueprintsTab.click();
  expect(blueprintsTab.getAttribute('aria-selected')).toBe('true');
  expect(document.getElementById('mc-view-blueprints').hidden).toBe(false);
  expect(document.getElementById('mc-view-monitor').hidden).toBe(true);
  expect(window.location.hash).toBe('#blueprints');
  expect(document.querySelector('#mc-blueprints .bp-ingest')).not.toBe(null);
  expect(document.querySelector('#mc-blueprints .bp-tier').textContent).toBe('Pro Engine');
  blueprintsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(monitorTab.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(monitorTab);
  expect(window.location.hash).toBe('');
});
