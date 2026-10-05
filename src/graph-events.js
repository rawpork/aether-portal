// Live sync (GET /api/events): every open portal tab of a user listens on a Server-Sent Events stream, and each graph
// write the Worker serves (node, link and group changes, Telegram saves) is pushed to the user's other tabs, which
// reload the graph in place. One GraphEvents Durable Object per user holds that user's open streams; the Worker
// publishes to it after a write succeeds. Tabs close their stream while hidden, so the object is not kept running.

const encoder = new TextEncoder();
// A comment line this often keeps proxies from closing an idle stream.
export const SSE_HEARTBEAT_MS = 25000;
// How long EventSource waits before reconnecting a dropped stream.
export const SSE_RETRY_MS = 5000;
export const GRAPH_EVENT_TYPES = [
  "node.created", "node.updated", "node.deleted",
  "link.created", "link.updated", "link.deleted",
  "group.updated", "settings.updated", "graph.changed"
];

// One SSE message: the event type as its name, the whole event as JSON data.
export function formatSseEvent(event) {
  return "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}

// The event a successful write announces, from its method and path, or null for requests that change nothing the
// graph shows. { type, id? }.
export function graphEventFor(method, pathname) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const nodeItem = /^\/api\/node\/([^/]+)$/.exec(pathname);
  if (nodeItem) {
    let id = "";
    try {
      id = decodeURIComponent(nodeItem[1]);
    } catch {
      id = "";
    }
    if (method === "PATCH") return { type: "node.updated", id };
    if (method === "DELETE") return { type: "node.deleted", id };
    return null;
  }
  if (pathname === "/api/node" && method === "POST") return { type: "node.created" };
  if (pathname === "/api/share" && method === "POST") return { type: "node.created" };
  if (pathname === "/api/outcomes" && method === "POST") return { type: "node.created" };
  if (pathname === "/api/link") {
    const type = { POST: "link.created", PATCH: "link.updated", DELETE: "link.deleted" }[method];
    return type ? { type } : null;
  }
  if (pathname === "/api/groups" || pathname.startsWith("/api/groups/")) return { type: "group.updated" };
  if (pathname === "/api/settings") return { type: "settings.updated" };
  // Saves that land on an existing node: research answers, transcripts, fetched web content, Outcome changes.
  if (["/api/ask", "/api/transcript", "/api/web-fetch"].includes(pathname) || pathname.startsWith("/api/outcome/")) {
    return { type: "node.updated" };
  }
  return null;
}

// Pushes an event to the user's open tabs. origin: the tab that made the change (it skips its own events).
export async function publishGraphEvent(env, userId, event, origin = null) {
  if (!env.GRAPH_EVENTS || !userId) return;
  const stub = env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName(String(userId)));
  const payload = { ...event, origin: origin ? String(origin).slice(0, 64) : null, at: new Date().toISOString() };
  await stub.fetch("https://graph-events/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// The user's stream, as the Durable Object serves it.
export function subscribeGraphEvents(env, userId) {
  const stub = env.GRAPH_EVENTS.get(env.GRAPH_EVENTS.idFromName(String(userId)));
  return stub.fetch("https://graph-events/subscribe");
}

// The Durable Object: one per user, holding that user's open streams in memory (nothing is stored).
export class GraphEvents {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.heartbeat = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") return this.subscribe(request);
    if (url.pathname === "/publish" && request.method === "POST") {
      const event = await request.json().catch(() => null);
      if (!event || !GRAPH_EVENT_TYPES.includes(event.type)) return new Response("Bad event", { status: 400 });
      this.broadcast(formatSseEvent(event));
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }

  subscribe(request) {
    const { readable, writable } = new TransformStream();
    const client = { writer: writable.getWriter() };
    this.clients.add(client);
    this.write(client, "retry: " + SSE_RETRY_MS + "\n: connected\n\n");
    if (request.signal && request.signal.addEventListener) request.signal.addEventListener("abort", () => this.drop(client));
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.broadcast(": ping\n\n"), SSE_HEARTBEAT_MS);
    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }
    });
  }

  // A write to a stream whose tab has gone fails, which drops it.
  write(client, text) {
    client.writer.write(encoder.encode(text)).catch(() => this.drop(client));
  }

  broadcast(text) {
    this.clients.forEach(client => this.write(client, text));
  }

  drop(client) {
    if (!this.clients.delete(client)) return;
    client.writer.close().catch(() => {});
    if (!this.clients.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
