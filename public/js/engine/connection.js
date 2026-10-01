// Engine connection for Mission Control: gets an engine JWT without a pasted key and shows how the page is connected.
//
// Order of preference:
//   1. portal  - GET /api/engine/token mints a short-lived token for the signed-in portal user (needs the Worker's
//                ENGINE_JWT_SECRET, set in .dev.vars for local dev or as a secret in production). Refreshed before expiry.
//   2. stored  - a still-valid token already in localStorage (aether.engine.jwt), e.g. pasted earlier.
//   3. none    - no Authorization header; works only against an engine started with REQUIRE_AUTH=false.
// The manual paste form appears only when the portal can't mint tokens.
import { getStoredEngineToken, setStoredEngineToken } from '../engine-api.bundle.js';

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

// Resolves the token to use and stores it where the engine client reads it.
// Returns { source: 'portal' | 'stored' | 'none', expiresAt, portal: 'ok' | 'unconfigured' | 'signed-out' | 'unavailable' }.
export async function bootstrapEngineToken(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const getToken = options.getToken || getStoredEngineToken;
  const setToken = options.setToken || setStoredEngineToken;
  const now = options.now || Date.now;

  let portal = 'unavailable';
  try {
    const response = await fetchImpl(ENGINE_TOKEN_ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (response.ok) {
      const body = await response.json();
      const info = describeToken(body.token, now());
      if (info.present && !info.malformed && !info.expired) {
        setToken(body.token);
        return { source: 'portal', expiresAt: info.expiresAt, portal: 'ok' };
      }
    } else if (response.status === 404) {
      portal = 'unconfigured';
    } else if (response.status === 401) {
      portal = 'signed-out';
    }
  } catch {
    // Offline or blocked: fall back to whatever is stored.
  }

  const stored = getToken();
  const info = describeToken(stored, now());
  if (info.present && !info.malformed && !info.expired) return { source: 'stored', expiresAt: info.expiresAt, sub: info.sub, portal };
  // An expired or broken token would only earn 401s; drop it so the bypass can work.
  if (info.present) setToken(null);
  return { source: 'none', expiresAt: null, portal };
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

// Renders the connection panel into a <details> element and keeps the token fresh.
// Resolves once the first bootstrap has finished, so callers can mount engine UI with a token already in place.
export async function mountConnection(details, options = {}) {
  const doc = details.ownerDocument;
  const baseUrl = options.baseUrl || 'http://localhost:3333';
  const setToken = options.setToken || setStoredEngineToken;
  const onChange = options.onChange || (() => {});
  let state = null;
  let refreshTimer = null;

  const summary = el(doc, 'summary', { text: 'Engine connection' });
  const where = el(doc, 'p', { text: 'Engine: ' + baseUrl });
  const how = el(doc, 'p');
  const refreshButton = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Refresh connection' });
  const manualInput = el(doc, 'textarea', { rows: '3', placeholder: 'Paste an engine JWT', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Engine JWT' });
  const manualError = el(doc, 'p', { class: 'modal-error' });
  const manualSave = el(doc, 'button', { type: 'submit', class: 'toggle-button', text: 'Use token' });
  const manualClear = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Clear stored token' });
  const manualForm = el(doc, 'form', { class: 'mc-connection-manual', hidden: true }, [
    el(doc, 'p', { class: 'mc-muted', text: 'Fallback: the portal can’t mint engine tokens (ENGINE_JWT_SECRET is not set), so a token can be pasted here.' }),
    manualInput,
    manualError,
    el(doc, 'div', { class: 'mc-connection-actions' }, [manualSave, manualClear]),
  ]);
  details.replaceChildren(summary, el(doc, 'div', { class: 'mc-connection-body' }, [where, how, el(doc, 'div', { class: 'mc-connection-actions' }, [refreshButton]), manualForm]));

  function render() {
    const time = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (state.source === 'portal') {
      summary.textContent = 'Engine connection · portal session token';
      how.textContent = 'Signed in automatically with a token minted for your portal session (renews before ' + time(state.expiresAt) + ').';
    } else if (state.source === 'stored') {
      summary.textContent = 'Engine connection · stored token';
      how.textContent = 'Using a stored token' + (state.sub ? ' for ' + state.sub : '') + (state.expiresAt ? ', valid until ' + time(state.expiresAt) : '') + '.';
    } else {
      summary.textContent = 'Engine connection · no token (local bypass)';
      how.textContent = 'No token: requests go without auth, which works when the engine runs with REQUIRE_AUTH=false (local dev).';
    }
    if (state.portal === 'signed-out') how.textContent += ' Your portal session has expired; reload to sign in again.';
    manualForm.hidden = state.source === 'portal' || state.portal !== 'unconfigured';
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
