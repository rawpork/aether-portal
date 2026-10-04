// Engine relay: /api/engine/relay/<engine path> forwards a signed-in user's request to the Aether Engine's public
// address (ENGINE_PUBLIC_URL, e.g. a Cloudflare Tunnel in front of localhost:3333), so a phone on the hosted portal
// talks only to the portal's own domain. The Worker can't reach the operator's localhost, so without a public
// address there is nothing to relay to (404, configured: false).
//
// The browser's Authorization header is dropped; the relay attaches an engine token it mints for the portal user
// (ENGINE_JWT_SECRET), so the engine sees the same identity as a direct Mission Control call. Only the engine's JSON
// API (/api/...) and /health are relayed; WebSockets (voice) are not.

import { mintEngineToken } from './engine-token.js';

export const ENGINE_RELAY_PREFIX = '/api/engine/relay';
const FORWARD_HEADERS = ['content-type', 'accept'];
const MAX_BODY_BYTES = 1024 * 1024;

// The configured public engine address, or null. https only, except a loopback address for local testing.
export function enginePublicUrl(env) {
  const raw = String(env?.ENGINE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// The engine path a relay URL asks for, or null when it isn't one the relay forwards.
export function relayTarget(pathname) {
  if (pathname !== ENGINE_RELAY_PREFIX && !pathname.startsWith(ENGINE_RELAY_PREFIX + '/')) return null;
  const path = pathname.slice(ENGINE_RELAY_PREFIX.length) || '/';
  if (path.includes('/../') || path.endsWith('/..') || path.includes('\\')) return null;
  if (path === '/health') return path;
  if (path.startsWith('/api/') && !path.startsWith('/api/voice/')) return path;
  return null;
}

// What an HTML (or plain text) error page from the engine's public address means, as the relay's JSON error body.
export function describeUpstreamPage(status, text) {
  const page = String(text || '');
  const cfCode = /error code:?\s*(\d{3,4})/i.exec(page) || /errorCode:\s*(\d{3,4})/.exec(page);
  const code = cfCode ? Number(cfCode[1]) : null;
  const tunnel = /Cloudflare Tunnel error|trycloudflare/i.test(page) || code === 1033 || status === 530;
  if (tunnel) {
    return {
      error: 'The engine’s tunnel is offline' + (code ? ' (Cloudflare error ' + code + ')' : '') + '. Start the engine and its tunnel on your computer (say “Start Engine”), then try again.',
      tunnel_offline: true,
      upstream_status: status,
      ...(code ? { cloudflare_error: code } : {})
    };
  }
  return { error: 'The engine’s public address answered with an error page (HTTP ' + status + ') instead of the engine.', upstream_status: status };
}

// `user` is the authenticated portal user ({ id }), checked by the caller (session + same-origin writes).
export async function relayToEngine(request, env, url, user, { fetchImpl = fetch, profile = {} } = {}) {
  const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const base = enginePublicUrl(env);
  if (!base) return json({ error: 'The engine relay is not configured: set ENGINE_PUBLIC_URL (an https address that reaches the engine, e.g. a Cloudflare Tunnel) on the Worker.', configured: false }, 404);
  const path = relayTarget(url.pathname);
  if (!path) return json({ error: 'Only the engine API (/api/...) and /health are relayed.' }, 404);
  if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return json({ error: 'WebSockets are not relayed.' }, 400);

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.ENGINE_JWT_SECRET) {
    const { token } = await mintEngineToken(user.id, env.ENGINE_JWT_SECRET, Date.now(), 300, profile);
    headers.set('Authorization', 'Bearer ' + token);
  }
  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json({ error: 'Request body too large for the relay.' }, 413);
  }

  let upstream;
  try {
    upstream = await fetchImpl(base + path + url.search, { method: request.method, headers, body, redirect: 'manual' });
  } catch (err) {
    return json({ error: 'The engine at its public address is unreachable (' + (err && err.message ? err.message : 'network error') + '). Is the engine and its tunnel running?' }, 502);
  }
  const out = new Headers({ 'Cache-Control': 'no-store' });
  const type = upstream.headers.get('content-type');
  // An error page instead of the engine's JSON: Cloudflare answering for a tunnel that is down (error 1033 / 530)
  // or a proxy in between. Say so plainly rather than passing the page's HTML on to Mission Control.
  if (upstream.status >= 400 && !/json/i.test(type || '')) {
    const text = await upstream.text().catch(() => '');
    return json(describeUpstreamPage(upstream.status, text), 502);
  }
  if (type) out.set('Content-Type', type);
  // Redirects would send the browser to the engine's own address; report them instead of following.
  if (upstream.status >= 300 && upstream.status < 400) return json({ error: 'The engine answered with a redirect (' + upstream.status + ').' }, 502);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
