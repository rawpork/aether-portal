// Emergency circuit breaker for Mission Control: live agent state badge, TRIP BREAKER panic button and RESET AGENT.
// Mounted by mission-control.js into the workspace's top-right corner. Talks to the local Aether_Engine through the
// bundled client (public/js/engine-api.bundle.js, built from src/services/engineApi.ts by `npm run build:client`).
// Tokens are handled by connection.js; when the engine answers 401 the badge reads TOKEN NEEDED and a click calls
// options.onAuthNeeded.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';

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

export function mountBreakerBar(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const agentId = options.agentId || BREAKER_AGENT_ID;
  const pollMs = options.pollIntervalMs || POLL_INTERVAL_MS;
  const offlinePollMs = options.offlinePollIntervalMs || OFFLINE_POLL_INTERVAL_MS;
  const onAuthNeeded = options.onAuthNeeded || null;

  const view = { state: 'CONNECTING', reason: null, detail: null, busy: false };
  let timer = null;
  let polling = false;
  let destroyed = false;

  // --- controls
  const badgeLabel = el(doc, 'span', { class: 'engine-badge-label', text: BADGE_TEXT.CONNECTING });
  const badge = el(doc, 'button', { type: 'button', class: 'engine-badge', 'data-state': 'CONNECTING', 'aria-live': 'polite' }, [
    el(doc, 'span', { class: 'engine-dot', 'aria-hidden': 'true' }),
    badgeLabel,
  ]);
  const tripButton = el(doc, 'button', { type: 'button', class: 'bar-btn engine-trip', 'aria-haspopup': 'dialog', 'aria-label': 'Trip breaker' }, [
    el(doc, 'span', { class: 'engine-trip-long', text: 'TRIP BREAKER' }),
    el(doc, 'span', { class: 'engine-trip-short', 'aria-hidden': 'true', text: 'TRIP' }),
  ]);
  const resetButton = el(doc, 'button', { type: 'button', class: 'bar-btn engine-reset', 'aria-label': 'Reset agent', hidden: true }, [
    el(doc, 'span', { class: 'engine-trip-long', text: 'RESET AGENT' }),
    el(doc, 'span', { class: 'engine-trip-short', 'aria-hidden': 'true', text: 'RESET' }),
  ]);
  container.replaceChildren(badge, tripButton, resetButton);

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
  doc.body.append(confirmModal);

  // --- rendering
  function render() {
    const halted = view.state === 'HALTED';
    badge.dataset.state = view.state;
    badgeLabel.textContent = BADGE_TEXT[view.state];
    const lines = ['Agent: ' + agentId, 'State: ' + BADGE_TEXT[view.state]];
    if (halted && view.reason) lines.push('Reason: ' + view.reason);
    if (view.detail) lines.push(view.detail);
    if (view.state === 'OFFLINE' || view.state === 'ERROR') lines.push('Click to retry now.');
    if (view.state === 'AUTH') lines.push('Click to check the engine connection.');
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
    else if (error && error.isUnauthorized) setState('AUTH', { detail: describeAuthError(error) });
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

  // --- dialog
  function closeConfirm() {
    confirmModal.hidden = true;
    if (!tripButton.disabled) tripButton.focus();
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
      confirmModal.hidden = true;
      resetButton.focus();
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
    confirmModal.hidden = false;
    // Cancel takes focus so an accidental Enter does not trip the breaker.
    confirmCancel.focus();
  });
  confirmCancel.addEventListener('click', closeConfirm);
  confirmTrip.addEventListener('click', trip);
  resetButton.addEventListener('click', reset);
  badge.addEventListener('click', () => {
    if (view.state === 'AUTH' && onAuthNeeded) onAuthNeeded();
    else poll();
  });
  confirmModal.addEventListener('click', (event) => {
    if (event.target === confirmModal) closeConfirm();
  });
  confirmModal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeConfirm();
  });

  render();
  poll();

  return {
    refresh: poll,
    getState: () => view.state,
    elements: { badge, tripButton, resetButton, confirmModal, confirmTrip, confirmCancel },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      unsubscribe();
      doc.removeEventListener('visibilitychange', onVisibility);
      confirmModal.remove();
      container.replaceChildren();
    },
  };
}
