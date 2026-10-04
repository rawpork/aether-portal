// Mission Control entry (/mission-control, src/mission-control-page.js). Gets an engine token first (connection.js),
// so the breaker, workforce overview, task monitor, blueprint dashboard and Elarion dock all start out authenticated,
// then mounts them. The dark sidebar rail switches between the views.
import { getEngineApi, getStoredEngineToken } from '../engine-api.bundle.js';
import { mountBlueprintWorkspace } from './blueprints.js';
import { mountBreakerBar } from './breaker-bar.js';
import { ENGINE_PARAM, mountConnectionWizard } from './connection-wizard.js';
import { mountBrainDock } from './brain-dock.js';
import { describeUnreachableEngine, mountConnection } from './connection.js';
import { mountTaskMonitor } from './task-monitor.js';
import { mountStudioCanvas } from './studio-canvas.js';
import { mountWorkflowConsole } from './workflow-console.js';
import { setupTheme } from './theme.js';
import { mountQuickSetup } from './quick-setup.js';
import { clockTime, greetingFor, mountWorkforce } from './workforce.js';

// view -> sidebar button id (its aria-controls names the view's panel). #studio / #monitor / #blueprints / #elaron / #connect open a view; no hash is the overview.
const VIEWS = { overview: 'mc-nav-overview', studio: 'mc-nav-studio', elaron: 'mc-nav-elaron', blueprints: 'mc-nav-blueprints', monitor: 'mc-nav-monitor', connect: 'mc-nav-connect' };
const VIEW_TITLES = { overview: 'Mission Control', studio: 'Studio', elaron: 'Elarion', blueprints: 'Projects', monitor: 'Run history', connect: 'Settings' };

// Studio sub-tabs (Workflow console, Engine activity): roving tabindex, arrow keys move between them.
export function setupStudioTabs(doc, onChange = () => {}) {
  const tabs = ['workflow', 'activity'].map((name) => ({ name, tab: doc.getElementById('mc-studio-tab-' + name) })).filter((t) => t.tab);
  if (!tabs.length) return null;
  let current = 'workflow';
  function select(name, focus = false) {
    current = name;
    for (const t of tabs) {
      const on = t.name === name;
      t.tab.setAttribute('aria-selected', String(on));
      t.tab.setAttribute('tabindex', on ? '0' : '-1');
      doc.getElementById(t.tab.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.tab.focus();
    }
    onChange(name);
  }
  tabs.forEach((t, i) => {
    t.tab.addEventListener('click', () => select(t.name));
    t.tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      select(tabs[(i + step + tabs.length) % tabs.length].name, true);
    });
  });
  return { select, getTab: () => current };
}

// Sidebar views: each rail button shows its view and is marked aria-current="page" while it is open.
export function setupTabs(doc, onSelect = () => {}) {
  const win = doc.defaultView;
  const all = Object.entries(VIEWS).map(([view, id]) => ({ view, tab: doc.getElementById(id) })).filter((t) => t.tab);
  const crumb = doc.getElementById('mc-crumb-view');
  let current = 'overview';

  function select(view, focus = false) {
    if (!(view in VIEWS)) view = 'overview';
    current = view;
    for (const t of all) {
      const active = t.view === view;
      if (active) t.tab.setAttribute('aria-current', 'page');
      else t.tab.removeAttribute('aria-current');
      doc.getElementById(t.tab.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) t.tab.focus();
    }
    if (crumb) crumb.textContent = VIEW_TITLES[view];
    doc.body.dataset.view = view;
    if (win && win.history && win.location) {
      const hash = view === 'overview' ? '' : '#' + view;
      if (win.location.hash !== hash) win.history.replaceState(null, '', win.location.pathname + win.location.search + hash);
    }
    onSelect(view);
  }

  all.forEach((t) => t.tab.addEventListener('click', () => select(t.view)));
  const hash = win && win.location ? win.location.hash.slice(1) : '';
  select(hash in VIEWS ? hash : 'overview');
  return { select, getView: () => current, destroy() {} };
}

