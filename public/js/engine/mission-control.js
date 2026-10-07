// Mission Control entry (/mission-control, src/mission-control-page.js). Gets an engine token first (connection.js),
// so the breaker, workforce overview, task monitor, blueprint dashboard and Elarion dock all start out authenticated,
// then mounts them. The dark sidebar rail switches between the views.
import '../shell-keys.js';
import { getEngineApi, getStoredEngineToken } from '../engine-api.bundle.js';
import { mountBlueprintWorkspace } from './blueprints.js';
import { mountBreakerBar } from './breaker-bar.js';
import { mountStatusPill } from './status-pill.js';
import { ENGINE_PARAM, mountConnectionWizard } from './connection-wizard.js';
import { mountBrainDock } from './brain-dock.js';
import { describeUnreachableEngine, mountConnection } from './connection.js';
import { mountTaskMonitor } from './task-monitor.js';
import { mountOperatorConsole } from './operator-console.js';
import { mountAgentDialogue } from './agent-dialogue.js';
import { mountDualAgents } from './dual-agents.js';
import { mountRoadmap } from './roadmap.js';
import { mountDecisionCenter, skillCommandSource } from './decision-center.js';
import { mountCommandBar } from './command-bar.js';
import { mountOutcomesList, takeProjectPayload } from './outcomes.js';
import { mountStudioCanvas } from './studio-canvas.js';
import { mountTemplates } from './templates.js';
import { mountWorkflowConsole } from './workflow-console.js';
import { setupTheme } from './theme.js';
import { mountQuickSetup } from './quick-setup.js';
import { greetingFor, mountWorkforce } from './workforce.js';

// view -> sidebar button id (its aria-controls names the view's panel). #studio / #create / #monitor / #blueprints / #elaron / #connect open a view; no hash is the overview.
const VIEWS = { overview: 'mc-nav-overview', studio: 'mc-nav-studio', elaron: 'mc-nav-elaron', create: 'mc-nav-create', blueprints: 'mc-nav-blueprints', roadmap: 'mc-nav-roadmap', operator: 'mc-nav-operator', monitor: 'mc-nav-monitor', connect: 'mc-nav-connect' };
const VIEW_TITLES = { overview: 'Mission Control', studio: 'Studio', elaron: 'Elarion', create: 'Create / Templates', blueprints: 'Projects', roadmap: 'Roadmap', operator: 'Operator Console', monitor: 'Run history', connect: 'Settings' };

// A set of tabs over panels (Operator: Live log / Agent dialogue): roving tabindex, arrow keys move between them.
export function setupTabset(doc, pairs, onChange = () => {}) {
  const tabs = pairs.map(([tabId, panelId]) => ({ tab: doc.getElementById(tabId), panel: doc.getElementById(panelId) })).filter((t) => t.tab && t.panel);
  if (!tabs.length) return null;
  function select(index, focus = false) {
    tabs.forEach((t, i) => {
      const on = i === index;
      t.tab.setAttribute('aria-selected', String(on));
      t.tab.setAttribute('tabindex', on ? '0' : '-1');
      t.panel.hidden = !on;
      if (on && focus) t.tab.focus();
    });
    onChange(index);
  }
  tabs.forEach((t, i) => {
    t.tab.addEventListener('click', () => select(i));
    t.tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      select((i + step + tabs.length) % tabs.length, true);
    });
  });
  return { select };
}

