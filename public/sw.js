// Minimal service worker: it makes Aether Portal installable (and so a share-sheet target on Android) without
// caching anything. Every request still goes to the network, so the app never serves stale graph data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
