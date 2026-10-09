// Mission Control entry (/mission-control, src/mission-control-page.js). Gets an engine token first (connection.js),
// so the breaker, workforce overview, task monitor, blueprint dashboard and Elarion dock all start out authenticated,
// then mounts them. The dark sidebar rail switches between the views.
import '../shell-keys.js';
import { trapFocus } from '../a11y.js';
import { getEngineApi, getStoredEngineToken } from '../engine-api.bundle.js';
import { mountBlueprintWorkspace } from './blueprints.js';
import { mountBreakerBar } from './breaker-bar.js';
import { mountStatusPill } from './status-pill.js';
import { ENGINE_PARAM, mountConnectionWizard } from './connection-wizard.js';
import { mountBrainDock } from './brain-dock.js';
import { describeUnreachableEngine, mountConnection } from './connection.js';
import { mountTaskMonitor } from './task-monitor.js';
import { mountOperatorConsole } from './operator-console.js';
import { mountRealtimeRefresh } from './realtime-refresh.js';
import { mountRealtimeAlerts } from './realtime-alerts.js';
import { mountPollRate } from './poll-rate.js';
import { mountAgentDialogue } from './agent-dialogue.js';
import { mountDualAgents } from './dual-agents.js';
import { mountRoadmap } from './roadmap.js';
import { mountDecisionCenter, skillCommandSource } from './decision-center.js';
import { mountCommandBar } from './command-bar.js';
import { mountOutcomesList, takeProjectPayload } from './outcomes.js';
import { projectTitle } from './labels.js';
import { mountStudioCanvas } from './studio-canvas.js';
import { mountNewProject } from './new-project.js';
import { createConversationStore } from './conversation-store.js';
import { projectContext, studioContext } from './elarion-context.js';
import { saveBlueprintRecord } from './records-write.js';
import { setupElarionDrawer } from './elarion-drawer.js';
import { mountWorkflowConsole } from './workflow-console.js';
import { setupTheme } from './theme.js';
import { mountQuickSetup } from './quick-setup.js';
import { mountWorkforce } from './workforce.js';