// Menu tray (☰), like Claude and Gemini. Desktop: the rail folds to icons and back, remembered per browser (medium
// screens start folded). Phones: the rail is a drawer that slides in over a scrim; picking a view, the scrim or Escape
// closes it.
export const RAIL_KEY = 'aether.mc.rail';
export function setupMenuTray(doc, { win = doc.defaultView, storage = win.localStorage } = {}) {
  const body = doc.body;
  const toggle = doc.getElementById('mc-menu-toggle');
  const scrim = doc.getElementById('mc-scrim');
  const rail = doc.getElementById('mc-rail');
  if (!toggle || !rail) return null;
  const phone = win.matchMedia('(max-width: 680px)');
  const medium = win.matchMedia('(max-width: 1180px)');
  let preference = null;
  try {
    preference = storage.getItem(RAIL_KEY);
  } catch { /* storage blocked */ }
  const isOpen = () => body.classList.contains('rail-open');
  function apply() {
    if (phone.matches) {
      body.dataset.rail = 'full';
      toggle.setAttribute('aria-expanded', String(isOpen()));
      return;
    }
    body.classList.remove('rail-open');
    if (scrim) scrim.hidden = true;
    const mode = preference === 'icons' || preference === 'full' ? preference : medium.matches ? 'icons' : 'full';
    body.dataset.rail = mode;
    toggle.setAttribute('aria-expanded', String(mode === 'full'));
  }
  function open() {
    body.classList.add('rail-open');
    if (scrim) scrim.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    const first = rail.querySelector('.rail-item');
    if (first) first.focus();
  }
  function close(focusToggle = true) {
    if (!isOpen()) return;
    body.classList.remove('rail-open');
    if (scrim) scrim.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focusToggle) toggle.focus();
  }
  toggle.addEventListener('click', () => {
    if (phone.matches) {
      if (isOpen()) close();
      else open();
      return;
    }
    preference = body.dataset.rail === 'full' ? 'icons' : 'full';
    try {
      storage.setItem(RAIL_KEY, preference);
    } catch { /* storage blocked */ }
    apply();
  });
  if (scrim) scrim.addEventListener('click', () => close());
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) close();
  });
  rail.addEventListener('click', (event) => {
    if (phone.matches && event.target.closest('.rail-item')) close(false);
  });
  const listen = (query) => (query.addEventListener ? query.addEventListener('change', apply) : query.addListener(apply));
  listen(phone);
  listen(medium);
  apply();
  return { open, close, apply, getMode: () => body.dataset.rail };
}

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

// Views whose page has its own input, so the shared command bar is hidden there (mirrors the CSS in mission-control-page.js).
const composerHiddenFor = (view) => view === 'elaron' || view === 'studio' || view === 'blueprints';

