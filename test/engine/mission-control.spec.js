// Mission Control end to end in happy-dom: the real page markup from the Worker template, the real modules, a
// simulated portal token endpoint and a simulated engine that records the Authorization header it receives.
import { afterEach, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { mountMissionControl, takeShareParams, takeSpaceHandoff } from '../../public/js/engine/mission-control.js';
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
    mc.newProject.destroy();
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
  // The header's New agent button is gone, so the rules that shrank it to an icon are too.
  expect(html).not.toContain('.mc-actions .btn-primary');
  // Phone header budget (measured in a 375px browser: 69px calm, 90px with the greeting, 117px with an attention strip):
  // one row of direct flex items, the eyebrow dropped, the greeting on its own line, attention states as a full-width strip.
  expect(html).toContain('.mc-heading, .mc-actions { display: contents; }');
  expect(html).not.toContain('mc-crumbs');
  // No greeting: the header is one line, the title and the status pill.
  expect(html).not.toContain('mc-greeting');
  expect(html).toContain('.mc-status:has(.status-pill[data-kind="alert"]), .mc-status:has(.status-pill[data-kind="halted"]) { order: 8; flex: 1 0 100%; }');
  expect(html).not.toMatch(/\n\s*\.btn-primary \{ width: 42px;/);
  expect(html).toMatch(/\.wfc-prompt \{[^}]*width: 100%;[^}]*min-width: 0;/);
  expect(html).toMatch(/\.wfc-prompt \{ flex: none; font-size: 16px;/);
  // The header is lean: the page title is the menu button (the ☰ square, the Space switch and New agent are gone from it).
  // Space is one tap away through the rail's brand (Alt+S), and Agent spec lives in the rail.
  expect(html).toMatch(/<header class="mc-top">\s*<div class="mc-heading">[\s\S]*?<h1 class="mc-title" id="mc-title"><button type="button" class="mc-menu-button" id="mc-menu-toggle" aria-controls="mc-rail" aria-expanded="false" aria-describedby="mc-menu-hint" title="Menu"><span class="mc-menu-text" id="mc-title-text">Mission Control<\/span>/);
  const topBar = /<header class="mc-top">[\s\S]*?<\/header>/.exec(html)[0];
  expect(topBar).not.toContain('shell-switch');
  expect(topBar).not.toContain('mc-new-agent');
  expect(topBar).not.toContain('class="btn-primary"');
  // What is left up there: the title (the menu button) and the status pill (whose panel holds its own controls).
  expect(topBar).toContain('id="mc-menu-toggle"');
  expect(topBar).toContain('data-status="pill"');
  expect(html).toMatch(/<a class="rail-brand" href="\/" data-surface="space"[^>]*aria-keyshortcuts="Alt\+S"/);
  expect(html).toMatch(/id="mc-agent-spec" aria-haspopup="dialog" title="Agent spec: define an agent's role and what it may do/);
  expect(html).toContain('@view-transition { navigation: auto; }');
  // Create: template cards share the whole row (auto-fit), so a row of two or three is balanced edge to edge, and one card can
  // shrink to a 320px screen (min()); their tag lines are pinned to the bottom so every card's chips line up.
  expect(html).toContain('.tp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));');
  expect(html).toContain('.tp-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }');
  // 400% zoom (320px): a run's name wraps instead of being cut, and its time drops under it.
  expect(html).toMatch(/@media \(max-width: 480px\) \{\s*\.mc-task-head \{ grid-template-columns: auto minmax\(0, 1fr\); \}\s*\.mc-task-name \{ overflow: visible; white-space: normal;/);
  expect(html).not.toContain('rail-portal');
  expect(html).not.toContain('mobile-return-btn');
  expect(html).toMatch(/<a class="rail-brand" href="\/" data-surface="space" title="Space: the 3D graph \(Alt\+S\)" aria-label="Aether Space \(Alt\+S\)" aria-keyshortcuts="Alt\+S">/);
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

  // Header: one line, the page title and the status pill; no greeting, no crumbs.
  const header = document.querySelector('header.mc-top');
  expect(document.getElementById('mc-greeting')).toBe(null);
  expect(header.querySelector('h1').textContent).toBe('Mission Control');
  expect(document.title).toBe('Mission Control - Aether Portal');
  expect(document.getElementById('mc-clock')).toBe(null);
  expect(document.querySelector('#mc-status .status-pill [data-status="text"]').textContent).toBe('Engine Live');
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
  expect(document.querySelector('#mc-elaron .brain-dock h2').textContent).toBe('Elarion');

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

  // Reaching for the composer opens the Elarion drawer and puts the cursor in its message box.
  const composerInput = document.getElementById('mc-command-input');
  mc.tabs.select('overview');
  composerInput.focus();
  expect(mc.drawer.isOpen()).toBe(true);
  expect(document.activeElement).toBe(mc.dock.elements.input);
  mc.drawer.close();
  mc.tabs.select('studio');
  expect(document.body.dataset.view).toBe('studio');
  // Sending from the command bar opens Elarion and keeps the cursor in Elarion's own box.
  mc.tabs.select('overview');
  composerInput.value = 'status?';
  document.getElementById('mc-command').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(mc.drawer.isOpen()).toBe(true);
  expect(document.getElementById('mc-drawer').hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(mc.dock.elements.input);
  mc.drawer.close();
  expect(document.getElementById('mc-drawer').hasAttribute('inert')).toBe(true);
  mc.tabs.select('blueprints');
  expect(window.location.hash).toBe('#blueprints');
  expect(document.querySelector('#mc-blueprints .bp-advanced .bp-ingest')).not.toBe(null);
  expect(document.querySelector('#mc-blueprints .bp-tier').textContent).toBe('Pro Engine');

  // Elarion is a drawer, not a page: the old #elaron route opens it over the current page. Agent spec (Studio) opens a popup and starts nothing.
  mc.tabs.select('elaron');
  expect(mc.drawer.isOpen()).toBe(true);
  expect(mc.tabs.getView()).not.toBe('elaron');
  mc.drawer.close();
  document.getElementById('mc-nav-studio').click();
  document.getElementById('mc-agent-spec').click();
  expect(document.querySelector('.dc-modal .dc-title').textContent).toBe('Agent spec');
  expect(mc.tabs.getView()).toBe('studio');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('.dc-modal')).toBeNull();
  // The page title is the menu button, and a view change rewrites its text without replacing the button.
  const menu = document.getElementById('mc-menu-toggle');
  document.getElementById('mc-nav-connect').click();
  expect(document.getElementById('mc-title-text').textContent).toBe('Settings');
  expect(document.getElementById('mc-title').textContent).toBe('Settings');
  expect(document.getElementById('mc-menu-toggle')).toBe(menu);
  expect(menu.closest('h1')).toBe(document.getElementById('mc-title'));
  overviewNav.click();
  expect(window.location.hash).toBe('');
});

it('New (+) opens the unified New project dialog: a template and its brief become a reviewed plan', async () => {
  await mountPage();
  document.getElementById('mc-nav-new').click();
  const dialog = document.querySelector('.np-modal');
  expect(dialog).not.toBeNull();
  expect([...dialog.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Pick Template', 'Roadmap Templates', 'Select Space Cards', 'Describe Goal', 'Paste Links']);
  expect(window.location.hash).toBe('');
  dialog.querySelector('input[value="landing-waitlist"]').click();
  dialog.querySelector('[data-field="domain"]').value = 'waitlist.example.com';
  // Template -> About the project -> Elarion's questions (the page check is skipped here: the fake engine has no intake endpoint) -> review.
  for (let n = 0; n < 3; n++) {
    dialog.querySelector('.np-next').click();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }
  // One review card, whichever tab fed it: the plain-language plan, what it will use, and the approve button.
  expect(dialog.querySelector('.np-project').textContent).toBe('Landing page + waitlist');
  expect(dialog.querySelector('.np-estimate')).not.toBeNull();
  expect(dialog.querySelector('.np-next').textContent).toBe('Approve & Run (Pro)');
  expect(document.getElementById('mc-nav-blueprints').getAttribute('aria-current')).toBe(null);
  // The old #create route opens the same dialog.
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('.np-modal')).toBeNull();
  mc.tabs.select('create');
  expect(document.querySelector('.np-modal')).not.toBeNull();
  mc.newProject.close();
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
    expect(requested.filter((u) => u !== '/api/graph' && !u.startsWith('/api/conversations/'))).toEqual(['/api/outcome/node_42/blueprint']);
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
  // Docked on every page, sized to the screen; the style rule lives in the page template.
  expect(html).not.toMatch(/\[data-view="[a-z]+"\] \.mc-command/);
  expect(html).toMatch(/\.mc-command \{ flex: none; box-sizing: border-box; width: 100%; max-width: 100vw;/);
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

it('with no model key at all the banner asks for one, only where it helps, and never suggests a first project', async () => {
  await mountWithConfig({ miserly_key_configured: false, miserly_key_hint: null, miserly_key_status: 'missing', miserly_key_detail: 'No key', public_url: null, elarion_ready: false });
  const next = document.getElementById('mc-next');
  expect(next.hidden).toBe(false);
  expect(bannerTitle()).toBe('Add an AI model key');
  expect(next.textContent).not.toContain('Start your first project');
  // Settings shows the form itself, so the banner steps aside there; other pages still get the blocker.
  mc.tabs.select('connect');
  expect(next.hidden).toBe(true);
  mc.tabs.select('blueprints');
  expect(next.hidden).toBe(false);
  expect(bannerTitle()).toBe('Add an AI model key');
  mc.tabs.select('monitor');
  expect(next.hidden).toBe(false);
  // The Settings checklist already reflects it: reachable, authorized, key still to do.
  expect([...document.querySelectorAll('.qs-step')].map((li) => li.dataset.state)).toEqual(['ok', 'ok', 'fail']);
  // The status pill agrees something needs attention.
  expect(document.querySelector('[data-status="pill"]').textContent.trim()).toBe('Engine Live · Setup needed');
});

it('Miserly is optional: with no Miserly key but the engine calling the provider directly, nothing asks for one', async () => {
  await mountWithConfig({ miserly_key_configured: false, miserly_key_hint: null, miserly_key_status: 'missing', miserly_key_detail: 'No Miserly client key is set.', public_url: null, elarion_ready: true, execution_mode: 'direct-anthropic' });
  expect(bannerTitle()).not.toMatch(/key/i);
  // The Settings checklist is all green, and the form says Miserly is not needed.
  expect([...document.querySelectorAll('.qs-step')].map((li) => li.dataset.state)).toEqual(['ok', 'ok', 'ok']);
  expect(document.getElementById('qs-key-hint').textContent).toContain('Not needed');
  expect(document.querySelector('[data-status="pill"]').textContent.trim()).not.toBe('Setup needed');
  mc.tabs.select('blueprints');
  expect(bannerTitle()).not.toMatch(/key/i);
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

it("a message from Space's composer opens the Elarion drawer and is sent once", async () => {
  sessionStorage.setItem('aether.pendingAsk', JSON.stringify({ text: 'what changed in my graph?', from: 'Space', at: Date.now() }));
  await mountPage();
  expect(mc.drawer.isOpen()).toBe(true);
  expect(document.querySelector('#mc-elaron .brain-user').textContent).toContain('what changed in my graph?');
  expect(sessionStorage.getItem('aether.pendingAsk')).toBe(null);
});

it('ignores a stale or empty Space message', () => {
  const win = { sessionStorage: { getItem: () => JSON.stringify({ text: 'old', at: 1000 }), removeItem() {} } };
  expect(takeSpaceHandoff(win, 1000 + 121000)).toBe(null);
  expect(takeSpaceHandoff(win, 1000 + 5000)).toBe('old');
  expect(takeSpaceHandoff({ sessionStorage: { getItem: () => JSON.stringify({ text: '  ', at: 1000 }), removeItem() {} } }, 2000)).toBe(null);
  expect(takeSpaceHandoff({})).toBe(null);
});

it('#elarion opens the conversation drawer, at load and from a link while the page is open', async () => {
  window.location.hash = '#elarion';
  try {
    await mountPage();
    expect(mc.drawer.isOpen()).toBe(true);
    expect(window.location.hash).toBe('');
    mc.drawer.close();
    window.location.hash = '#elarion';
    window.dispatchEvent(new Event('hashchange'));
    expect(mc.drawer.isOpen()).toBe(true);
    mc.drawer.close();
    window.location.hash = '#monitor';
    window.dispatchEvent(new Event('hashchange'));
    expect(mc.tabs.getView()).toBe('monitor');
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('a link shared to the app opens New project on Paste Links, filled in, with every tab one tap away', async () => {
  window.history.replaceState(null, '', '/mission-control?share_url=' + encodeURIComponent('https://shared.test/article') + '&share_title=A%20good%20read');
  try {
    await mountPage();
    const dialog = document.querySelector('.np-modal');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('[role="tab"][aria-selected="true"]').textContent).toBe('Paste Links');
    expect(dialog.querySelector('[data-field="links"]').value).toBe('https://shared.test/article');
    expect(dialog.querySelector('[data-field="linksName"]').value).toBe('A good read');
    expect(window.location.search).toBe('');
    const roadmap = [...dialog.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Roadmap Templates');
    roadmap.click();
    expect(dialog.querySelector('[data-np-panel="roadmap"]').hidden).toBe(false);
    expect(dialog.querySelectorAll('[data-np-panel="roadmap"] .np-card').length).toBeGreaterThanOrEqual(5);
    mc.newProject.close();
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('shared text with no link opens Describe Goal; no share parameters open nothing', () => {
  const win = (search) => ({ location: { search, pathname: '/mission-control', hash: '' }, history: { replaceState() {} } });
  expect(takeShareParams(win('?share_text=Plan%20a%20bakery%20launch'))).toEqual({ url: '', title: '', text: 'Plan a bakery launch' });
  expect(takeShareParams(win('?other=1'))).toBe(null);
  expect(takeShareParams({})).toBe(null);
});

it('the New project dialog wears the minimal dark shell and the menu drawer is 260px', () => {
  const html = renderMissionControlPage({ assetVersion: 'test' });
  expect(html).toMatch(/\.np-modal \{ background: #0B0D10; border-color: rgba\(255, 255, 255, 0\.08\)/);
  expect(html).toContain("--surface-soft:#15181D");
  expect(html).toMatch(/\.np-scrim \{[^}]*font-family: "Geist"/);
  expect(html).toContain('width: min(260px, 86vw)');
});