// Header: time-of-day greeting with the signed-in user's name, and the LIVE clock.
function startHeader(doc) {
  const name = meta(doc, 'aether-user');
  const greeting = doc.getElementById('mc-greeting');
  const clock = doc.getElementById('mc-clock');
  const tick = () => {
    const now = new Date();
    if (greeting) greeting.textContent = greetingFor(now) + (name ? ', ' + name : '');
    if (clock) clock.textContent = clockTime(now);
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

const meta = (doc, name) => {
  const tag = doc.querySelector('meta[name="' + name + '"]');
  return tag ? tag.getAttribute('content') || '' : '';
};

// /mission-control?engine=<url> (a pairing QR code or link): open Connection and ask before switching engines.
function offerPairingFromLink(doc, wizard, tabs) {
  const win = doc.defaultView;
  const params = new URLSearchParams((win && win.location && win.location.search) || '');
  const engineUrl = params.get(ENGINE_PARAM);
  if (engineUrl === null) return null;
  params.delete(ENGINE_PARAM);
  if (win.history) win.history.replaceState(null, '', win.location.pathname + (params.toString() ? '?' + params : '') + '#connect');
  tabs.select('connect');
  return wizard.offerPairing(engineUrl);
}

// /mission-control?outcome=<id>: fetch that outcome's blueprint from the portal and load it into the editor.
async function importOutcome(doc, blueprints, tabs, fetchImpl) {
  const win = doc.defaultView;
  const params = new URLSearchParams((win && win.location && win.location.search) || '');
  const outcomeId = params.get('outcome');
  if (!outcomeId) return null;
  params.delete('outcome');
  if (win.history) win.history.replaceState(null, '', win.location.pathname + (params.toString() ? '?' + params : '') + '#blueprints');
  tabs.select('blueprints');
  try {
    const response = await fetchImpl('/api/outcome/' + encodeURIComponent(outcomeId) + '/blueprint', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return blueprints.loadSpec(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    blueprints.loadSpec('');
    blueprints.elements.feedback.textContent = 'Could not load that outcome’s blueprint from the portal (' + error.message + ').';
    return null;
  }
}

export async function mountMissionControl(doc = document, options = {}) {
  const api = options.api || getEngineApi();
  const byId = (id) => doc.getElementById(id);
  // Theme toggle and the Engine State link work before (and without) an engine connection.
  let tabs;
  const theme = setupTheme(doc, {
    getEngineBase: () => api.baseUrl,
    getToken: options.getToken || getStoredEngineToken,
    // On a phone with no reachable engine address, Engine State explains and opens Settings instead of localhost.
    onEngineUnreachable: () => {
      const note = byId('mc-engine-note');
      if (note) {
        note.textContent = describeUnreachableEngine(api.baseUrl) || 'The Engine State page needs an engine address this device can open. Pair this device below.';
        note.hidden = false;
      }
      if (tabs) tabs.select('connect', true);
    },
  });

  const connection = await mountConnection(byId('mc-connection'), { baseUrl: api.baseUrl, ...options.connection });

  const breaker = mountBreakerBar(byId('mc-breaker'), {
    api,
    // A 401 usually means the token expired or the portal can't mint one: try again, then show how we're connected.
    onAuthNeeded: async () => {
      await connection.refresh();
      connection.open();
      breaker.refresh();
    },
  });

  let blueprints = null;
  const monitor = mountTaskMonitor(byId('mc-monitor'), {
    api,
    statusEl: byId('mc-monitor-status'),
    onOpenProject: (blueprintId) => {
      tabs.select('blueprints', true);
      blueprints.select(blueprintId);
    },
  });
  blueprints = mountBlueprintWorkspace(byId('mc-blueprints'), {
    api,
    tier: options.tier || meta(doc, 'aether-tier') || 'free',
    upgradeUrl: options.upgradeUrl ?? meta(doc, 'aether-upgrade-url'),
    // A deploy runs as a task loop: show it in the monitor once the engine has registered it, and again when done.
    onStarted: () => setTimeout(() => monitor.refresh(), 300),
    onExecuted: () => monitor.refresh(),
  });
  const dock = mountBrainDock(byId('mc-elaron'), { api, ...options.dock });
  const wizard = mountConnectionWizard(byId('mc-connect'), { api, ...options.wizard });
  // Opens Settings once tabs exist (the badge can be clicked before then only in theory).
  const quickSetup = mountQuickSetup(byId('mc-quick-setup'), {
    api,
    badge: byId('mc-ready'),
    onOpenSettings: () => tabs && tabs.select('connect'),
    ...options.quickSetup,
  });
  const agentBadge = byId('mc-agent-count');
  const computeValue = byId('mc-compute-value');
  const computeSub = byId('mc-compute-sub');
  const computeBar = byId('mc-compute-bar');
  const workforce = mountWorkforce(byId('mc-workforce'), {
    api,
    portalFetch: options.portalFetch,
    onConnect: () => tabs.select('connect', true),
    onOpenElarion: () => tabs.select('elaron', true),
    // Sidebar: agent count, and the compute card (tokens spent; the bar is the share of runs that completed).
    onAgentsChange: (agents, counts) => {
      if (agentBadge) agentBadge.textContent = String(agents.length);
      const tokens = agents.reduce((sum, a) => sum + a.tokens, 0);
      const runs = counts ? counts.running + counts.completed + counts.halted + counts.failed : 0;
      if (computeValue) computeValue.textContent = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
      if (computeSub) computeSub.textContent = 'tokens · ' + (counts ? counts.completed : 0) + ' / ' + runs + ' runs done';
      if (computeBar) computeBar.style.width = (runs ? Math.round((counts.completed / runs) * 100) : 0) + '%';
    },
  });
  // Studio: the Workflow console and the Engine activity canvas, each polling the engine only while it is on screen.
  const studio = byId('mc-studio') ? mountStudioCanvas(byId('mc-studio'), { api, onConnect: () => tabs.select('connect', true), ...options.studio }) : null;
  const workflowConsole = byId('mc-workflow') ? mountWorkflowConsole(byId('mc-workflow'), { api, onConnect: () => tabs.select('connect', true), ...options.workflow }) : null;
  const studioTabs = setupStudioTabs(doc, () => syncStudio());
  let studioShown = false;
  function syncStudio() {
    const shown = studioShown;
    const pane = studioTabs ? studioTabs.getTab() : 'workflow';
    if (workflowConsole) workflowConsole.setActive(shown && pane === 'workflow');
    if (studio) studio.setActive(shown && pane === 'activity');
  }
  tabs = setupTabs(doc, (view) => {
    if (view === 'blueprints') blueprints.refresh();
    if (view === 'overview') workforce.refresh();
    studioShown = view === 'studio';
    syncStudio();
  });
  // "+ New agent": agents are started by deploying a blueprint, so open Projects at the editor.
  const newAgent = byId('mc-new-agent');
  if (newAgent) {
    newAgent.addEventListener('click', () => {
      tabs.select('blueprints');
      const editor = doc.querySelector('#mc-blueprints .bp-editor');
      if (editor) editor.focus();
    });
  }
  const stopHeader = startHeader(doc);
  offerPairingFromLink(doc, wizard, tabs);
  await importOutcome(doc, blueprints, tabs, options.portalFetch || ((url, init) => (doc.defaultView || globalThis).fetch(url, init)));

  return { connection, breaker, monitor, blueprints, dock, wizard, quickSetup, workforce, studio, workflowConsole, studioTabs, tabs, stopHeader, theme };
}

if (typeof document !== 'undefined' && document.getElementById('mc-breaker')) mountMissionControl();