// Sidebar views: each rail button shows its view and is marked aria-current="page" while it is open.
export function setupTabs(doc, onSelect = () => {}) {
  const win = doc.defaultView;
  const all = Object.entries(VIEWS).map(([view, id]) => ({ view, tab: doc.getElementById(id) })).filter((t) => t.tab);
  const title = doc.getElementById('mc-title');
  const announce = doc.getElementById('mc-route');
  const baseTitle = doc.title;
  let current = 'overview';
  let started = false;

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
    // The page name is the H1, the tab title follows it, and a screen reader hears the change (not on first load).
    if (title) title.textContent = VIEW_TITLES[view];
    doc.title = view === 'overview' ? baseTitle : VIEW_TITLES[view] + ' - ' + baseTitle;
    if (announce && started) announce.textContent = VIEW_TITLES[view];
    started = true;
    doc.body.dataset.view = view;
    // The command bar hides on pages that own an input. If focus was in it, hand focus to the page title instead of losing it.
    const composer = doc.getElementById('mc-command');
    if (composer && composer.contains(doc.activeElement) && composerHiddenFor(view) && title) {
      title.setAttribute('tabindex', '-1');
      title.focus();
    }
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

// Header: time-of-day greeting with the signed-in user's name. (The ticking LIVE clock is gone: the status pill's popover
// shows when the engine last answered, which is the time that matters.)
function startHeader(doc) {
  const name = meta(doc, 'aether-user');
  const greeting = doc.getElementById('mc-greeting');
  const tick = () => {
    if (greeting) greeting.textContent = greetingFor(new Date()) + (name ? ', ' + name : '');
  };
  tick();
  const timer = setInterval(tick, 60000);
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

// /mission-control?project=1: "Make it a project" on a portal card left a project payload in storage; load it.
function importProject(doc, blueprints, tabs, storage) {
  const win = doc.defaultView;
  const params = new URLSearchParams((win && win.location && win.location.search) || '');
  if (!params.get('project')) return null;
  params.delete('project');
  if (win.history) win.history.replaceState(null, '', win.location.pathname + (params.toString() ? '?' + params : '') + '#blueprints');
  tabs.select('blueprints');
  const payload = storage ? takeProjectPayload(storage) : null;
  if (!payload) {
    blueprints.loadSpec('');
    blueprints.elements.feedback.textContent = 'The project from Space had expired or was missing. Use Make it a project on the card again.';
    return null;
  }
  const result = blueprints.loadSpec(JSON.stringify(payload.spec, null, 2));
  blueprints.elements.feedback.textContent = 'Loaded from Space: ' + payload.spec.links.length + (payload.spec.links.length === 1 ? ' card' : ' cards') + '. Validate, then Compile blueprint.';
  return result;
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

  // One worded status in the header. Its popover hosts the breaker controls and the Elarion readiness row.
  let workforce = null;
  let stoppable = [];
  // A 401 usually means the token expired or the portal can't mint one: try again, then show how we're connected.
  const reconnect = async () => {
    await connection.refresh();
    connection.open();
    breaker.refresh();
  };
  const statusPill = byId('mc-status') ? mountStatusPill(byId('mc-status'), {
    onEngineAction: (state) => (state === 'AUTH' ? reconnect() : breaker.refresh()),
  }) : null;
  const breaker = mountBreakerBar(byId('mc-breaker'), {
    api,
    labels: {
      trip: { long: 'Stop all agents', short: 'Stop', aria: 'Stop all agents' },
      reset: { long: 'Resume Elarion', short: 'Resume', aria: 'Resume Elarion' },
      confirmTitle: 'Stop all agents?',
      confirmAction: 'Stop all agents',
      confirmText: (agentId, others) => 'This stops Elarion' + (others.length ? ' and ' + others.length + ' other agent' + (others.length === 1 ? '' : 's') : '') + ' right now: running task loops stop at their next step, chat is refused and voice streams close. They stay stopped until you resume them. Resume Elarion from the status pill; resume other agents from their cards.',
    },
    getTripTargets: () => stoppable,
    onChange: (b) => statusPill && statusPill.update({ breaker: b }),
    onStopped: () => workforce && workforce.refresh(),
    onAuthNeeded: reconnect,
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
    onCompleted: (bp, outcome) => { if (outcomes) outcomes.recordRun(bp, outcome); },
  });
  // Create / Templates: a template and its brief compile into a blueprint, which then opens under Projects with
  // Deploy & Execute ready.
  const templates = byId('mc-templates') ? mountTemplates(byId('mc-templates'), {
    api,
    onCompiled: async (blueprintId, blueprint, { template }) => {
      tabs.select('blueprints');
      await blueprints.refresh();
      await blueprints.select(blueprintId, blueprint);
      blueprints.elements.feedback.textContent = 'Created ' + blueprintId + ' from the ' + template.name + ' template and your brief. Press Deploy & Execute to start the run.';
      const deployButton = blueprints.elements.viewer.querySelector('.bp-deploy');
      if (deployButton) deployButton.focus();
    },
    onBlank: () => {
      tabs.select('blueprints');
      blueprints.elements.editor.focus();
    },
  }) : null;
  const outcomes = byId('mc-outcomes') ? mountOutcomesList(byId('mc-outcomes'), { api, portalFetch: options.portalFetch, storage: options.storage }) : null;
  const dock = mountBrainDock(byId('mc-elaron'), { api, ...options.dock });
  // The rail's badge counts the choices waiting, so a question is seen from any view.
  const operatorCount = byId('mc-operator-count');
  const operator = byId('mc-operator') ? mountOperatorConsole(byId('mc-operator'), {
    api,
    statusEl: byId('mc-operator-status'),
    onWaitingChange: (count) => {
      if (!operatorCount) return;
      if (statusPill) statusPill.update({ waiting: count });
      operatorCount.hidden = count === 0;
      operatorCount.textContent = String(count);
    },
  }) : null;
  const dialogue = byId('mc-dialogue') ? mountAgentDialogue(byId('mc-dialogue'), { api }) : null;
  // Claude ⇄ Gemini: starts its background polling the first time the tab opens.
  const dual = byId('mc-dual') ? mountDualAgents(byId('mc-dual'), { api, ...options.dual }) : null;
  let dualStarted = false;
  const operatorTabs = setupTabset(doc, [['mc-operator-tab-log', 'mc-operator'], ['mc-operator-tab-dialogue', 'mc-dialogue'], ['mc-operator-tab-dual', 'mc-dual']], (index) => {
    if (index === 1 && dialogue) dialogue.refresh();
    if (index === 2 && dual) {
      if (!dualStarted) dual.start();
      else dual.refresh();
      dualStarted = true;
    }
  });
  const roadmap = byId('mc-roadmap') ? mountRoadmap(byId('mc-roadmap'), { api }) : null;
  let roadmapStarted = false;
  const wizard = mountConnectionWizard(byId('mc-connect'), { api, ...options.wizard });
  // Opens Settings once tabs exist (the badge can be clicked before then only in theory).
  const quickSetup = mountQuickSetup(byId('mc-quick-setup'), {
    api,
    badge: byId('mc-ready'),
    onBadge: (b) => statusPill && statusPill.update({ elarion: b }),
    onOpenSettings: () => tabs && tabs.select('connect'),
    ...options.quickSetup,
  });
  const agentBadge = byId('mc-agent-count');
  const computeValue = byId('mc-compute-value');
  const computeSub = byId('mc-compute-sub');
  const computeBar = byId('mc-compute-bar');
  workforce = mountWorkforce(byId('mc-workforce'), {
    api,
    portalFetch: options.portalFetch,
    onConnect: () => tabs.select('connect', true),
    onOpenElarion: () => tabs.select('elaron', true),
    onNavigate: (view) => tabs.select(view, true),
    storage: options.storage,
    showNext: false,
    // Sidebar: agent count, and the compute card (tokens spent; the bar is the share of runs that completed).
    onAgentsChange: (agents, counts) => {
      stoppable = agents.filter((a) => a.status !== 'tripped' && a.status !== 'paused').map((a) => a.agentId);
      if (statusPill) statusPill.update({ agents: { working: agents.filter((a) => a.status === 'running').length, total: agents.length, stopped: agents.filter((a) => a.status === 'tripped' || a.status === 'paused').length } });
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
    if (view === 'roadmap' && roadmap) {
      if (!roadmapStarted) roadmap.start();
      else roadmap.refresh();
      roadmapStarted = true;
    }
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
  const tray = setupMenuTray(doc);
  // Command bar: whatever is typed (or spoken) goes to Elarion, and the view opens on the reply.
  const commandForm = byId('mc-command');
  const commandBar = commandForm ? mountCommandBar(commandForm, {
    input: byId('mc-command-input'),
    mic: byId('mc-command-mic'),
    win: doc.defaultView || globalThis,
    onSubmit: (text) => {
      // "add repo <link>", "add skill <link or text>", "learn <...>": Elarion drafts a SKILL.md to review and save.
      const source = skillCommandSource(text);
      if (source && decisions) {
        decisions.learn(source);
        return;
      }
      tabs.select('elaron');
      // Busy or halted: leave the text in the dock's own box so it isn't lost. Either way, keep typing there.
      if (!dock.send(text)) dock.elements.input.value = text;
      dock.elements.input.focus();
    },
  }) : null;
  const stopHeader = startHeader(doc);
  const skillButton = byId('mc-command-skill');
  // The "Do this next" banner on every view, and numbered choice popups for decisions, finished runs and skills.
  const decisions = options.decisions === false ? null : mountDecisionCenter(doc, {
    api,
    slot: byId('mc-next'),
    storage: options.storage,
    onNavigate: (view) => {
      if (view === 'activity') {
        tabs.select('overview', true);
        workforce.showActivity();
      } else if (view === 'connect') tabs.select('connect', true);
      else tabs.select(view, true);
    },
  });
  offerPairingFromLink(doc, wizard, tabs);
  try {
    importProject(doc, blueprints, tabs, options.storage || (doc.defaultView && doc.defaultView.localStorage));
  } catch (error) {
    blueprints.elements.feedback.textContent = 'Could not load the project from Space (' + error.message + ').';
  }
  await importOutcome(doc, blueprints, tabs, options.portalFetch || ((url, init) => (doc.defaultView || globalThis).fetch(url, init)));

  if (skillButton && decisions) skillButton.addEventListener('click', () => decisions.askSource());
  return { connection, breaker, monitor, templates, outcomes, operator, dialogue, dual, roadmap, decisions, operatorTabs, tray, commandBar, blueprints, dock, wizard, quickSetup, workforce, studio, workflowConsole, studioTabs, tabs, stopHeader, theme };
}

if (typeof document !== 'undefined' && document.getElementById('mc-breaker')) mountMissionControl();