// The pages. view -> the panel it shows. #studio / #monitor / #blueprints / #connect and the two sub-pages (#roadmap under Projects,
// #operator under Runs) open a page; no hash is the overview. #elaron opens the conversation drawer and #create the New project
// dialog (they are things that open over a page, not pages), so old links to them still work.
const PANELS = { overview: 'mc-view-overview', studio: 'mc-view-studio', blueprints: 'mc-view-blueprints', roadmap: 'mc-view-roadmap', operator: 'mc-view-operator', monitor: 'mc-view-monitor', connect: 'mc-view-connect' };
// view -> the rail button that shows as current for it. A sub-page lives under its parent's button.
const RAIL = { overview: 'mc-nav-overview', studio: 'mc-nav-studio', blueprints: 'mc-nav-blueprints', roadmap: 'mc-nav-blueprints', operator: 'mc-nav-monitor', monitor: 'mc-nav-monitor', connect: 'mc-nav-connect' };
// rail button -> the page it opens.
const RAIL_OPENS = { 'mc-nav-overview': 'overview', 'mc-nav-studio': 'studio', 'mc-nav-blueprints': 'blueprints', 'mc-nav-monitor': 'monitor', 'mc-nav-connect': 'connect' };
const VIEW_TITLES = { overview: 'Mission Control', studio: 'Studio', blueprints: 'Projects', roadmap: 'Roadmap', operator: 'Operator Console', monitor: 'Run history', connect: 'Settings' };

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
  let railTrap = null;
  // On a phone the closed drawer is off-screen: it must not be reachable by Tab (or a screen reader) while it is.
  function syncInert() {
    if (phone.matches && !isOpen()) rail.setAttribute('inert', '');
    else rail.removeAttribute('inert');
  }
  function apply() {
    if (phone.matches) {
      body.dataset.rail = 'full';
      toggle.setAttribute('aria-expanded', String(isOpen()));
      syncInert();
      return;
    }
    body.classList.remove('rail-open');
    if (scrim) scrim.hidden = true;
    const mode = preference === 'icons' || preference === 'full' ? preference : medium.matches ? 'icons' : 'full';
    body.dataset.rail = mode;
    toggle.setAttribute('aria-expanded', String(mode === 'full'));
    syncInert();
  }
  function open() {
    body.classList.add('rail-open');
    syncInert();
    if (scrim) scrim.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    const first = rail.querySelector('.rail-item');
    if (first) first.focus();
    // The drawer covers the page behind a scrim: Tab stays inside it until it closes.
    railTrap = trapFocus(rail, { returnTo: toggle });
  }
  function close(focusToggle = true) {
    if (!isOpen()) return;
    body.classList.remove('rail-open');
    if (scrim) scrim.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (railTrap) {
      railTrap.release({ restore: false });
      railTrap = null;
    }
    syncInert();
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
export const SPACE_HANDOFF_KEY = 'aether.pendingAsk';
const SPACE_HANDOFF_MAX_AGE_MS = 120000;
// The message Space's composer left for Elarion, or null. Read once: it is removed whether or not it is used.
export function takeSpaceHandoff(win, now = Date.now()) {
  try {
    const raw = win.sessionStorage.getItem(SPACE_HANDOFF_KEY);
    win.sessionStorage.removeItem(SPACE_HANDOFF_KEY);
    const note = raw ? JSON.parse(raw) : null;
    if (note && typeof note.text === 'string' && note.text.trim() && now - Number(note.at) >= 0 && now - Number(note.at) < SPACE_HANDOFF_MAX_AGE_MS) return note.text.trim().slice(0, 4000);
  } catch { /* no storage, nothing handed over */ }
  return null;
}
// Other spellings of a route that open the same thing (#elarion is the conversation drawer, like #elaron).
const VIEW_ALIASES = { elarion: 'elaron', conversation: 'elaron', chat: 'elaron' };
const composerHiddenFor = () => false; // the composer is docked on every page

// Pages: each rail button opens its page and is marked aria-current="page" while it (or a sub-page under it) is open. The small
// [data-goto-view] switches inside a page (Projects | Roadmap, Run history | Operator console) move between a page and its
// sub-page. redirects: { view: () => ... } are views that open something over the page instead of showing a panel (the Elarion
// drawer, the New project dialog); selecting one runs it and leaves the page as it was.
export function setupTabs(doc, onSelect = () => {}, { redirects = {} } = {}) {
  const win = doc.defaultView;
  const title = doc.getElementById('mc-title');
  const announce = doc.getElementById('mc-route');
  const baseTitle = doc.title;
  let current = 'overview';
  let started = false;

  const railButtons = Object.keys(RAIL_OPENS).map((id) => doc.getElementById(id)).filter(Boolean);

  function select(view, focus = false) {
    view = VIEW_ALIASES[view] || view;
    if (view in redirects) {
      redirects[view]();
      return;
    }
    if (!(view in PANELS)) view = 'overview';
    current = view;
    for (const [name, panelId] of Object.entries(PANELS)) {
      const panel = doc.getElementById(panelId);
      if (panel) panel.hidden = name !== view;
    }
    const railId = RAIL[view];
    for (const button of railButtons) {
      if (button.id === railId) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const sw of doc.querySelectorAll('[data-goto-view]')) {
      if (sw.dataset.gotoView === view) sw.setAttribute('aria-current', 'page');
      else sw.removeAttribute('aria-current');
    }
    if (focus) {
      const rail = doc.getElementById(railId);
      const target = rail && !rail.closest('[inert]') ? rail : title;
      if (target) {
        if (target === title) title.setAttribute('tabindex', '-1');
        target.focus();
      }
    }
    // The page name is the H1, the tab title follows it, and a screen reader hears the change (not on first load).
    // The title is the menu button, so only its text changes, never the button.
    const titleText = doc.getElementById('mc-title-text') || title;
    if (titleText) titleText.textContent = VIEW_TITLES[view];
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

  for (const button of railButtons) button.addEventListener('click', () => select(RAIL_OPENS[button.id]));
  doc.addEventListener('click', (event) => {
    const sw = event.target && event.target.closest ? event.target.closest('[data-goto-view]') : null;
    if (sw) select(sw.dataset.gotoView, false);
  });
  const hash = win && win.location ? win.location.hash.slice(1) : '';
  // Showing the first page rewrites the address, so the link the page was opened with is kept for openFromHash.
  let openedWith = hash;
  select(hash in PANELS ? hash : 'overview');
  // A link to #elarion, #create or a page while Mission Control is already open follows the link instead of doing nothing.
  const onHashChange = () => {
    const wanted = VIEW_ALIASES[win.location.hash.slice(1)] || win.location.hash.slice(1);
    if (wanted in redirects) {
      win.history.replaceState(null, '', win.location.pathname + win.location.search);
      redirects[wanted]();
    } else if (wanted in PANELS && wanted !== current) select(wanted);
  };
  if (win && win.addEventListener) win.addEventListener('hashchange', onHashChange);

  return {
    select,
    getView: () => current,
    // An old link to #elaron or #create opens that over the overview, once everything it needs has been mounted.
    openFromHash() {
      const raw = openedWith || (win && win.location ? win.location.hash.slice(1) : '');
      openedWith = '';
      const wanted = VIEW_ALIASES[raw] || raw;
      if (wanted in redirects) {
        if (win.history) win.history.replaceState(null, '', win.location.pathname + win.location.search);
        redirects[wanted]();
      }
    },
    destroy() {
      if (win && win.removeEventListener) win.removeEventListener('hashchange', onHashChange);
    },
  };
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

// /mission-control?project=1: "Make it a project" on a portal card left a project payload in storage; load it. It opens the New
// project review for those cards (the plan, the estimate, the readiness checks), not a raw editor.
function importProject(doc, blueprints, tabs, storage, newProject) {
  const win = doc.defaultView;
  const params = new URLSearchParams((win && win.location && win.location.search) || '');
  if (!params.get('project')) return null;
  params.delete('project');
  if (win.history) win.history.replaceState(null, '', win.location.pathname + (params.toString() ? '?' + params : '') + '#blueprints');
  tabs.select('blueprints');
  const payload = storage ? takeProjectPayload(storage) : null;
  if (!payload) {
    blueprints.elements.feedback.textContent = 'The project from Space had expired or was missing. Use Make it a project on the card again.';
    return null;
  }
  return newProject.openWithSpec(payload.spec, { sourceIds: payload.sourceIds });
}

// /mission-control?share_url=&share_title=&share_text= (the /share route redirects here): what was shared, or null. The parameters are
// removed from the address so a reload does not open the dialog again.
export function takeShareParams(win) {
  try {
    const params = new URLSearchParams((win.location && win.location.search) || '');
    const url = (params.get('share_url') || '').trim();
    const title = (params.get('share_title') || '').trim();
    const text = (params.get('share_text') || '').trim();
    if (!url && !text) return null;
    for (const key of ['share_url', 'share_title', 'share_text']) params.delete(key);
    if (win.history) win.history.replaceState(null, '', win.location.pathname + (params.toString() ? '?' + params : '') + win.location.hash);
    return { url, title, text };
  } catch {
    return null;
  }
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
  // The engine's key state (from Quick Setup) and the banner that reacts to it; both arrive after the views are mounted.
  let setupSummary;
  let decisions = null;
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
  // Where blueprints are reported to the portal's retrieval index (records-write.js): the page's own fetch unless one is injected.
  const recordsFetch = options.portalFetch || ((url, init) => (doc.defaultView || globalThis).fetch(url, init));
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
    portalFetch: recordsFetch,
    tier: options.tier || meta(doc, 'aether-tier') || 'free',
    upgradeUrl: options.upgradeUrl ?? meta(doc, 'aether-upgrade-url'),
    // A deploy runs as a task loop: show it in the monitor once the engine has registered it, and again when done.
    onOpenStudio: (workflowId) => openMapInStudio(workflowId),
    onNewProject: () => newProject.open(),
    onSelectionChange: () => refreshScopes(),
    onStarted: () => setTimeout(() => monitor.refresh(), 300),
    onExecuted: () => monitor.refresh(),
    onCompleted: (bp, outcome) => { if (outcomes) outcomes.recordRun(bp, outcome); },
  });
  const outcomes = byId('mc-outcomes') ? mountOutcomesList(byId('mc-outcomes'), { api, portalFetch: options.portalFetch, storage: options.storage }) : null;
  // The conversation is saved to the portal as it happens (conversation-store.js) so it survives a reload and can be searched.
  const dock = mountBrainDock(byId('mc-elaron'), { api, history: createConversationStore(recordsFetch), ...options.dock });
  // The conversation is a tray that slides up from the composer over any page. Sending from the composer opens it; the composer stays the
  // place you type, so Elarion's answer appears right there and you never leave the page.
  let drawerClosing = false;
  const drawer = setupElarionDrawer(doc, {
    onClosing: () => { drawerClosing = true; },
    onClose: () => { drawerClosing = false; },
    focusTarget: () => byId('mc-command-input'),
    onOpen: () => {
      refreshScopes();
      // The tray sits just above the composer, whatever height that is on this screen.
      const composer = byId('mc-command');
      const tray = byId('mc-drawer');
      if (composer && tray) tray.style.setProperty('--mc-composer-h', composer.offsetHeight + 'px');
    },
  });
  // "Asking about": the page being looked at and the project open in it, as chips in the conversation.
  function refreshScopes() {
    if (!dock || !dock.setScopes) return;
    const view = tabs ? tabs.getView() : 'overview';
    const list = [{ id: 'page', label: VIEW_TITLES[view] || 'This page', context: { page: VIEW_TITLES[view] || view } }];
    // Studio: Elarion is told about the workflow on the canvas as it is when you send (its nodes, wiring, selection and last run).
    if (view === 'studio' && workflowConsole) {
      const workflow = workflowConsole.getState().workflow;
      list.splice(0, list.length, { id: 'studio', label: workflow && workflow.title ? 'Studio: ' + workflow.title : 'Studio workflow', context: () => studioContext(workflowConsole.getState()) });
    }
    const open = blueprints && blueprints.getSelected ? blueprints.getSelected() : null;
    if (open && open.project_name && (view === 'blueprints' || view === 'roadmap')) {
      list.unshift({ id: 'project', label: projectTitle(open), thread: 'project:' + open.blueprint_id, project_id: open.blueprint_id, context: () => projectContext(blueprints.getSelected() || open, VIEW_TITLES[view]) });
    }
    dock.setScopes(list, list[0].id);
  }
  // The New project dialog: templates, Space cards, a goal or links, then one review before anything runs.
  const newProject = mountNewProject(doc, {
    api,
    pro: blueprints.isPro,
    portalFetch: options.portalFetch,
    storage: options.storage,
    onCompiled: async (blueprintId, blueprint, meta) => {
      saveBlueprintRecord(recordsFetch, blueprintId, blueprint, { tags: meta && meta.tags });
      await blueprints.refresh();
      await blueprints.select(blueprintId, blueprint);
    },
    onRun: (blueprint, { website }) => blueprints.runBlueprint(blueprint, { website }),
    onStarted: (blueprintId) => {
      tabs.select('blueprints');
      blueprints.select(blueprintId);
    },
    onUpgrade: () => blueprints.showUpgrade(),
    onOpenStudio: (workflowId) => openMapInStudio(workflowId),
  });
  const newButton = byId('mc-nav-new');
  if (newButton) newButton.addEventListener('click', () => newProject.open());
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
    onSummary: (summary) => {
      setupSummary = summary || undefined;
      if (decisions) decisions.refreshBanner();
    },
    onOpenSettings: () => tabs && tabs.select('connect'),
    ...options.quickSetup,
  });
  const agentBadge = byId('mc-agent-count');
  workforce = mountWorkforce(byId('mc-workforce'), {
    api,
    portalFetch: options.portalFetch,
    onConnect: () => tabs.select('connect', true),
    onOpenElarion: () => drawer && drawer.open(),
    onNavigate: (view) => tabs.select(view, true),
    storage: options.storage,
    showNext: false,
    // Sidebar: the agent count. The status pill: the fleet, and compute.
    onAgentsChange: (agents, counts) => {
      stoppable = agents.filter((a) => a.status !== 'tripped' && a.status !== 'paused').map((a) => a.agentId);
      if (statusPill) statusPill.update({ agents: { working: agents.filter((a) => a.status === 'running').length, total: agents.length, stopped: agents.filter((a) => a.status === 'tripped' || a.status === 'paused').length } });
      if (agentBadge) agentBadge.textContent = String(agents.length);
      const tokens = agents.reduce((sum, a) => sum + a.tokens, 0);
      const runs = counts ? counts.running + counts.completed + counts.halted + counts.failed : 0;
      // Compute lives in the status pill's popover: tokens spent, and the share of runs that completed.
      if (statusPill) statusPill.update({ compute: { tokens, completed: counts ? counts.completed : 0, runs } });
    },
  });
  // Studio: the Workflow console and the Engine activity canvas, each polling the engine only while it is on screen.
  const studio = byId('mc-studio') ? mountStudioCanvas(byId('mc-studio'), { api, onConnect: () => tabs.select('connect', true), ...options.studio }) : null;
  const workflowConsole = byId('mc-workflow') ? mountWorkflowConsole(byId('mc-workflow'), { api, onConnect: () => tabs.select('connect', true), ...options.workflow }) : null;
  const studioTabs = setupStudioTabs(doc, () => syncStudio());
  // A project's map: the Studio's Workflow console, on that workflow.
  async function openMapInStudio(workflowId) {
    if (!workflowConsole) return;
    tabs.select('studio');
    if (studioTabs) studioTabs.select('workflow');
    await workflowConsole.refreshList();
    await workflowConsole.open(workflowId);
  }
  let studioShown = false;
  function syncStudio() {
    const shown = studioShown;
    const pane = studioTabs ? studioTabs.getTab() : 'workflow';
    if (workflowConsole) workflowConsole.setActive(shown && pane === 'workflow');
    if (studio) studio.setActive(shown && pane === 'activity');
  }
  tabs = setupTabs(doc, (view) => {
    refreshScopes();
    if (decisions) decisions.setView(view);
    if (view === 'blueprints') blueprints.refresh();
    if (view === 'overview') workforce.refresh();
    if (view === 'roadmap' && roadmap) {
      if (!roadmapStarted) roadmap.start();
      else roadmap.refresh();
      roadmapStarted = true;
    }
    studioShown = view === 'studio';
    syncStudio();
  }, { redirects: { elaron: () => drawer.open(), create: () => newProject.open() } });
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
      drawer.open();
      // Busy or halted: put the text back in the composer so it isn't lost. Focus stays in the composer either way.
      if (!dock.send(text)) composerInput.value = text;
      composerInput.focus({ preventScroll: true });
    },
  }) : null;
  const composerInput = byId('mc-command-input');
  // The tray's size button: taller for a long answer, shorter again to see the page.
  const trayEl = byId('mc-drawer');
  const sizeButton = byId('mc-drawer-size');
  if (trayEl && sizeButton) {
    sizeButton.addEventListener('click', () => {
      const tall = trayEl.dataset.size !== 'tall';
      if (tall) trayEl.dataset.size = 'tall';
      else delete trayEl.dataset.size;
      sizeButton.setAttribute('aria-pressed', String(tall));
    });
  }
  const skillButton = byId('mc-command-skill');
  // The "Do this next" banner (on the overview, and elsewhere only when something urgent blocks the work), and numbered
  // choice popups for decisions, finished runs and skills.
  decisions = options.decisions === false ? null : mountDecisionCenter(doc, {
    api,
    slot: byId('mc-next'),
    storage: options.storage,
    getSetup: () => setupSummary,
    view: tabs.getView(),
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
    importProject(doc, blueprints, tabs, options.storage || (doc.defaultView && doc.defaultView.localStorage), newProject);
  } catch (error) {
    blueprints.elements.feedback.textContent = 'Could not load the project from Space (' + error.message + ').';
  }
  await importOutcome(doc, blueprints, tabs, options.portalFetch || ((url, init) => (doc.defaultView || globalThis).fetch(url, init)));

  tabs.openFromHash();
  // A link shared to the app (the share sheet, /share?url=...): the New project dialog opens with it filled in. Every tab is one tap
  // away, Roadmap Templates included.
  const shared = takeShareParams(doc.defaultView || globalThis);
  if (shared) {
    if (shared.url) newProject.open('links', { links: shared.url, name: shared.title });
    else newProject.open('goal', { goal: shared.text });
  }
  // Space's composer hands a message over (index.js handOffToElarion): open the drawer and send it, once, if it is fresh.
  const handoff = takeSpaceHandoff(doc.defaultView || globalThis);
  if (handoff && drawer) {
    drawer.open();
    if (!dock.send(handoff)) dock.elements.input.value = handoff;
  }

  if (skillButton && decisions) skillButton.addEventListener('click', () => decisions.askSource());
  // Agent spec (the rail): define an agent's role and what it may do. It writes a spec and starts nothing: agents run when a
  // project that uses them is deployed.
  const agentSpecButton = byId('mc-agent-spec');
  if (agentSpecButton && decisions) agentSpecButton.addEventListener('click', () => decisions.askAgentSpec());
  // Realtime (off unless the page asks for it): an engine event wakes the same refreshers the poll timers use, which stay as the fallback.
  const realtimeRefresh = mountRealtimeRefresh(doc.defaultView || globalThis, {
    connection: () => connection.refresh(),
    breaker: () => breaker.refresh(),
    workforce: () => workforce && workforce.refresh(),
    monitor: () => monitor.refresh(),
    banner: () => decisions && decisions.refreshBanner(),
  });
  // Spoken and screen-reader alerts when an agent needs the operator, and slower timers while the stream covers the engine.
  const realtimeAlerts = mountRealtimeAlerts(doc.defaultView || globalThis);
  const pollRate = mountPollRate(doc.defaultView || globalThis, { onUncovered: () => realtimeRefresh.refreshAll() });
  return { realtimeRefresh, realtimeAlerts, pollRate, drawer, newProject, connection, breaker, monitor, outcomes, operator, dialogue, dual, roadmap, decisions, operatorTabs, tray, commandBar, blueprints, dock, wizard, quickSetup, workforce, studio, workflowConsole, studioTabs, tabs, theme };
}

if (typeof document !== 'undefined' && document.getElementById('mc-breaker')) mountMissionControl();
