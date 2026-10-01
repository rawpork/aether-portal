// Mission Control entry (/mission-control, src/mission-control-page.js). Gets an engine token first (connection.js),
// so the breaker, task monitor, blueprint dashboard and Elaron dock all start out authenticated, then mounts them.
import { getEngineApi } from '../engine-api.bundle.js';
import { mountBlueprintWorkspace } from './blueprints.js';
import { mountBreakerBar } from './breaker-bar.js';
import { mountBrainDock } from './brain-dock.js';
import { mountConnection } from './connection.js';
import { mountTaskMonitor } from './task-monitor.js';

const VIEWS = { monitor: 'mc-tab-monitor', blueprints: 'mc-tab-blueprints' };

// Workspace tabs (WAI-ARIA tabs pattern): click or arrow keys switch; #blueprints in the URL opens that tab.
export function setupTabs(doc, onSelect = () => {}) {
  const tabs = Object.entries(VIEWS).map(([view, id]) => ({ view, tab: doc.getElementById(id) })).filter((t) => t.tab);

  function select(view, focus = false) {
    for (const t of tabs) {
      const active = t.view === view;
      t.tab.setAttribute('aria-selected', String(active));
      t.tab.tabIndex = active ? 0 : -1;
      doc.getElementById(t.tab.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) t.tab.focus();
    }
    const win = doc.defaultView;
    if (win && win.history && win.location) {
      const hash = view === 'monitor' ? '' : '#' + view;
      if (win.location.hash !== hash) win.history.replaceState(null, '', win.location.pathname + win.location.search + hash);
    }
    onSelect(view);
  }

  tabs.forEach((t, i) => {
    t.tab.addEventListener('click', () => select(t.view));
    t.tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (event.key === 'Home') return select(tabs[0].view, true);
      if (event.key === 'End') return select(tabs[tabs.length - 1].view, true);
      if (!step) return;
      event.preventDefault();
      select(tabs[(i + step + tabs.length) % tabs.length].view, true);
    });
  });

  const initial = doc.defaultView && doc.defaultView.location && doc.defaultView.location.hash === '#blueprints' ? 'blueprints' : 'monitor';
  select(initial);
  return { select };
}

const meta = (doc, name) => {
  const tag = doc.querySelector('meta[name="' + name + '"]');
  return tag ? tag.getAttribute('content') || '' : '';
};

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
  tabs = setupTabs(doc, (view) => {
    if (view === 'blueprints') blueprints.refresh();
  });
  const dock = mountBrainDock(byId('mc-elaron'), { api, ...options.dock });

  return { connection, breaker, monitor, blueprints, dock, tabs };
}

if (typeof document !== 'undefined' && document.getElementById('mc-breaker')) mountMissionControl();
