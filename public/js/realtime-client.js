// The browser side of realtime (Phase 10, R3): one WebSocket to /api/realtime that keeps a tab in step with its hub.
// It speaks the protocol in realtime-protocol.js and nothing else: hello (with the last seq seen), then the events it
// missed, then ready; ack as it goes; ping to keep the socket honest. It never writes data (all writes stay on REST).
//
// What a page gets:
//   client.on('node.updated', fn)   one event type (the envelope is passed)
//   client.on('topic:graph', fn)    every event of a topic
//   client.on('*', fn)              every event
//   client.on('gap', fn)            events were missed beyond the hub's memory: refetch everything (see below)
//   client.on('ready' | 'state' | 'fallback' | 'close', fn)
// Events whose `origin` is this tab's own id are not dispatched (the tab already applied its own change), though their
// seq still counts. After a gap the client says hello again from the gap's seq by itself, so a page only has to refetch.
// After `maxFailures` connection attempts in a row that never reached ready it gives up ('fallback'): the page keeps
// whatever it did before realtime (SSE, polling). No dependencies beyond the protocol; every global is injectable for tests.

import {
	ackMessage,
	backoffDelay,
	helloMessage,
	parseFrame,
	pingMessage,
	validateServerMessage,
} from './realtime-protocol.js';

export const KEEPALIVE_MS = 30000;
// Pongs come every KEEPALIVE_MS; silence for this long means the socket is dead even if the browser has not noticed.
export const DEAD_AFTER_MS = 75000;
export const HIDDEN_CLOSE_MS = 60000;
export const MAX_FAILURES = 6;
export const ACK_DELAY_MS = 1000;
// A session this long counts as stable: the next drop retries quickly instead of continuing the backoff.
export const STABLE_AFTER_MS = 10000;

// ws:// or wss:// for the page's own origin.
export function realtimeUrl(location, path = '/api/realtime') {
	return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
}

