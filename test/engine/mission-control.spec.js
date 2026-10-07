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
    mc.theme.destroy();
    mc.quickSetup.destroy();
    if (mc.workflowConsole) mc.workflowConsole.destroy();
    if (mc.studio) mc.studio.destroy();
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
    if (pathname === '/api/blueprint/compile') return reply({ success: true, blueprint_id: 'bp_tpl', blueprint: { blueprint_id: 'bp_tpl', project_name: 'Landing page + waitlist', status: 'APPROVED_FOR_EXECUTION', execution_phases: [], sources: [] }, logged: true });
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
  // Phones shrink only the header's New agent to an icon, never the Command Bar's Generate button.
  expect(html).toContain('.mc-actions .btn-primary { width: 44px;');
  // Phone header budget (measured in a 375px browser: 69px calm, 90px with the greeting, 117px with an attention strip):
  // one row of direct flex items, the eyebrow dropped, the greeting on its own line, attention states as a full-width strip.
  expect(html).toContain('.mc-heading, .mc-actions { display: contents; }');
  expect(html).toMatch(/\.mc-crumbs \{ display: none; \}/);
  expect(html).toMatch(/\.mc-greeting \{ order: 10; flex: 0 0 100%;/);
  expect(html).toContain('.mc-status:has(.status-pill[data-kind="alert"]), .mc-status:has(.status-pill[data-kind="halted"]) { order: 8; flex: 1 0 100%; }');
  expect(html).not.toMatch(/\n\s*\.btn-primary \{ width: 42px;/);
  expect(html).toMatch(/\.wfc-prompt \{[^}]*width: 100%;[^}]*min-width: 0;/);
  expect(html).toMatch(/\.wfc-prompt \{ flex: none; font-size: 16px;/);
  // The header opens with the ☰ menu tray, then the link to Space at every width (same slot as Space's link back here,
  // WCAG 3.2.3). The rail has no separate Portal item: its star logo is the way back on desktop, and says so.
  expect(html).toMatch(/<header class="mc-top">\s*<button type="button" class="menu-toggle" id="mc-menu-toggle" aria-controls="mc-rail"[^>]*>[\s\S]*?<\/button>\s*<a class="surface-link" href="\/" aria-label="Space" aria-keyshortcuts="Alt\+S"/);
  expect(html).not.toContain('rail-portal');
  expect(html).not.toContain('mobile-return-btn');
  expect(html).toMatch(/<a class="rail-brand" href="\/" title="Space: the 3D graph \(Alt\+S\)" aria-label="Aether Space \(Alt\+S\)" aria-keyshortcuts="Alt\+S">/);
  expect(html).toContain('data-shell-surface="mission-control"');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.head.innerHTML = (html.match(/<meta name="aether-[^>]*>/g) || []).join('') + '<title>Mission Control - Aether Portal</title>';

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
  expect(header.querySelector('.mc-crumbs').textContent).toBe('Operations');
  expect(header.querySelector('h1').textContent).toBe('Mission Control');
  expect(document.title).toBe('Mission Control - Aether Portal');
  expect(document.getElementById('mc-greeting').textContent).toMatch(/^Good (morning|afternoon|evening), Alex$/);
  expect(document.getElementById('mc-clock')).toBe(null);
  expect(document.querySelector('#mc-status .status-pill [data-status="text"]').textContent).toBe('All idle');
  expect(header.querySelector('#mc-breaker .engine-badge').dataset.state).toBe('ACTIVE');
  expect(header.querySelector('.engine-trip')).not.toBe(null);
  expect(document.querySelector('.rail-avatar').textContent).toBe('A');

  // Overview: four metrics, Elarion's card with its own Pause button and breaker switch, and its detail panel.
  expect(document.querySelectorAll('#mc-workforce .metric')).toHaveLength(4);
  const card = document.querySelector('#mc-workforce .agent-card');
  expect(card.querySelector('.card-name').textContent).toBe('Elarion');
  expect(card.querySelector('.switch[role="switch"]').getAttribute('aria-checked')).toBe('true');
  // Elarion has run nothing, so there is nothing to pause: no Pause button, but the API breaker switch is still there.
  expect(card.querySelector('.btn-small')).toBe(null);
  expect(card.querySelector('.pill').textContent).toBe('Waiting');
  // The first screen answers the operator's questions before the totals: Right now, then the agents, then the overview.
  const order = [...document.querySelectorAll('#mc-workforce > *')].map((c) => (c.classList.contains('wf-now') ? 'now' : c.classList.contains('wf-split') ? 'agents' : c.classList.contains('wf-overview') ? 'overview' : ''));
  expect(order.filter(Boolean)).toEqual(['now', 'agents', 'overview']);
  expect(document.querySelector('.wf-now .wf-focus').textContent).toBe('Nothing has run yet.');
  expect(document.querySelector('.wf-detail h2').textContent).toBe('Elarion');
  expect([...document.querySelectorAll('.wf-detail .subtabs [role="tab"]')].map((t) => t.textContent)).toEqual(['Activity', 'Tasks0', 'Output', 'Skills', 'API Bridge']);
  expect(document.getElementById('mc-agent-count').textContent).toBe('1');

  // Heading outline across every mounted view: a single H1, and no level skipped on the way down.
  const outline = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 30) }));
  expect(outline.filter((h) => h.level === 1)).toHaveLength(1);
  outline.forEach((h, i) => {
    if (i > 0) expect(h.level, '"' + h.text + '" (h' + h.level + ') follows "' + outline[i - 1].text + '" (h' + outline[i - 1].level + ')').toBeLessThanOrEqual(outline[i - 1].level + 1);
  });

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
  expect(document.getElementById('mc-title').textContent).toBe('Projects');
  expect(document.title).toBe('Projects - Mission Control - Aether Portal');
  expect(document.getElementById('mc-route').textContent).toBe('Projects');

  // One input per page: the command bar is gone on Projects, and focus that was in it moves to the page title, not nowhere.
  const composerInput = document.getElementById('mc-command-input');
  mc.tabs.select('overview');
  composerInput.focus();
  expect(document.activeElement).toBe(composerInput);
  mc.tabs.select('studio');
  expect(document.body.dataset.view).toBe('studio');
  expect(document.activeElement).toBe(document.getElementById('mc-title'));
  // Sending from the command bar opens Elarion and keeps the cursor in Elarion's own box.
  mc.tabs.select('overview');
  composerInput.value = 'status?';
  document.getElementById('mc-command').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(document.getElementById('mc-view-elaron').hidden).toBe(false);
  expect(document.activeElement).toBe(mc.dock.elements.input);
  mc.tabs.select('blueprints');
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

