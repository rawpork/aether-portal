// Mission Control keeps polling the engine; realtime only tells it when to look sooner. An engine event maps to the existing
// refreshers (the same ones the poll timers and buttons call), so polling stays as the fallback and nothing here carries
// state of its own. Refreshes are coalesced: a burst of task.step events asks the task monitor to refresh once per gap.

// Which refreshers an engine event wakes. Names match the handlers mission-control.js passes in.
export const REFRESH_TARGETS = {
	'agent.state': ['breaker', 'workforce', 'banner'],
	'task.started': ['monitor', 'workforce'],
	'task.step': ['monitor', 'workforce'],
	'task.finished': ['monitor', 'workforce', 'banner'],
	'task.awaiting': ['monitor', 'banner'],
	'task.choice': ['monitor', 'banner'],
	'engine.hello': ['connection', 'breaker', 'workforce', 'monitor', 'banner'],
	'engine.bye': ['connection', 'breaker'],
};
export const ALL_TARGETS = ['connection', 'breaker', 'workforce', 'monitor', 'banner'];
export const MIN_GAP_MS = 500;

export const refreshTargetsFor = (type) => REFRESH_TARGETS[type] || [];

// schedule(names) runs each named handler at most once per minGapMs: now if it has been quiet, else once when the gap is up.
export function createRefreshCoalescer(handlers, { minGapMs = MIN_GAP_MS, setTimer = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() } = {}) {
	const last = new Map();
	const pending = new Map();
	function run(name) {
		pending.delete(name);
		last.set(name, now());
		try {
			const result = handlers[name] && handlers[name]();
			if (result && typeof result.catch === 'function') result.catch(() => {});
		} catch {
			// A refresher that throws must not stop the others.
		}
	}
	return function schedule(names) {
		for (const name of names) {
			if (!handlers[name] || pending.has(name)) continue;
			const wait = (last.get(name) || -Infinity) + minGapMs - now();
			if (wait <= 0) run(name);
			else pending.set(name, setTimer(() => run(name), wait));
		}
	};
}

// Wires the page events from realtime-boot.js to the refreshers. A gap or a fresh connection refreshes everything once.
export function mountRealtimeRefresh(win, handlers, options = {}) {
	const schedule = createRefreshCoalescer(handlers, options);
	const onEvent = (event) => {
		const detail = event.detail;
		if (detail && detail.topic === 'engine') schedule(refreshTargetsFor(detail.type));
	};
	const onResync = () => schedule(ALL_TARGETS);
	win.addEventListener('aether-realtime-event', onEvent);
	win.addEventListener('aether-realtime-gap', onResync);
	return {
		stop() {
			win.removeEventListener('aether-realtime-event', onEvent);
			win.removeEventListener('aether-realtime-gap', onResync);
		},
	};
}
