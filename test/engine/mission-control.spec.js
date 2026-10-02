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
    mc.wizard.destroy();
    mc.workforce.destroy();
    mc.stopHeader();
    mc.tabs.destroy();
    mc = null;
  }
  document.body.replaceChildren();
});

// Real template markup plus an always-ACTIVE engine; for the narrower tests below.
async function mountPage(options = {}) {
  const html = renderMissionControlPage({ assetVersion: 'test' });
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.head.innerHTML = (html.match(/<meta name="aether-[^>]*>/g) || []).join('');
  const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const engineFetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/agents/master-brain/state') return reply({ agent_id: 'master-brain', state: 'ACTIVE' });
    if (pathname === '/api/tasks') return reply({ tasks: [], counts: { running: 0, completed: 0, halted: 0, failed: 0 } });
    if (pathname === '/api/artifacts') return reply({ success: true, count: 0, artifacts: [] });
    return new Response('{}', { status: 404 });
  };
  const store = { getToken: () => null, setToken() {} };
  const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch, getToken: store.getToken });
  mc = await mountMissionControl(document, {
    api,
    connection: { fetch: async () => new Response('{}', { status: 404 }), ...store },
    dock: { storage: { get: () => null, set() {} }, Recognition: null, synth: null },
    portalFetch: options.portalFetch,
  });
  return mc;
}

it('mounts the rail, the master breaker, the workforce overview and the other views, authenticated by a portal-minted token', async () => {
  const html = renderMissionControlPage({ assetVersion: 'test', tier: 'pro', userName: 'alex' });
  expect(html).toContain('<script type="module" src="/js/engine/mission-control.js?v=test"></script>');
  expect(html).not.toMatch(/<script>/);
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
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
  await new Promise((r) => setTimeout(r, 30));

  // Header: breadcrumbs, greeting with the user's name, master breaker and New agent.
  const header = document.querySelector('header.mc-top');
  expect(header.querySelector('.mc-crumbs').textContent).toBe('Operations / Mission Control');
  expect(document.getElementById('mc-greeting').textContent).toMatch(/^Good (morning|afternoon|evening), Alex$/);
  expect(document.getElementById('mc-clock').textContent).toMatch(/^\d\d:\d\d:\d\d$/);
  expect(header.querySelector('#mc-breaker .engine-badge').dataset.state).toBe('ACTIVE');
  expect(header.querySelector('.engine-trip')).not.toBe(null);
  expect(document.querySelector('.rail-avatar').textContent).toBe('A');

  // Overview: four metrics, Elarion's card with its own Pause button and breaker switch, and its detail panel.
  expect(document.querySelectorAll('#mc-workforce .metric')).toHaveLength(4);
  const card = document.querySelector('#mc-workforce .agent-card');
  expect(card.querySelector('.card-name').textContent).toBe('Elarion');
  expect(card.querySelector('.switch[role="switch"]').getAttribute('aria-checked')).toBe('true');
  expect(card.querySelector('.btn-small').textContent).toContain('Pause');
  expect(document.querySelector('.wf-detail h2').textContent).toBe('Elarion');
  expect([...document.querySelectorAll('.subtabs [role="tab"]')].map((t) => t.textContent)).toEqual(['Activity', 'Tasks0', 'Output', 'Skills', 'API Bridge']);
  expect(document.getElementById('mc-agent-count').textContent).toBe('1');

  // The other modules are mounted in their views.
  expect(document.querySelectorAll('#mc-monitor .mc-stat')).toHaveLength(5);
  expect(document.getElementById('mc-monitor-status').textContent).toBe('Up to date');
  expect(document.querySelector('#mc-elaron .brain-dock h2').textContent).toBe('Elarion · Master Brain');

  // No key entry needed: every engine call carried the portal-minted token.
  expect(document.querySelector('#mc-connection summary').textContent).toBe('Engine connection · localhost:3333 · portal session token');
  expect(document.querySelector('#mc-connection .mc-connection-manual').hidden).toBe(true);
  expect(engineCalls.length).toBeGreaterThanOrEqual(3);
  expect(engineCalls.every((c) => c.auth === 'Bearer ' + PORTAL_JWT)).toBe(true);

  // Rail: the overview shows first; Projects holds ingestion and the artifact dashboard.
  const overviewNav = document.getElementById('mc-nav-overview');
  const projectsNav = document.getElementById('mc-nav-blueprints');
  expect(overviewNav.getAttribute('aria-current')).toBe('page');
  expect(document.getElementById('mc-view-overview').hidden).toBe(false);
  expect(document.getElementById('mc-view-blueprints').hidden).toBe(true);
  projectsNav.click();
  expect(projectsNav.getAttribute('aria-current')).toBe('page');
  expect(overviewNav.hasAttribute('aria-current')).toBe(false);
  expect(document.getElementById('mc-view-blueprints').hidden).toBe(false);
  expect(document.getElementById('mc-view-overview').hidden).toBe(true);
  expect(document.getElementById('mc-crumb-view').textContent).toBe('Projects');
  expect(window.location.hash).toBe('#blueprints');
  expect(document.querySelector('#mc-blueprints .bp-ingest')).not.toBe(null);
  expect(document.querySelector('#mc-blueprints .bp-tier').textContent).toBe('Pro Engine');

  // Elarion has its own view; New agent opens Projects.
  document.getElementById('mc-nav-elaron').click();
  expect(document.getElementById('mc-view-elaron').hidden).toBe(false);
  expect(window.location.hash).toBe('#elaron');
  document.getElementById('mc-new-agent').click();
  expect(mc.tabs.getView()).toBe('blueprints');
  overviewNav.click();
  expect(window.location.hash).toBe('');
});

it('a pairing link (?engine=<url>) opens Connection and asks before switching engines', async () => {
  window.history.replaceState(null, '', '/mission-control?engine=' + encodeURIComponent('https://optimum-ind-tablet-jeremy.trycloudflare.com'));
  try {
    await mountPage();
    expect(mc.tabs.getView()).toBe('connect');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#connect');
    const offer = document.querySelector('.cw-offer');
    expect(offer.hidden).toBe(false);
    expect(offer.textContent).toContain('optimum-ind-tablet-jeremy.trycloudflare.com');
    expect(localStorage.getItem('aether.engine.baseUrl')).toBe(null);
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('loads an outcome blueprint from the portal into the Blueprints editor (?outcome=<id>)', async () => {
  window.history.replaceState(null, '', '/mission-control?outcome=node_42');
  const outcome = { schema: 'aether.blueprint/1', title: 'From the portal', steps: [{ n: 1, title: 'Read', sources: [{ id: 'a', title: 'A', url: 'https://a.test' }] }] };
  const requested = [];
  try {
    await mountPage({ portalFetch: async (url) => (requested.push(url), new Response(JSON.stringify(outcome), { status: 200 })) });
    expect(requested).toEqual(['/api/outcome/node_42/blueprint']);
    expect(mc.tabs.getView()).toBe('blueprints');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#blueprints');
    expect(JSON.parse(document.querySelector('.bp-editor').value).schema).toBe('aether.blueprint/1');
    expect(document.getElementById('bp-feedback').textContent).toMatch(/^Valid spec: From the portal · 1 source link\./);
  } finally {
    window.history.replaceState(null, '', '/');
  }
});