it('Create / Templates: a template and its brief become a blueprint opened under Projects', async () => {
  await mountPage();
  document.getElementById('mc-nav-create').click();
  expect(document.getElementById('mc-view-create').hidden).toBe(false);
  expect(document.getElementById('mc-title').textContent).toBe('Create / Templates');
  expect(window.location.hash).toBe('#create');
  document.querySelector('#mc-templates [data-template="landing-waitlist"]').click();
  document.querySelector('.tp-brief input[name="domain"]').value = 'waitlist.example.com';
  document.querySelector('.tp-brief .tp-submit').click();
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
  expect(document.querySelector('.tp-brief')).toBeNull();
  expect(mc.tabs.getView()).toBe('blueprints');
  expect(document.querySelector('#mc-blueprints .bp-viewer h3').textContent).toBe('Landing page + waitlist');
  expect(document.getElementById('bp-feedback').textContent).toBe('Created bp_tpl from the Landing page + waitlist template and your brief. Press Deploy & Execute to start the run.');
  expect(document.activeElement).toBe(document.querySelector('#mc-blueprints .bp-deploy'));
  mc.templates.destroy();
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
    expect(requested.filter((u) => u !== '/api/graph')).toEqual(['/api/outcome/node_42/blueprint']);
    expect(mc.tabs.getView()).toBe('blueprints');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#blueprints');
    expect(JSON.parse(document.querySelector('.bp-editor').value).schema).toBe('aether.blueprint/1');
    expect(document.getElementById('bp-feedback').textContent).toMatch(/^Valid spec: From the portal · 1 source link\./);
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('Studio opens on the Workflow console and switches to Engine activity, each polling only while shown', async () => {
  const html = renderMissionControlPage({ assetVersion: 'test' });
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const calls = [];
  const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const engineFetch = async (url) => {
    const { pathname } = new URL(url);
    calls.push(pathname);
    if (pathname === '/api/agents/master-brain/state') return reply({ agent_id: 'master-brain', state: 'ACTIVE' });
    if (pathname === '/api/tasks') return reply({ tasks: [], counts: { running: 0, completed: 0, halted: 0, failed: 0 } });
    if (pathname === '/api/artifacts') return reply({ success: true, count: 0, artifacts: [] });
    if (pathname === '/api/workflows') return reply({ workflows: [] });
    if (pathname === '/api/canvas/graph') return reply({ generated_at: '', nodes: [], edges: [], counts: { tasks: 0, steps: 0, mcp_servers: 0, bridges: 0 }, mcp_error: null });
    return new Response('{}', { status: 404 });
  };
  const store = { getToken: () => null, setToken() {} };
  mc = await mountMissionControl(document, {
    api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch, getToken: store.getToken }),
    connection: { fetch: async () => new Response('{}', { status: 404 }), ...store },
    dock: { storage: { get: () => null, set() {} }, Recognition: null, synth: null },
    studio: { pollMs: 60_000 },
  });
  expect(calls).not.toContain('/api/workflows');
  document.getElementById('mc-nav-studio').click();
  await new Promise((r) => setTimeout(r, 10));
  const workflowTab = document.getElementById('mc-studio-tab-workflow');
  const activityTab = document.getElementById('mc-studio-tab-activity');
  expect(workflowTab.getAttribute('aria-selected')).toBe('true');
  expect(document.getElementById('mc-workflow').hidden).toBe(false);
  expect(document.getElementById('mc-studio-activity').hidden).toBe(true);
  expect(document.querySelector('#mc-workflow .wfc-command-label').textContent).toBe('Studio Command Bar');
  expect(calls).toContain('/api/workflows');
  expect(calls).not.toContain('/api/canvas/graph');
  workflowTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  expect(activityTab.getAttribute('aria-selected')).toBe('true');
  expect(workflowTab.getAttribute('tabindex')).toBe('-1');
  expect(document.getElementById('mc-studio-activity').hidden).toBe(false);
  expect(calls).toContain('/api/canvas/graph');
  expect(mc.workflowConsole.getState().workflow).toBe(null);
});

