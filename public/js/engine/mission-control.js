// Mission Control entry (/mission-control, src/mission-control-page.js). Gets an engine token first (connection.js),
// so the breaker, task monitor, blueprint dashboard and Elarion dock all start out authenticated, then mounts them.
import { getEngineApi } from '../engine-api.bundle.js';
import { mountBlueprintWorkspace } from './blueprints.js';
import { mountBreakerBar } from './breaker-bar.js';
import { ENGINE_PARAM, mountConnectionWizard } from './connection-wizard.js';
import { mountBrainDock } from './brain-dock.js';
import { mountConnection } from './connection.js';
import { mountTaskMonitor } from './task-monitor.js';

// view -> tab id. The Elarion tab only exists on narrow screens; on wide ones the dock is always on the right.
const VIEWS = { monitor: 'mc-tab-monitor', blueprints: 'mc-tab-blueprints', elaron: 'mc-tab-elaron', connect: 'mc-tab-connect' };
export const NARROW_QUERY = '(max-width: 900px)';

// Workspace tabs (WAI-ARIA tabs pattern): click or arrow keys switch; #blueprints / #elaron / #connect open a tab.
export function setupTabs(doc, onSelect = () => {}) {
  const win = doc.defaultView;
  const narrowQuery = win && win.matchMedia ? win.matchMedia(NARROW_QUERY) : null;
  const isNarrow = () => Boolean(narrowQuery && narrowQuery.matches);
  const all = Object.entries(VIEWS).map(([view, id]) => ({ view, tab: doc.getElementById(id) })).filter((t) => t.tab);
  const visible = () => all.filter((t) => t.view !== 'elaron' || isNarrow());
  let current = 'monitor';

  function select(view, focus = false) {
    if (view === 'elaron' && !isNarrow()) view = 'monitor';
    current = view;
    for (const t of all) {
      const active = t.view === view;
      t.tab.setAttribute('aria-selected', String(active));
      t.tab.tabIndex = active ? 0 : -1;
      const panel = doc.getElementById(t.tab.getAttribute('aria-controls'));
      // The dock is only ever hidden on narrow screens, where it is one of the tabs.
      panel.hidden = t.view === 'elaron' ? isNarrow() && !active : !active;
      if (active && focus) t.tab.focus();
    }
    doc.body.dataset.view = view;
    if (win && win.history && win.location) {
      const hash = view === 'monitor' ? '' : '#' + view;
      if (win.location.hash !== hash) win.history.replaceState(null, '', win.location.pathname + win.location.search + hash);
    }
    onSelect(view);
  }

  all.forEach((t) => {
    t.tab.addEventListener('click', () => select(t.view));
    t.tab.addEventListener('keydown', (event) => {
      const tabs = visible();
      const i = tabs.findIndex((x) => x.view === t.view);
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (event.key === 'Home') return select(tabs[0].view, true);
      if (event.key === 'End') return select(tabs[tabs.length - 1].view, true);
      if (!step) return;
      event.preventDefault();
      select(tabs[(i + step + tabs.length) % tabs.length].view, true);
    });
  });
  const onResize = () => select(current);
  if (narrowQuery && narrowQuery.addEventListener) narrowQuery.addEventListener('change', onResize);

  const hash = win && win.location ? win.location.hash.slice(1) : '';
  select(hash in VIEWS ? hash : 'monitor');
  return {
    select,
    getView: () => current,
    destroy() {
      if (narrowQuery && narrowQuery.removeEventListener) narrowQuery.removeEventListener('change', onResize);
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

  let tabs = null;
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
  tabs = setupTabs(doc, (view) => {
    if (view === 'blueprints') blueprints.refresh();
  });
  offerPairingFromLink(doc, wizard, tabs);
  await importOutcome(doc, blueprints, tabs, options.portalFetch || ((url, init) => (doc.defaultView || globalThis).fetch(url, init)));

  return { connection, breaker, monitor, blueprints, dock, wizard, tabs };
}

if (typeof document !== 'undefined' && document.getElementById('mc-breaker')) mountMissionControl();
