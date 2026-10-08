// Adaptive polling for Mission Control (Phase 10, R5). While the realtime socket is live AND the engine is pushing behind it
// ("covered"), engine events wake the refreshers the moment something changes, so the timers only need to be a safety net:
// they stretch to a slow heartbeat. The moment coverage is lost (socket down, engine offline, realtime off) polling returns to
// its normal rate and everything refreshes once, so a missed event can never leave a view stale for the stretched interval.
//
// Pollers call pollDelay(baseMs) wherever they schedule their next poll; with realtime off it returns baseMs unchanged.

export const HEARTBEAT_FACTOR = 6;
export const HEARTBEAT_MIN_MS = 15000;
export const HEARTBEAT_MAX_MS = 60000;

// The slow interval for a poller whose normal interval is baseMs: 6x, between 15 s and 60 s.
export const heartbeatMs = (baseMs) => Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, baseMs * HEARTBEAT_FACTOR));

let covered = false;
export const isCovered = () => covered;
export const pollDelay = (baseMs) => (covered ? heartbeatMs(baseMs) : baseMs);

// Follows the page's realtime status. onUncovered runs when coverage is lost (refresh everything once, which also reschedules
// every poller at its normal rate). Returns { stop }.
export function mountPollRate(win, { onUncovered = () => {} } = {}) {
	const apply = (status) => {
		const next = Boolean(status && status.live && status.engine);
		const lost = covered && !next;
		covered = next;
		if (lost) onUncovered();
	};
	const onStatus = (event) => apply(event.detail);
	win.addEventListener('aether-realtime-status', onStatus);
	apply(win.AetherRealtimeStatus);
	return {
		stop() {
			win.removeEventListener('aether-realtime-status', onStatus);
			covered = false;
		},
	};
}
