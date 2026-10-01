// Engine connection for Mission Control: where the engine is, and an engine JWT without a pasted key.
//
// Engine URL: http://localhost:3333 by default, which only works on the computer running the engine. Another device
// (a phone) needs an https address that reaches the engine, such as a Cloudflare Tunnel; it is saved per browser in
// localStorage (aether.engine.baseUrl) and applied by reloading the page.
//
// Token, in order of preference:
//   1. portal  - GET /api/engine/token mints a short-lived token for the signed-in portal user (needs the Worker's
//                ENGINE_JWT_SECRET, set in .dev.vars for local dev or as a secret in production). Refreshed before expiry.
//   2. stored  - a still-valid token already in localStorage (aether.engine.jwt), e.g. pasted earlier.
//   3. none    - no Authorization header; works only against an engine started with REQUIRE_AUTH=false.
// The paste-a-token fallback appears only when the portal didn't mint a token.
import { DEFAULT_ENGINE_BASE_URL, ENGINE_BASE_URL_STORAGE_KEY, getStoredEngineToken, setStoredEngineToken } from '../engine-api.bundle.js';

export const ENGINE_TOKEN_ENDPOINT = '/api/engine/token';
// Refresh a portal token this long before it expires.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Reads the claims of a JWT for display only; the engine is what verifies the signature.
export function describeToken(token, now = Date.now()) {
  if (!token) return { present: false };
  const parts = String(token).split('.');
  if (parts.length !== 3) return { present: true, malformed: true };
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='));
    const claims = JSON.parse(json);
    const expiresAt = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null;
    return {
      present: true,
      malformed: false,
      sub: typeof claims.sub === 'string' ? claims.sub : null,
      expiresAt,
      expired: expiresAt ? expiresAt.getTime() <= now : false,
    };
  } catch {
    return { present: true, malformed: true };
  }
}

// Checks an engine URL typed by the user. Returns { ok, url, error, warning }.
// An https page can't call a plain-http engine unless it is on this device (localhost), so that is refused.
export function checkEngineUrl(value, pageProtocol = 'https:') {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return { ok: false, error: 'Enter a full URL, like https://engine.example.com.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The engine URL must start with http:// or https://.' };
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (pageProtocol === 'https:' && url.protocol === 'http:' && !local) {
    return { ok: false, error: 'This page is https, so browsers block a plain-http engine on another machine. Use an https address for it (for example a Cloudflare Tunnel).' };
  }
  const clean = url.origin + url.pathname.replace(/\/+$/, '');
  return { ok: true, url: clean, warning: local ? 'localhost only works on the computer running the engine.' : '' };
}

// Resolves the token to use and stores it where the engine client reads it.
// Returns { source: 'portal' | 'stored' | 'none', expiresAt, portal, portalStatus }, where portal is
// 'ok' | 'unconfigured' (404) | 'signed-out' (401) | 'error' (other HTTP status) | 'unavailable' (network).
export async function bootstrapEngineToken(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const getToken = options.getToken || getStoredEngineToken;
  const setToken = options.setToken || setStoredEngineToken;
  const now = options.now || Date.now;

  let portal = 'unavailable';
  let portalStatus = null;
  try {
    const response = await fetchImpl(ENGINE_TOKEN_ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
    portalStatus = response.status;
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      const info = describeToken(body.token, now());
      if (info.present && !info.malformed && !info.expired) {
        setToken(body.token);
        return { source: 'portal', expiresAt: info.expiresAt, portal: 'ok', portalStatus };
      }
      portal = 'error';
    } else if (response.status === 404) {
      portal = 'unconfigured';
    } else if (response.status === 401) {
      portal = 'signed-out';
    } else {
      portal = 'error';
    }
  } catch {
    // Offline or blocked: fall back to whatever is stored.
  }

  const stored = getToken();
  const info = describeToken(stored, now());
  if (info.present && !info.malformed && !info.expired) return { source: 'stored', expiresAt: info.expiresAt, sub: info.sub, portal, portalStatus };
  // An expired or broken token would only earn 401s; drop it so the bypass can work.
  if (info.present) setToken(null);
  return { source: 'none', expiresAt: null, portal, portalStatus };
}

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function writeStorage(key, value) {
  try {
    if (value) globalThis.localStorage.setItem(key, value);
    else globalThis.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the setting just won't stick.
  }
}

// Why the portal didn't mint a token, in words.
function portalReason(state) {
  switch (state.portal) {
    case 'unconfigured':
      return 'The portal can’t mint engine tokens: ENGINE_JWT_SECRET is not set on the Worker (HTTP 404).';
    case 'signed-out':
      return 'Your portal session has expired; reload to sign in again (HTTP 401).';
    case 'error':
      return 'The portal’s token endpoint failed (HTTP ' + state.portalStatus + ').';
    case 'unavailable':
      return 'The portal’s token endpoint could not be reached.';
    default:
      return '';
  }
}

