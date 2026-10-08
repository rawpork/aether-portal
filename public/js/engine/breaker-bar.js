// Emergency circuit breaker for Mission Control: live agent state badge, TRIP BREAKER panic button and RESET AGENT.
// Mounted by mission-control.js into the workspace's top-right corner. Talks to the local Aether_Engine through the
// bundled client (public/js/engine-api.bundle.js, built from src/services/engineApi.ts by `npm run build:client`).
// Tokens are handled by connection.js; when the engine answers 401 the badge reads TOKEN NEEDED and a click calls
// options.onAuthNeeded.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';
import { trapFocus } from '../a11y.js';
import { pollDelay } from './poll-rate.js';

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

// Button and dialog wording. The defaults are the standalone breaker's; Mission Control's status pill passes plain-language
// labels and the extra agents to stop (see mountBreakerBar options).
const DEFAULT_LABELS = {
  trip: { long: 'TRIP BREAKER', short: 'TRIP', aria: 'Trip breaker' },
  reset: { long: 'RESET AGENT', short: 'RESET', aria: 'Reset agent' },
  confirmTitle: 'Trip the circuit breaker?',
  confirmAction: 'Trip Breaker',
  confirmText: (agentId) => 'This halts ' + agentId + ' immediately: running task loops stop at their next step, chat is refused and voice streams close. It stays halted until you reset it.',
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
  const labels = {
    ...DEFAULT_LABELS,
    ...(options.labels || {}),
    trip: { ...DEFAULT_LABELS.trip, ...((options.labels || {}).trip || {}) },
    reset: { ...DEFAULT_LABELS.reset, ...((options.labels || {}).reset || {}) },
  };
  // Other agents the trip button also stops, besides `agentId` (the workforce's agent ids). Read at click time.
  const extraTargets = () => (options.getTripTargets ? options.getTripTargets() : []).filter((id) => id !== agentId);

  const view = { state: 'CONNECTING', reason: null, detail: null, busy: false, syncedAt: null };
  let timer = null;
  let polling = false;
  let confirmTrap = null;
  let destroyed = false;

  // --- controls
  const badgeLabel = el(doc, 'span', { class: 'engine-badge-label', text: BADGE_TEXT.CONNECTING });
  const badge = el(doc, 'button', { type: 'button', class: 'engine-badge', 'data-state': 'CONNECTING', 'aria-live': 'polite' }, [
    el(doc, 'span', { class: 'engine-dot', 'aria-hidden': 'true' }),
    badgeLabel,
  ]);
  const tripButton = el(doc, 'button', { type: 'button', class: 'bar-btn engine-trip', 'aria-haspopup': 'dialog', 'aria-label': labels.trip.aria }, [
    el(doc, 'span', { class: 'engine-trip-long', text: labels.trip.long }),
    el(doc, 'span', { class: 'engine-trip-short', 'aria-hidden': 'true', text: labels.trip.short }),
  ]);
  const resetButton = el(doc, 'button', { type: 'button', class: 'bar-btn engine-reset', 'aria-label': labels.reset.aria, hidden: true }, [
    el(doc, 'span', { class: 'engine-trip-long', text: labels.reset.long }),
    el(doc, 'span', { class: 'engine-trip-short', 'aria-hidden': 'true', text: labels.reset.short }),
  ]);
  container.replaceChildren(badge, tripButton, resetButton);

  // --- trip confirmation dialog
  const confirmError = el(doc, 'p', { class: 'modal-error' });
  const confirmCancel = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Cancel' });
  const confirmTrip = el(doc, 'button', { type: 'button', class: 'toggle-button engine-trip-confirm', text: labels.confirmAction });
  const confirmText = el(doc, 'p', { class: 'engine-modal-text' });
  const confirmModal = el(doc, 'div', { class: 'modal-backdrop engine-modal', hidden: true }, [
    el(doc, 'div', { class: 'modal-panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'engine-trip-title' }, [
      el(doc, 'h3', { id: 'engine-trip-title', class: 'engine-danger-title', text: labels.confirmTitle }),
      confirmText,
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
    // With other agents still to stop, a halted master does not disable it.
    tripButton.disabled = view.busy || (halted && extraTargets().length === 0);
    resetButton.hidden = !halted;
    resetButton.disabled = view.busy;
    if (options.onChange) options.onChange({ state: view.state, reason: view.reason, detail: view.detail, syncedAt: view.syncedAt, busy: view.busy });
  }

  function setState(state, extra = {}) {
    view.state = state;
    view.reason = extra.reason || null;
    view.detail = extra.detail || null;
    if (state === 'ACTIVE' || state === 'HALTED') view.syncedAt = Date.now();
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
    timer = setTimeout(poll, pollDelay(offline ? offlinePollMs : pollMs));
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
  // The stop dialog is modal: Tab stays between Cancel and the confirm button until it closes.
  function releaseTrap() {
    if (confirmTrap) {
      confirmTrap.release({ restore: false });
      confirmTrap = null;
    }
  }
  function closeConfirm() {
    confirmModal.hidden = true;
    releaseTrap();
    if (!tripButton.disabled) tripButton.focus();
  }

  // --- actions
  async function trip() {
    view.busy = true;
    confirmTrip.disabled = true;
    confirmError.textContent = '';
    render();
    try {
      const others = extraTargets();
      // An already-halted master is not tripped again; the rest still are.
      if (view.state !== 'HALTED') await api.tripBreaker(agentId, MANUAL_TRIP_REASON);
      const results = await Promise.allSettled(others.map((id) => api.tripBreaker(id, MANUAL_TRIP_REASON)));
      const failed = others.filter((id, i) => results[i].status === 'rejected');
      setState('HALTED', { reason: MANUAL_TRIP_REASON });
      if (options.onStopped) options.onStopped();
      if (failed.length) {
        // Keep the dialog open so the operator sees which ones did not stop; Stop again retries only those.
        confirmError.textContent = agentId + ' is stopped, but these did not stop: ' + failed.join(', ') + '. Try again, or stop them from their cards.';
        return;
      }
      confirmModal.hidden = true;
      releaseTrap();
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
    confirmText.textContent = options.labels && options.labels.confirmText ? options.labels.confirmText(agentId, extraTargets()) : DEFAULT_LABELS.confirmText(agentId);
    confirmModal.hidden = false;
    // Cancel takes focus so an accidental Enter does not trip the breaker.
    confirmCancel.focus();
    releaseTrap();
    confirmTrap = trapFocus(confirmModal, { returnTo: tripButton });
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
      releaseTrap();
      confirmModal.remove();
      container.replaceChildren();
    },
  };
}
