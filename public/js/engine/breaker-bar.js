// Engine breaker bar: live agent state badge, TRIP BREAKER panic button, RESET AGENT, and the engine token modal.
// Mounted into #engine-bar in the portal top bar. Talks to the local Aether_Engine through the bundled client
// (public/js/engine-api.bundle.js, built from src/services/engineApi.ts by `npm run build:client`).
import { getEngineApi, getStoredEngineToken, onEngineState, setStoredEngineToken } from '../engine-api.bundle.js';

export const BREAKER_AGENT_ID = 'master-brain';
export const MANUAL_TRIP_REASON = 'Operator manual trip from Portal UI';
export const POLL_INTERVAL_MS = 5000;
// While the engine is unreachable, poll less often; clicking the badge retries at once.
export const OFFLINE_POLL_INTERVAL_MS = 30000;

// Badge states: the agent's own ACTIVE / HALTED, plus connection states for when the engine can't answer.
const BADGE_TEXT = {
  CONNECTING: 'CONNECTING',
  ACTIVE: 'ACTIVE',
  HALTED: 'HALTED',
  OFFLINE: 'ENGINE OFFLINE',
  AUTH: 'TOKEN NEEDED',
  ERROR: 'ENGINE ERROR',
};

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

// Reads the claims of a JWT for display only; the engine is what verifies the signature.
export function describeToken(token) {
  if (!token) return { present: false };
  const parts = token.split('.');
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
      expired: expiresAt ? expiresAt.getTime() < Date.now() : false,
      preview: token.slice(0, 10) + '…' + token.slice(-6),
    };
  } catch {
    return { present: true, malformed: true };
  }
}