// Renders the connection panel into a <details> element and keeps the token fresh.
// Resolves once the first bootstrap has finished, so callers can mount engine UI with a token already in place.
export async function mountConnection(details, options = {}) {
  const doc = details.ownerDocument;
  const win = doc.defaultView || globalThis;
  const baseUrl = options.baseUrl || DEFAULT_ENGINE_BASE_URL;
  const setToken = options.setToken || setStoredEngineToken;
  const onChange = options.onChange || (() => {});
  const reload = options.reload || (() => win.location.reload());
  const pageProtocol = options.pageProtocol || (win.location && win.location.protocol) || 'https:';
  let state = null;
  let refreshTimer = null;

  const summary = el(doc, 'summary', { text: 'Engine connection' });

  // Engine URL
  const urlInput = el(doc, 'input', { type: 'url', class: 'mc-url-input', value: baseUrl, 'aria-label': 'Engine URL', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' });
  urlInput.value = baseUrl;
  const urlSave = el(doc, 'button', { type: 'submit', class: 'toggle-button', text: 'Use this engine' });
  const urlReset = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Back to localhost', hidden: baseUrl === DEFAULT_ENGINE_BASE_URL });
  const urlError = el(doc, 'p', { class: 'modal-error' });
  const urlForm = el(doc, 'form', { class: 'mc-connection-url' }, [
    el(doc, 'label', { text: 'Engine URL' }, [urlInput]),
    el(doc, 'p', {
      class: 'mc-muted',
      text: 'localhost:3333 only works on the computer running the engine. On another device, like your phone, use an https address that reaches it, for example a Cloudflare Tunnel.',
    }),
    urlError,
    el(doc, 'div', { class: 'mc-connection-actions' }, [urlSave, urlReset]),
  ]);

  // Token
  const how = el(doc, 'p', { class: 'mc-connection-how' });
  const why = el(doc, 'p', { class: 'mc-muted mc-connection-why', hidden: true });
  const refreshButton = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Refresh token' });
  const manualInput = el(doc, 'textarea', { rows: '3', placeholder: 'Paste an engine JWT', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Engine JWT' });
  const manualError = el(doc, 'p', { class: 'modal-error' });
  const manualSave = el(doc, 'button', { type: 'submit', class: 'toggle-button', text: 'Use token' });
  const manualClear = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Clear stored token' });
  const manualForm = el(doc, 'form', { class: 'mc-connection-manual', hidden: true }, [
    el(doc, 'p', { class: 'mc-muted', text: 'Fallback: paste a token signed with the engine’s SUPABASE_JWT_SECRET.' }),
    manualInput,
    manualError,
    el(doc, 'div', { class: 'mc-connection-actions' }, [manualSave, manualClear]),
  ]);

  details.replaceChildren(
    summary,
    el(doc, 'div', { class: 'mc-connection-body' }, [urlForm, how, why, el(doc, 'div', { class: 'mc-connection-actions' }, [refreshButton]), manualForm]),
  );

  function render() {
    const time = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const host = (() => {
      try {
        return new URL(baseUrl).host;
      } catch {
        return baseUrl;
      }
    })();
    if (state.source === 'portal') {
      summary.textContent = 'Engine connection · ' + host + ' · portal session token';
      how.textContent = 'Signed in automatically with a token minted for your portal session (renews before ' + time(state.expiresAt) + ').';
    } else if (state.source === 'stored') {
      summary.textContent = 'Engine connection · ' + host + ' · stored token';
      how.textContent = 'Using a stored token' + (state.sub ? ' for ' + state.sub : '') + (state.expiresAt ? ', valid until ' + time(state.expiresAt) : '') + '.';
    } else {
      summary.textContent = 'Engine connection · ' + host + ' · no token';
      how.textContent = 'No token: requests go without auth, which works only when the engine runs with REQUIRE_AUTH=false.';
    }
    why.textContent = state.source === 'portal' ? '' : portalReason(state);
    why.hidden = !why.textContent;
    manualForm.hidden = state.source === 'portal';
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    state = await bootstrapEngineToken(options);
    render();
    if (state.source === 'portal' && state.expiresAt) {
      refreshTimer = setTimeout(refresh, Math.max(state.expiresAt.getTime() - Date.now() - REFRESH_MARGIN_MS, 30000));
    }
    onChange(state);
    return state;
  }

  urlForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const checked = checkEngineUrl(urlInput.value, pageProtocol);
    if (!checked.ok) {
      urlError.textContent = checked.error;
      return;
    }
    urlError.textContent = '';
    if (checked.url === baseUrl) return;
    writeStorage(ENGINE_BASE_URL_STORAGE_KEY, checked.url === DEFAULT_ENGINE_BASE_URL ? null : checked.url);
    reload();
  });
  urlReset.addEventListener('click', () => {
    writeStorage(ENGINE_BASE_URL_STORAGE_KEY, null);
    reload();
  });
  refreshButton.addEventListener('click', () => refresh());
  manualForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = manualInput.value.trim();
    const info = describeToken(value);
    if (!info.present || info.malformed) {
      manualError.textContent = 'Paste a JWT: three base64url parts separated by dots.';
      return;
    }
    if (info.expired) {
      manualError.textContent = 'That token has expired.';
      return;
    }
    manualError.textContent = '';
    manualInput.value = '';
    setToken(value);
    refresh();
  });
  manualClear.addEventListener('click', () => {
    setToken(null);
    refresh();
  });

  await refresh();

  return {
    refresh,
    getState: () => state,
    open() {
      details.open = true;
    },
    destroy() {
      clearTimeout(refreshTimer);
      details.replaceChildren();
    },
  };
}
