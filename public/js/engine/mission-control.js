// Mission Control entry (/mission-control, src/mission-control-page.js). Gets an engine token first (connection.js),
// so the breaker, task monitor and Elaron dock all start out authenticated, then mounts them into the workspace.
import { getEngineApi } from '../engine-api.bundle.js';
import { mountBreakerBar } from './breaker-bar.js';
import { mountBrainDock } from './brain-dock.js';
import { mountConnection } from './connection.js';
import { mountTaskMonitor } from './task-monitor.js';

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
  const monitor = mountTaskMonitor(byId('mc-monitor'), { api, statusEl: byId('mc-monitor-status') });
  const dock = mountBrainDock(byId('mc-elaron'), { api, ...options.dock });

  return { connection, breaker, monitor, dock };
}

if (typeof document !== 'undefined' && document.getElementById('mc-breaker')) mountMissionControl();