export function createRealtimeClient(options = {}) {
	const {
		url,
		topics = ['graph'],
		origin = null,
		lastSeq: startSeq = 0,
		WebSocketImpl = globalThis.WebSocket,
		setTimer = (fn, ms) => setTimeout(fn, ms),
		clearTimer = (id) => clearTimeout(id),
		random = Math.random,
		now = () => Date.now(),
		doc = globalThis.document,
		win = globalThis.window,
		hiddenCloseMs = HIDDEN_CLOSE_MS,
		maxFailures = MAX_FAILURES,
		ackDelayMs = ACK_DELAY_MS,
	} = options;

	const handlers = new Map();
	let socket = null;
	let state = 'idle'; // idle | connecting | syncing | live | waiting | sleeping | fallback | stopped
	let lastSeq = startSeq;
	let attempt = 0;
	let failures = 0;
	let reconnectTimer = null;
	let keepaliveTimer = null;
	let ackTimer = null;
	let hiddenTimer = null;
	let lastHeard = 0;
	let liveSince = 0;
	let started = false;

	function on(name, fn) {
		if (!handlers.has(name)) handlers.set(name, new Set());
		handlers.get(name).add(fn);
		return () => handlers.get(name).delete(fn);
	}

	function emit(name, detail) {
		const set = handlers.get(name);
		if (!set) return;
		for (const fn of [...set]) {
			try {
				fn(detail);
			} catch (error) {
				if (globalThis.console) console.warn('Realtime handler failed:', error);
			}
		}
	}

	function setState(next) {
		if (state === next) return;
		state = next;
		emit('state', next);
	}

	function dispatch(event) {
		emit(event.type, event);
		emit('topic:' + event.topic, event);
		emit('*', event);
	}

	// ---- Connection ------------------------------------------------------------------------------------------------

	function connect() {
		if (socket || !started || state === 'fallback') return;
		clearTimer(reconnectTimer);
		reconnectTimer = null;
		setState('connecting');
		let mine;
		try {
			mine = new WebSocketImpl(url);
		} catch {
			failed(false);
			return;
		}
		socket = mine;
		mine.onopen = () => {
			if (socket !== mine) return;
			lastHeard = now();
			setState('syncing');
			send(helloMessage(lastSeq, topics));
			keepaliveTimer = setTimer(keepalive, KEEPALIVE_MS);
		};
		mine.onmessage = (event) => {
			if (socket === mine) handle(event.data);
		};
		mine.onerror = () => {
			// The close event follows and does the work.
		};
		mine.onclose = (event) => {
			if (socket === mine) closed(event && event.code);
		};
	}

	function send(message) {
		if (!socket || socket.readyState !== 1) return;
		try {
			socket.send(JSON.stringify(message));
		} catch {
			// The close handler will follow.
		}
	}

	function closed(code) {
		const reachedReady = state === 'live';
		// Backoff starts over only after a connection that held; one that drops at once keeps climbing.
		if (reachedReady && now() - liveSince >= STABLE_AFTER_MS) attempt = 0;
		socket = null;
		clearTimer(keepaliveTimer);
		clearTimer(ackTimer);
		keepaliveTimer = ackTimer = null;
		emit('close', { code: code || 0 });
		if (state === 'stopped') return;
		if (state === 'sleeping') return;
		failed(reachedReady);
	}

	// A connection ended or never opened. After a good session the first retry is quick; consecutive failures back off.
	function failed(wasLive) {
		failures = wasLive ? 0 : failures + 1;
		if (failures >= maxFailures) {
			setState('fallback');
			emit('fallback', { failures });
			return;
		}
		setState('waiting');
		const delay = backoffDelay(attempt++, random);
		reconnectTimer = setTimer(connect, delay);
		emit('reconnecting', { attempt, delay });
	}

	function keepalive() {
		keepaliveTimer = null;
		if (!socket) return;
		if (now() - lastHeard > DEAD_AFTER_MS) {
			// Nothing for over two pings: the browser has not noticed, so drop the socket ourselves.
			try {
				socket.close();
			} catch {
				// Already gone.
			}
			closed(1006);
			return;
		}
		send(pingMessage());
		keepaliveTimer = setTimer(keepalive, KEEPALIVE_MS);
	}

	// ---- Messages --------------------------------------------------------------------------------------------------

	function handle(data) {
		lastHeard = now();
		const frame = parseFrame(data);
		if (!frame.ok) return;
		const message = validateServerMessage(frame.value);
		if (!message.ok) return;
		const { kind, message: body } = message.value;
		if (kind === 'event') return onEvent(body);
		if (kind === 'ready') return onReady(body);
		if (kind === 'gap') return onGap(body);
	}

	function onEvent(event) {
		// A replay after a reconnect can repeat what already arrived; a seq is applied once.
		if (event.seq <= lastSeq) return;
		lastSeq = event.seq;
		scheduleAck();
		if (origin && event.origin === origin) return;
		dispatch(event);
	}

	function onReady(message) {
		lastSeq = Math.max(lastSeq, message.seq);
		liveSince = now();
		failures = 0;
		setState('live');
		emit('ready', { seq: lastSeq });
	}

	// The hub no longer holds what this tab missed. The page refetches; meanwhile the client resumes from the gap's seq so
	// every later event arrives, and the hub's ready confirms it.
	function onGap(message) {
		lastSeq = message.seq;
		setState('syncing');
		emit('gap', { seq: message.seq });
		send(helloMessage(lastSeq, topics));
	}

	function scheduleAck() {
		if (ackTimer) return;
		ackTimer = setTimer(() => {
			ackTimer = null;
			send(ackMessage(lastSeq));
		}, ackDelayMs);
	}

	// ---- Page visibility and network -------------------------------------------------------------------------------

	function onVisibility() {
		if (!doc) return;
		if (doc.visibilityState === 'hidden') {
			clearTimer(hiddenTimer);
			hiddenTimer = setTimer(sleep, hiddenCloseMs);
			return;
		}
		clearTimer(hiddenTimer);
		hiddenTimer = null;
		wake();
	}

	// A long hidden period closes the socket (a phone should not hold one open); showing the page resumes from lastSeq.
	function sleep() {
		hiddenTimer = null;
		if (!socket || state === 'stopped') return;
		const mine = socket;
		setState('sleeping');
		socket = null;
		clearTimer(keepaliveTimer);
		clearTimer(ackTimer);
		keepaliveTimer = ackTimer = null;
		try {
			mine.close(1000, 'hidden');
		} catch {
			// Already gone.
		}
		emit('close', { code: 1000 });
	}

	// Reconnect now, not after the pending backoff: the user is looking, or the network came back.
	function wake() {
		if (!started || state === 'stopped' || state === 'fallback') return;
		if (state === 'sleeping' || state === 'waiting') {
			clearTimer(reconnectTimer);
			reconnectTimer = null;
			attempt = 0;
			connect();
		}
	}

	// ---- Lifecycle -------------------------------------------------------------------------------------------------

	function start() {
		if (started && state !== 'stopped') return api;
		started = true;
		failures = 0;
		attempt = 0;
		state = 'idle';
		if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
		if (win && win.addEventListener) win.addEventListener('online', wake);
		if (doc && doc.visibilityState === 'hidden') {
			// Opened in the background: connect when it is first shown.
			setState('sleeping');
		} else connect();
		return api;
	}

	function stop() {
		if (!started) return;
		started = false;
		const mine = socket;
		socket = null;
		clearTimer(reconnectTimer);
		clearTimer(keepaliveTimer);
		clearTimer(ackTimer);
		clearTimer(hiddenTimer);
		reconnectTimer = keepaliveTimer = ackTimer = hiddenTimer = null;
		if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
		if (win && win.removeEventListener) win.removeEventListener('online', wake);
		setState('stopped');
		if (mine) {
			try {
				mine.close(1000, 'stopped');
			} catch {
				// Already gone.
			}
		}
	}

	const api = {
		start,
		stop,
		on,
		get state() {
			return state;
		},
		get lastSeq() {
			return lastSeq;
		},
	};
	return api;
}
