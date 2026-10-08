// Starts the realtime client on pages that ask for it, and turns its callbacks into window events the page scripts listen
// to (Space's inline script cannot import modules; Mission Control's can, but shares this). The Worker switches it on with
//   <meta name="aether-realtime" content="1">              (REALTIME=on in the Worker environment)
//   <meta name="aether-realtime-topics" content="graph">   (comma separated; "engine" on Mission Control)
// and the page may set window.AetherLiveClientId, the id it already sends as X-Aether-Client with its writes, so the
// hub's `origin` on an event can be matched to this tab and skipped.
//
// Window events: aether-realtime-event (detail: the envelope), aether-realtime-gap, aether-realtime-ready,
// aether-realtime-fallback. window.AetherRealtime is the client (state, lastSeq, on, stop) for debugging.

import { createRealtimeClient, realtimeUrl } from './realtime-client.js';

const meta = (doc, name) => {
	const element = doc.querySelector('meta[name="' + name + '"]');
	return element ? element.getAttribute('content') || '' : '';
};

const newId = (win) => (win.crypto && win.crypto.randomUUID ? win.crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2));

// Returns the client, or null when realtime is off or unsupported here.
export function bootRealtime(win = window, doc = win.document, overrides = {}) {
	if (meta(doc, 'aether-realtime') !== '1' || typeof (overrides.WebSocketImpl || win.WebSocket) !== 'function') return null;
	const topics = meta(doc, 'aether-realtime-topics').split(',').map((topic) => topic.trim()).filter(Boolean);
	const client = createRealtimeClient({
		url: realtimeUrl(win.location),
		topics: topics.length ? topics : ['graph'],
		origin: win.AetherLiveClientId || newId(win),
		doc,
		win,
		WebSocketImpl: win.WebSocket,
		...overrides,
	});
	const tell = (name, detail) => win.dispatchEvent(new win.CustomEvent('aether-realtime-' + name, { detail }));
	client.on('*', (event) => tell('event', event));
	client.on('gap', (detail) => tell('gap', detail));
	client.on('ready', (detail) => tell('ready', detail));
	client.on('fallback', (detail) => tell('fallback', detail));
	win.AetherRealtime = client;
	client.start();
	return client;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__aetherRealtimeNoBoot) bootRealtime();
