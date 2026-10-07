// Mission Control's one status pill. It replaces the header's separate LIVE clock, "Elarion Ready" chip and breaker badge
// with a single worded state, and opens a popover with the detail and the stop / resume controls (the breaker bar mounts
// into the popover). The pill's text always carries the meaning; colour only backs it up.
//
//   Halted > engine trouble > Needs you > N working > Set up needed > All idle
//
// Markup comes from src/mission-control-page.js; this module finds its parts by data attribute under `root`.

// Pure: the pill's kind and text for a model of the fleet. Exported so the priority order is testable.
export function summarizeStatus(model) {
  const breaker = model.breaker || { state: 'CONNECTING' };
  const agents = model.agents || { working: 0, total: 0 };
  const waiting = model.waiting || 0;
  const elarion = model.elarion || { hidden: true };
  if (breaker.state === 'HALTED') return { kind: 'halted', text: 'Halted' };
  if (breaker.state === 'OFFLINE') return { kind: 'alert', text: 'Engine offline' };
  if (breaker.state === 'AUTH') return { kind: 'alert', text: 'Sign-in needed' };
  if (breaker.state === 'ERROR') return { kind: 'alert', text: 'Engine error' };
  if (breaker.state === 'CONNECTING') return { kind: 'checking', text: 'Checking' };
  if (waiting > 0) return { kind: 'alert', text: 'Needs you · ' + waiting };
  if (agents.working > 0) return { kind: 'running', text: agents.working + ' working' };
  if (!elarion.hidden && elarion.kind === 'alert') return { kind: 'alert', text: 'Setup needed' };
  return { kind: 'idle', text: 'All idle' };
}

// "4 s ago" style age for the Engine row.
export function formatAge(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + ' s ago';
  const m = Math.floor(s / 60);
  return m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago';
}

const ENGINE_ROW = {
  CONNECTING: 'Checking the connection',
  ACTIVE: 'Connected',
  HALTED: 'Connected',
  OFFLINE: 'Not reachable',
  AUTH: 'Needs a sign-in token',
  ERROR: 'Returned an error',
};

export function mountStatusPill(root, options = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView || globalThis;
  const now = options.now || Date.now;
  const part = (name) => root.querySelector('[data-status="' + name + '"]');
  const pill = part('pill');
  const text = part('text');
  const panel = part('panel');
  const live = part('live');
  const alertRegion = part('alert');
  const engineRow = part('engine');
  const engineAction = part('engine-action');
  const agentsRow = part('agents');
  const waitingRow = part('waiting');
  const cutoffRow = part('cutoff');
  if (!pill || !text || !panel) throw new Error('Status pill markup is missing.');

  const model = { breaker: { state: 'CONNECTING', reason: null, syncedAt: null }, agents: { working: 0, total: 0, stopped: 0 }, waiting: 0, elarion: { hidden: true } };
  let current = null;
  let open = false;
  let ticker = null;

  function cutoffText() {
    const b = model.breaker;
    if (b.state === 'HALTED') return 'On. Agents are stopped' + (b.reason ? ' (' + b.reason + ')' : '') + '.';
    if (b.state === 'ACTIVE') return 'Off. Agents run normally.';
    return 'Unknown until the engine answers.';
  }

  function render() {
    const next = summarizeStatus(model);
    const b = model.breaker;
    pill.dataset.kind = next.kind;
    text.textContent = next.text;
    pill.setAttribute('aria-label', 'Fleet status: ' + next.text + '. ' + (open ? 'Close' : 'Open') + ' details.');

    if (engineRow) {
      const age = b.syncedAt ? ' (synced ' + formatAge(now() - b.syncedAt) + ')' : '';
      engineRow.textContent = (ENGINE_ROW[b.state] || '') + (b.state === 'ACTIVE' || b.state === 'HALTED' ? age : '');
    }
    if (engineAction) {
      const needsAction = b.state === 'OFFLINE' || b.state === 'ERROR' || b.state === 'AUTH';
      engineAction.hidden = !needsAction;
      engineAction.textContent = b.state === 'AUTH' ? 'Check connection' : 'Retry';
    }
    if (agentsRow) {
      const a = model.agents;
      agentsRow.textContent = a.total ? a.working + ' working of ' + a.total + (a.stopped ? ', ' + a.stopped + ' stopped' : '') : 'None yet';
    }
    if (waitingRow) waitingRow.textContent = model.waiting ? model.waiting + ' choice' + (model.waiting === 1 ? '' : 's') + ' waiting' : 'Nothing';
    if (cutoffRow) cutoffRow.textContent = cutoffText();

    // Announce changes only: polite for ordinary ones, assertive for Halted.
    if (!current || current.text !== next.text) {
      const message = 'Fleet status: ' + next.text;
      if (current) {
        if (next.kind === 'halted' && alertRegion) alertRegion.textContent = message;
        else if (live) live.textContent = message;
      }
    }
    current = next;
  }

  function update(patch = {}) {
    if (patch.breaker) model.breaker = { ...model.breaker, ...patch.breaker };
    if (patch.agents) model.agents = { ...model.agents, ...patch.agents };
    if (patch.waiting != null) model.waiting = patch.waiting;
    if (patch.elarion) model.elarion = patch.elarion;
    render();
  }

  // --- popover
  const confirmOpen = () => !!doc.querySelector('.engine-modal:not([hidden])');

  function place() {
    const rect = pill.getBoundingClientRect();
    root.style.setProperty('--status-top', Math.round(rect.bottom + 8) + 'px');
  }

  function show() {
    if (open) return;
    open = true;
    place();
    panel.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    render();
    ticker = setInterval(render, 1000);
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('resize', place);
    // Focus lands on the panel itself, never on an action that changes anything; Tab then walks the controls.
    panel.focus();
  }

  function hide(restoreFocus = true) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    clearInterval(ticker);
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('resize', place);
    render();
    if (restoreFocus) pill.focus();
  }

  function onOutside(event) {
    if (root.contains(event.target) || confirmOpen()) return;
    hide(false);
  }

  function onKey(event) {
    if (event.key !== 'Escape' || confirmOpen()) return;
    event.stopPropagation();
    hide(true);
  }

  pill.addEventListener('click', () => (open ? hide(true) : show()));
  if (engineAction) engineAction.addEventListener('click', () => options.onEngineAction && options.onEngineAction(model.breaker.state));
  // Tabbing out of the panel closes it, unless the stop dialog is up.
  panel.addEventListener('focusout', (event) => {
    if (!open || confirmOpen()) return;
    const to = event.relatedTarget;
    if (to && (panel.contains(to) || to === pill)) return;
    if (!to) return;
    hide(false);
  });

  render();

  return {
    update,
    open: show,
    close: hide,
    isOpen: () => open,
    getSummary: () => summarizeStatus(model),
    elements: { pill, panel, text, live, alertRegion, engineAction },
    destroy() {
      hide(false);
      clearInterval(ticker);
    },
  };
}