export function mountBreakerBar(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const agentId = options.agentId || BREAKER_AGENT_ID;
  const pollMs = options.pollIntervalMs || POLL_INTERVAL_MS;
  const offlinePollMs = options.offlinePollIntervalMs || OFFLINE_POLL_INTERVAL_MS;
  const readToken = options.getToken || getStoredEngineToken;
  const writeToken = options.setToken || setStoredEngineToken;

  const view = { state: 'CONNECTING', reason: null, detail: null, busy: false };
  let timer = null;
  let polling = false;
  let destroyed = false;

  // --- top bar controls
  const badgeLabel = el(doc, 'span', { class: 'engine-badge-label', text: BADGE_TEXT.CONNECTING });
  const badge = el(doc, 'button', { type: 'button', class: 'engine-badge', 'data-state': 'CONNECTING', 'aria-live': 'polite' }, [
    el(doc, 'span', { class: 'engine-dot', 'aria-hidden': 'true' }),
    badgeLabel,
  ]);
  const tripButton = el(doc, 'button', { type: 'button', class: 'bar-btn engine-trip', 'aria-haspopup': 'dialog', 'aria-label': 'Trip breaker' }, [
    el(doc, 'span', { class: 'engine-trip-long', text: 'TRIP BREAKER' }),
    el(doc, 'span', { class: 'engine-trip-short', 'aria-hidden': 'true', text: 'TRIP' }),
  ]);
  const resetButton = el(doc, 'button', { type: 'button', class: 'bar-btn engine-reset', text: 'RESET AGENT', hidden: true });
  const tokenButton = el(doc, 'button', {
    type: 'button',
    class: 'bar-btn engine-token',
    title: 'Engine token',
    'aria-label': 'Engine token settings',
    'aria-haspopup': 'dialog',
    text: '🔑',
  });
  container.replaceChildren(badge, tripButton, resetButton, tokenButton);

  // --- trip confirmation dialog
  const confirmError = el(doc, 'p', { class: 'modal-error' });
  const confirmCancel = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Cancel' });
  const confirmTrip = el(doc, 'button', { type: 'button', class: 'toggle-button engine-trip-confirm', text: 'Trip Breaker' });
  const confirmModal = el(doc, 'div', { class: 'modal-backdrop engine-modal', hidden: true }, [
    el(doc, 'div', { class: 'modal-panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'engine-trip-title' }, [
      el(doc, 'h3', { id: 'engine-trip-title', class: 'engine-danger-title', text: 'Trip the circuit breaker?' }),
      el(doc, 'p', {
        class: 'engine-modal-text',
        text: 'This halts ' + agentId + ' immediately: running task loops stop at their next step, chat is refused and voice streams close. It stays halted until you reset it.',
      }),
      confirmError,
      el(doc, 'div', { class: 'modal-actions' }, [confirmCancel, confirmTrip]),
    ]),
  ]);

  // --- token settings dialog
  const tokenStatus = el(doc, 'p', { class: 'engine-modal-text engine-token-status' });
  const tokenInput = el(doc, 'textarea', { rows: '3', class: 'engine-token-input', placeholder: 'Paste a Supabase JWT', spellcheck: 'false', autocomplete: 'off' });
  const tokenError = el(doc, 'p', { class: 'modal-error' });
  const tokenClear = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Clear' });
  const tokenCancel = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Cancel' });
  const tokenSave = el(doc, 'button', { type: 'submit', class: 'toggle-button active', text: 'Save Token' });
  const tokenForm = el(doc, 'form', { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'engine-token-title', autocomplete: 'off' }, [
    el(doc, 'h3', { id: 'engine-token-title', text: 'Engine Token' }),
    tokenStatus,
    el(doc, 'label', { text: 'New token' }, [tokenInput]),
    tokenError,
    el(doc, 'div', { class: 'modal-actions' }, [tokenClear, tokenCancel, tokenSave]),
  ]);
  const tokenModal = el(doc, 'div', { class: 'modal-backdrop engine-modal', hidden: true }, [tokenForm]);

  doc.body.append(confirmModal, tokenModal);

  // --- rendering
  function render() {
    const halted = view.state === 'HALTED';
    badge.dataset.state = view.state;
    badgeLabel.textContent = BADGE_TEXT[view.state];
    const lines = ['Agent: ' + agentId, 'State: ' + BADGE_TEXT[view.state]];
    if (halted && view.reason) lines.push('Reason: ' + view.reason);
    if (view.detail) lines.push(view.detail);
    if (view.state === 'OFFLINE' || view.state === 'ERROR') lines.push('Click to retry now.');
    if (view.state === 'AUTH') lines.push('Click to set the engine token.');
    badge.title = lines.join('\n');
    badge.setAttribute('aria-label', 'Engine agent ' + agentId + ': ' + BADGE_TEXT[view.state]);

    // The panic button stays available even when the last poll failed; only an already-halted agent disables it.
    tripButton.disabled = view.busy || halted;
    resetButton.hidden = !halted;
    resetButton.disabled = view.busy;
  }

  function setState(state, extra = {}) {
    view.state = state;
    view.reason = extra.reason || null;
    view.detail = extra.detail || null;
    render();
  }

  function applyError(error) {
    if (error && error.isUnreachable) setState('OFFLINE', { detail: error.message });
    else if (error && error.isUnauthorized) setState('AUTH', { detail: error.message });
    else setState('ERROR', { detail: (error && error.message) || 'Unknown engine error.' });
  }

  // --- polling
  function schedule() {
    clearTimeout(timer);
    if (destroyed) return;
    const offline = view.state === 'OFFLINE' || view.state === 'ERROR';
    timer = setTimeout(poll, offline ? offlinePollMs : pollMs);
  }

  async function poll() {
    if (destroyed || polling) return;
    if (doc.hidden) return schedule();
    polling = true;
    try {
      const record = await api.getAgentState(agentId);
      setState(record.state, { reason: record.reason });
    } catch (error) {
      applyError(error);
    } finally {
      polling = false;
      schedule();
    }
  }

  const unsubscribe = onEngineState((detail) => {
    if (detail.agentId !== agentId) return;
    setState(detail.state, { reason: detail.reason });
  });

  function onVisibility() {
    if (!doc.hidden) poll();
  }
  doc.addEventListener('visibilitychange', onVisibility);

  // --- dialogs
  function openModal(modal, focusTarget) {
    modal.hidden = false;
    focusTarget.focus();
  }

  function closeModal(modal, returnFocus) {
    modal.hidden = true;
    if (returnFocus && !returnFocus.disabled && !returnFocus.hidden) returnFocus.focus();
  }

  function openTokenModal() {
    const info = describeToken(readToken());
    if (!info.present) {
      tokenStatus.textContent = 'No token stored. Requests go without auth, which only works if the engine runs with REQUIRE_AUTH=false.';
    } else if (info.malformed) {
      tokenStatus.textContent = 'Stored token is not a valid JWT.';
    } else {
      const expiry = info.expiresAt ? (info.expired ? 'expired ' : 'expires ') + info.expiresAt.toLocaleString() : 'no expiry';
      tokenStatus.textContent = 'Stored: ' + info.preview + ' · subject ' + (info.sub || 'unknown') + ' · ' + expiry;
    }
    tokenInput.value = '';
    tokenError.textContent = '';
    openModal(tokenModal, tokenInput);
  }

  // --- actions
  async function trip() {
    view.busy = true;
    confirmTrip.disabled = true;
    confirmError.textContent = '';
    render();
    try {
      await api.tripBreaker(agentId, MANUAL_TRIP_REASON);
      setState('HALTED', { reason: MANUAL_TRIP_REASON });
      closeModal(confirmModal, resetButton);
    } catch (error) {
      confirmError.textContent = 'Trip failed: ' + ((error && error.message) || 'unknown error');
    } finally {
      view.busy = false;
      confirmTrip.disabled = false;
      render();
    }
  }

  async function reset() {
    view.busy = true;
    render();
    try {
      await api.resetBreaker(agentId);
      setState('ACTIVE');
      tripButton.focus();
    } catch (error) {
      // 409: someone else already reset it; re-read the real state.
      if (error && error.status === 409) await poll();
      else applyError(error);
    } finally {
      view.busy = false;
      render();
    }
  }

  tripButton.addEventListener('click', () => {
    confirmError.textContent = '';
    // Cancel takes focus so an accidental Enter does not trip the breaker.
    openModal(confirmModal, confirmCancel);
  });
  confirmCancel.addEventListener('click', () => closeModal(confirmModal, tripButton));
  confirmTrip.addEventListener('click', trip);
  resetButton.addEventListener('click', reset);
  badge.addEventListener('click', () => {
    if (view.state === 'AUTH') openTokenModal();
    else poll();
  });

  tokenButton.addEventListener('click', openTokenModal);
  tokenCancel.addEventListener('click', () => closeModal(tokenModal, tokenButton));
  tokenClear.addEventListener('click', () => {
    writeToken(null);
    closeModal(tokenModal, tokenButton);
    poll();
  });
  tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = tokenInput.value.trim();
    const info = describeToken(value);
    if (!info.present || info.malformed) {
      tokenError.textContent = 'Paste a JWT: three base64url parts separated by dots.';
      return;
    }
    writeToken(value);
    closeModal(tokenModal, tokenButton);
    poll();
  });

  for (const modal of [confirmModal, tokenModal]) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal, modal === confirmModal ? tripButton : tokenButton);
    });
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeModal(modal, modal === confirmModal ? tripButton : tokenButton);
    });
  }

  render();
  poll();

  return {
    refresh: poll,
    getState: () => view.state,
    elements: { badge, tripButton, resetButton, tokenButton, confirmModal, confirmTrip, confirmCancel, tokenModal, tokenInput, tokenForm, tokenStatus, tokenError, tokenClear },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      unsubscribe();
      doc.removeEventListener('visibilitychange', onVisibility);
      confirmModal.remove();
      tokenModal.remove();
      container.replaceChildren();
    },
  };
}

// Portal page: mount into the top bar slot when present.
const slot = typeof document !== 'undefined' ? document.getElementById('engine-bar') : null;
if (slot) mountBreakerBar(slot);