it('has one H1 and a heading outline that never skips a level, and keeps one input per page', async () => {
  const html = renderMissionControlPage({ assetVersion: 'v1', userName: 'Alex' });
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  expect(levels[0]).toBe(1);
  levels.forEach((level, i) => {
    if (i > 0) expect(level, 'heading #' + i + ' follows an h' + levels[i - 1]).toBeLessThanOrEqual(levels[i - 1] + 1);
  });
  // Hidden for the pages that own an input; the style rule lives in the page template.
  expect(html).toMatch(/body\[data-view="elaron"\] \.mc-command, body\[data-view="studio"\] \.mc-command, body\[data-view="blueprints"\] \.mc-command \{ display: none; \}/);
  expect(document.querySelector('label[for="mc-command-input"]').textContent).toBe('Ask Elarion');
  expect(document.getElementById('mc-command-input').getAttribute('placeholder')).toBe('Ask Elarion…');
  expect(document.getElementById('mc-command-input').getAttribute('aria-describedby')).toBe('mc-command-hint');
});

// The banner follows the engine's key state across the real page: asks for the key instead of a first project, stays off
// pages where it is not actionable, and steps aside on Settings itself.
async function mountWithConfig(config) {
  // Selecting a view writes it to the URL hash; start each of these from the overview.
  window.history.replaceState(null, '', '/');
  const html = renderMissionControlPage({ assetVersion: 'test' });
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const engineFetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/agents/master-brain/state') return reply({ agent_id: 'master-brain', state: 'ACTIVE' });
    if (pathname === '/api/tasks') return reply({ tasks: [], counts: { running: 0, completed: 0, halted: 0, failed: 0 } });
    if (pathname === '/api/artifacts') return reply({ success: true, count: 0, artifacts: [] });
    if (pathname === '/api/engine/config') return config ? reply(config) : reply({ error: 'not found' }, 404);
    return new Response('{}', { status: 404 });
  };
  const store = { getToken: () => null, setToken() {} };
  mc = await mountMissionControl(document, {
    api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch, getToken: store.getToken }),
    connection: { fetch: async () => new Response('{}', { status: 404 }), ...store },
    dock: { storage: { get: () => null, set() {} }, Recognition: null, synth: null },
  });
  await new Promise((r) => setTimeout(r, 40));
}
const bannerTitle = () => document.querySelector('#mc-next .wf-next-title')?.textContent;

it('with no Miserly key the banner asks for it, only where it helps, and never suggests a first project', async () => {
  await mountWithConfig({ miserly_key_configured: false, miserly_key_hint: null, miserly_key_status: 'missing', miserly_key_detail: 'No key', public_url: null, elarion_ready: false });
  const next = document.getElementById('mc-next');
  expect(next.hidden).toBe(false);
  expect(bannerTitle()).toBe('Add your Miserly key');
  expect(next.textContent).not.toContain('Start your first project');
  // Settings shows the form itself, so the banner steps aside there; other pages still get the blocker.
  mc.tabs.select('connect');
  expect(next.hidden).toBe(true);
  mc.tabs.select('blueprints');
  expect(next.hidden).toBe(false);
  expect(bannerTitle()).toBe('Add your Miserly key');
  mc.tabs.select('monitor');
  expect(next.hidden).toBe(false);
  // The Settings checklist already reflects it: reachable, authorized, key still to do.
  expect([...document.querySelectorAll('.qs-step')].map((li) => li.dataset.state)).toEqual(['ok', 'ok', 'fail']);
  // The status pill agrees something needs attention.
  expect(document.querySelector('[data-status="pill"]').textContent.trim()).toBe('Setup needed');
});

it('with a verified key the first-project suggestion shows on the overview only', async () => {
  await mountWithConfig({ miserly_key_configured: true, miserly_key_hint: '…abcd', miserly_key_status: 'verified', miserly_key_detail: 'ok', public_url: null, elarion_ready: true });
  const next = document.getElementById('mc-next');
  expect(bannerTitle()).toBe('Start your first project');
  expect(next.hidden).toBe(false);
  for (const view of ['studio', 'create', 'blueprints', 'roadmap', 'operator', 'monitor', 'connect']) {
    mc.tabs.select(view);
    expect(next.hidden, view).toBe(true);
  }
  mc.tabs.select('overview');
  expect(next.hidden).toBe(false);
});

it('an engine too old to report its key does not block the banner', async () => {
  await mountWithConfig(null);
  expect(bannerTitle()).toBe('Start your first project');
});
