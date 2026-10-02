// Mission Control overview (DESIGN_SYSTEM.md): the operations summary, the agent workforce grid and the selected
// agent's detail panel. Every agent that has run a task loop on the engine (GET /api/tasks) gets a card, plus Elarion
// (master-brain), which is always there. Each card carries its own Pause / Resume button and API breaker switch; both
// drive that agent's circuit breaker on the engine (POST /api/agents/trip-breaker and /api/agents/reset), the
// engine's only per-agent control. The detail panel's sub-tabs show the latest run's activity timeline, its steps,
// its output, the AEPS SKILL.md playbooks bundled by the portal (GET /api/skills/aeps) and the Elarion API bridge.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';
import { ACTIVE_POLL_MS, IDLE_POLL_MS, describeTask, formatDuration } from './task-monitor.js';

export const ELARION_AGENT_ID = 'master-brain';
export const PAUSE_REASON = 'Paused from Mission Control';
export const BREAKER_OFF_REASON = 'API breaker switched off from Mission Control';
export const EMERGENCY_REASON = 'Emergency shutdown from Mission Control';
export const SKILLS_ENDPOINT = '/api/skills/aeps';
export const MAX_AGENTS = 12;
export const DETAIL_TABS = ['activity', 'tasks', 'output', 'skills', 'bridge'];

const PROFILES = { [ELARION_AGENT_ID]: { name: 'Elarion', role: 'Master Brain' } };
const AVATAR_TONES = ['violet', 'blue', 'amber', 'teal', 'rose', 'slate'];
const PILL_TEXT = { running: 'Running', 'needs-input': 'Needs input', paused: 'Paused', tripped: 'Tripped', idle: 'Idle', waiting: 'Waiting' };
const PILL_KIND = { running: 'running', 'needs-input': 'alert', paused: 'queued', tripped: 'off', idle: 'queued', waiting: 'queued' };
const EVENT_TEXT = {
  STARTED: 'Run started',
  STEP_STARTED: 'Step started',
  STEP_COMPLETED: 'Step completed',
  STEP_FAILED: 'Step failed',
  HALTED: 'Breaker tripped',
  COMPLETED: 'Run completed',
};

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const titleCase = (id) => String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function agentProfile(agentId) {
  const profile = PROFILES[agentId];
  const name = profile ? profile.name : titleCase(agentId);
  let hash = 0;
  for (const c of String(agentId)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return {
    name,
    role: profile ? profile.role : 'Sub-agent',
    code: String(agentId).toUpperCase(),
    initial: (name.trim()[0] || '?').toUpperCase(),
    tone: agentId === ELARION_AGENT_ID ? 'violet' : AVATAR_TONES[hash % AVATAR_TONES.length],
  };
}

export const clockTime = (date) => {
  const d = new Date(date);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

export function formatClock(ms) {
  if (!(ms >= 0)) return '—';
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export const greetingFor = (date = new Date()) => {
  const h = new Date(date).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

// One agent's card / detail view model. `tasks` are that agent's runs from GET /api/tasks, newest first.
export function summarizeAgent(agentId, tasks, agentState, now = Date.now()) {
  const latest = tasks[0] || null;
  const halted = agentState && agentState.state === 'HALTED';
  const reason = (agentState && agentState.reason) || '';
  let status = 'waiting';
  if (halted) status = reason === PAUSE_REASON ? 'paused' : 'tripped';
  else if (latest && latest.status === 'RUNNING') status = 'running';
  else if (latest && (latest.status === 'FAILED' || latest.status === 'HALTED')) status = 'needs-input';
  else if (latest) status = 'idle';

  const total = latest ? latest.total_steps : 0;
  const done = latest ? latest.completed_steps : 0;
  const started = latest ? new Date(latest.started_at).getTime() : NaN;
  const finished = latest && latest.finished_at ? new Date(latest.finished_at).getTime() : NaN;

  let etaMs = null;
  let eta = '—';
  if (status === 'paused' || status === 'tripped') eta = 'Halted';
  else if (status === 'needs-input') eta = 'Blocked';
  else if (latest && latest.status === 'COMPLETED') eta = 'Done';
  else if (status === 'running' && done > 0 && started >= 0) {
    etaMs = Math.max(0, ((now - started) / done) * (total - done));
    eta = etaMs < 60000 ? '< 1 min' : formatDuration(etaMs).replace(/ 0s$/, '');
  } else if (status === 'running') eta = 'Estimating';

  const finishedRuns = tasks.filter((t) => t.status !== 'RUNNING');
  const succeeded = finishedRuns.filter((t) => t.status === 'COMPLETED').length;

  let objective = 'No task loop has run yet. Ask Elarion or deploy a blueprint to put this agent to work.';
  if (agentId === ELARION_AGENT_ID && !latest) objective = 'Standing by for chat and voice commands.';
  if (latest) objective = describeTask(latest) + (halted && reason ? ' · Breaker: ' + reason : '');

  return {
    agentId,
    ...agentProfile(agentId),
    status,
    pill: PILL_TEXT[status],
    pillKind: PILL_KIND[status],
    halted,
    reason,
    latest,
    objective,
    objectiveTitle: latest ? titleCase(latest.task_id) : agentId === ELARION_AGENT_ID ? 'Master Brain session' : 'Idle',
    progress: total ? Math.round((done / total) * 100) : 0,
    done,
    total,
    eta,
    etaMs,
    startedAt: started >= 0 ? started : null,
    finishedAt: finished >= 0 ? finished : null,
    successRate: finishedRuns.length ? Math.round((succeeded / finishedRuns.length) * 1000) / 10 : null,
    runs: tasks.length,
    tokens: tasks.reduce((sum, t) => sum + (t.total_tokens ? t.total_tokens.input + t.total_tokens.output : 0), 0),
  };
}

// The four-metric operations summary across all agents.
export function summarizeWorkforce(agents, counts, now = Date.now()) {
  const withRuns = agents.filter((a) => a.latest);
  const steps = withRuns.reduce((s, a) => s + a.total, 0);
  const done = withRuns.reduce((s, a) => s + a.done, 0);
  const running = agents.filter((a) => a.status === 'running');
  const etas = running.map((a) => a.etaMs).filter((ms) => ms !== null);
  const c = counts || { running: 0, completed: 0, halted: 0, failed: 0 };
  const totalRuns = c.running + c.completed + c.halted + c.failed;
  let completion = { value: '—', sub: 'nothing running' };
  if (running.length && etas.length === running.length) {
    const at = new Date(now + Math.max(...etas));
    const sameDay = at.toDateString() === new Date(now).toDateString();
    completion = { value: sameDay ? 'Today' : 'Tomorrow', sub: 'at ' + at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
  } else if (running.length) completion = { value: 'Estimating', sub: running.length + ' running' };
  return [
    { key: 'progress', label: 'Overall progress', value: steps ? Math.round((done / steps) * 100) + '%' : '0%', sub: done + ' of ' + steps + ' steps' },
    { key: 'active', label: 'Active workers', value: String(running.length), sub: 'of ' + agents.length + ' assigned' },
    { key: 'completed', label: 'Tasks completed', value: String(c.completed), sub: 'of ' + totalRuns + ' total' },
    { key: 'eta', label: 'Est. completion', value: completion.value, sub: completion.sub },
  ];
}

// Step rows for the Tasks tab: finished steps, then the running / halted / failed step, then queued placeholders.
export function taskRows(record, agent) {
  if (!record) return [];
  const kind = (action) => (action === 'prompt' ? 'API execution' : action === 'wait' ? 'Timed wait' : 'Task execution');
  const rows = record.results.map((r) => ({ id: r.step_id, name: titleCase(r.step_id), sub: kind(r.action) + ' · ' + formatDuration(r.duration_ms), state: 'complete', label: 'Complete' }));
  const next = record.results.length;
  let stepId = null;
  for (let i = record.history.length - 1; i >= 0; i--) {
    if (record.history[i].step_index === next && record.history[i].step_id) {
      stepId = record.history[i].step_id;
      break;
    }
  }
  const name = stepId ? titleCase(stepId) : 'Step ' + (next + 1);
  if (record.status === 'RUNNING') rows.push({ id: stepId || 'step-' + next, name, sub: 'Running now', state: 'running', label: agent && agent.halted ? 'Stopping' : 'Running' });
  if (record.status === 'HALTED') {
    const why = record.halt && record.halt.reason ? record.halt.reason : 'breaker';
    rows.push({ id: stepId || 'step-' + next, name, sub: 'Not run', state: 'tripped', label: 'Auto-tripped · ' + why });
  }
  if (record.status === 'FAILED') rows.push({ id: stepId || 'step-' + next, name, sub: record.failure ? record.failure.error : 'Failed', state: 'failed', label: 'Failed' });
  const shown = rows.length;
  for (let i = shown; i < record.total_steps; i++) rows.push({ id: 'step-' + i, name: 'Step ' + (i + 1), sub: 'Queued', state: 'waiting', label: 'Waiting' });
  return rows;
}

// Activity timeline, newest first.
export function activityItems(record) {
  if (!record) return [];
  return record.history
    .slice()
    .reverse()
    .map((h) => ({
      at: clockTime(h.at),
      title: EVENT_TEXT[h.event] || h.event,
      detail: [h.step_id ? titleCase(h.step_id) : '', h.detail || ''].filter(Boolean).join(' · ') || (h.event === 'STARTED' ? record.total_steps + ' steps queued' : ''),
      kind: h.event === 'STEP_FAILED' || h.event === 'HALTED' ? 'bad' : h.event === 'STEP_STARTED' || h.event === 'STARTED' ? 'spark' : 'ok',
    }));
}

const outputText = (output) => {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    for (const key of ['response', 'text', 'message', 'content']) if (typeof output[key] === 'string') return output[key];
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
};

export function outputLines(record) {
  if (!record || !record.results.length) return [];
  return record.results.map((r) => {
    const text = outputText(r.output);
    return '[' + r.step_id + '] ' + (text.length > 2000 ? text.slice(0, 2000) + '…' : text || '(no output)');
  });
}

export function mountWorkforce(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const portalFetch = options.portalFetch || ((url, init) => win.fetch(url, init));
  const onConnect = options.onConnect || (() => {});
  const onOpenElarion = options.onOpenElarion || (() => {});
  const onAgentsChange = options.onAgentsChange || (() => {});
  const now = options.now || (() => Date.now());

  let destroyed = false;
  let timer = null;
  let ticker = null;
  let loading = false;
  let again = false;
  let bannerTimer = null;
  let agents = [];
  let counts = null;
  let error = null;
  let selectedId = null;
  let detailTab = 'activity';
  let record = null;
  let skills = null;
  let skillsError = null;
  let bridgeResult = [];
  const busy = new Set();
  const signatures = {};

  // --- static skeleton
  const banner = el(doc, 'div', { class: 'wf-banner', role: 'status', hidden: true });
  const projectName = el(doc, 'h2', { class: 'wf-project-name', text: 'Aether Engine workforce' });
  const projectPill = el(doc, 'span', { class: 'pill', 'data-kind': 'queued', text: 'Connecting' });
  const metrics = el(doc, 'div', { class: 'wf-metrics' });
  const overview = el(doc, 'section', { class: 'surface wf-overview', 'aria-label': 'Operations summary' }, [
    el(doc, 'div', { class: 'wf-overview-head' }, [el(doc, 'div', {}, [el(doc, 'p', { class: 'eyebrow', text: 'Project overview' }), projectName]), projectPill]),
    metrics,
  ]);
  const agentCount = el(doc, 'span', { class: 'wf-count', text: '' });
  const cards = el(doc, 'div', { class: 'wf-cards', role: 'list' });
  const refreshBtn = el(doc, 'button', { type: 'button', class: 'icon-btn', 'aria-label': 'Refresh workforce', title: 'Refresh' }, [el(doc, 'span', { 'aria-hidden': 'true', text: '↻' })]);
  const workforce = el(doc, 'section', { class: 'surface wf-workforce', 'aria-label': 'Agent workforce' }, [
    el(doc, 'div', { class: 'wf-section-head' }, [el(doc, 'h2', { text: 'Agent workforce' }), agentCount, el(doc, 'span', { class: 'wf-grow' }), refreshBtn]),
    cards,
  ]);
  const detail = el(doc, 'section', { class: 'surface wf-detail', 'aria-label': 'Selected agent' });
  container.replaceChildren(banner, overview, el(doc, 'div', { class: 'wf-split' }, [workforce, detail]));

  // --- engine calls
  async function act(agentId, fn) {
    if (busy.has(agentId)) return;
    busy.add(agentId);
    render();
    try {
      await fn();
    } catch (e) {
      showBanner(e && e.isUnauthorized ? describeAuthError(e) : 'Breaker request failed: ' + ((e && e.message) || e), 'error');
    } finally {
      busy.delete(agentId);
      refresh();
    }
  }
  const trip = (agentId, reason) => act(agentId, () => api.tripBreaker(agentId, reason));
  const reset = (agentId) => act(agentId, () => api.resetBreaker(agentId));

  function showBanner(text, kind = 'note', withConnect = false) {
    banner.replaceChildren(el(doc, 'span', { text }));
    if (withConnect) {
      const b = el(doc, 'button', { type: 'button', class: 'btn btn-small', text: 'Open connection settings' });
      b.addEventListener('click', () => onConnect());
      banner.append(b);
    }
    banner.dataset.kind = text ? kind : '';
    banner.hidden = !text;
    clearTimeout(bannerTimer);
    // A failed breaker request is reported for a while; connection problems stay until the next good refresh.
    if (text && kind === 'error') bannerTimer = setTimeout(() => showBanner(''), 10000);
  }

  async function loadSkills() {
    if (skills || skillsError === 'loading') return;
    skillsError = 'loading';
    try {
      const res = await portalFetch(SKILLS_ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(res.status === 401 ? 'sign in again to load playbooks' : 'HTTP ' + res.status);
      const body = await res.json();
      skills = Array.isArray(body.skills) ? body.skills : [];
      skillsError = null;
    } catch (e) {
      skillsError = (e && e.message) || String(e);
    }
    if (!destroyed) renderDetail();
  }

  async function refresh() {
    if (destroyed) return;
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    clearTimeout(timer);
    try {
      const list = await api.listTasks({ limit: 100 });
      const byAgent = new Map([[ELARION_AGENT_ID, []]]);
      for (const t of list.tasks) {
        if (!byAgent.has(t.agent_id)) {
          if (byAgent.size >= MAX_AGENTS) continue;
          byAgent.set(t.agent_id, []);
        }
        byAgent.get(t.agent_id).push(t);
      }
      const states = await Promise.all([...byAgent.keys()].map((id) => api.getAgentState(id).catch(() => null)));
      const t = now();
      agents = [...byAgent.entries()].map(([id, tasks], i) => summarizeAgent(id, tasks, states[i], t));
      // Running agents first, then ones that need attention, then the rest; Elarion leads its group.
      const order = { running: 0, 'needs-input': 1, tripped: 1, paused: 2, idle: 3, waiting: 4 };
      agents.sort((a, b) => order[a.status] - order[b.status] || (a.agentId === ELARION_AGENT_ID ? -1 : b.agentId === ELARION_AGENT_ID ? 1 : 0));
      counts = list.counts;
      error = null;
      if (!selectedId || !agents.some((a) => a.agentId === selectedId)) selectedId = agents[0].agentId;
      const selected = agents.find((a) => a.agentId === selectedId);
      record = selected && selected.latest ? await api.getTaskStatus(selected.agentId, selected.latest.task_id).catch(() => null) : null;
      if (banner.dataset.kind !== 'error') showBanner('');
      onAgentsChange(agents, counts);
    } catch (e) {
      error = e;
      if (e && e.isUnreachable) showBanner('The Aether Engine is not reachable (' + api.baseUrl + '). Start it, or point Mission Control at it.', 'warn', true);
      else if (e && e.isUnauthorized) showBanner(describeAuthError(e), 'warn', true);
      else showBanner('Could not load the workforce: ' + ((e && e.message) || e), 'warn');
    } finally {
      loading = false;
    }
    if (destroyed) return;
    render();
    const anyRunning = agents.some((a) => a.status === 'running');
    if (again) {
      again = false;
      timer = setTimeout(refresh, 0);
    } else timer = setTimeout(refresh, error && error.isUnreachable ? IDLE_POLL_MS * 3 : anyRunning ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  // --- rendering. Each region is rebuilt only when its data changed, and focus is put back on the same control.
  function changed(region, data) {
    const sig = JSON.stringify(data);
    if (signatures[region] === sig) return false;
    signatures[region] = sig;
    return true;
  }

  function withFocus(fn) {
    const active = doc.activeElement;
    const key = active && container.contains(active) ? active.getAttribute('data-focus') : null;
    fn();
    if (key) {
      const again = container.querySelector('[data-focus="' + key + '"]');
      if (again) again.focus();
    }
  }

  function pill(kind, text) {
    return el(doc, 'span', { class: 'pill', 'data-kind': kind }, [el(doc, 'span', { class: 'pill-dot', 'aria-hidden': 'true' }), text]);
  }

  function breakerSwitch(agent, label, focusKey) {
    const on = !agent.halted;
    const sw = el(doc, 'button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': String(on),
      'aria-label': label + ' for ' + agent.name,
      'data-focus': focusKey,
      disabled: busy.has(agent.agentId),
    }, [el(doc, 'span', { class: 'switch-knob', 'aria-hidden': 'true' })]);
    sw.addEventListener('click', (event) => {
      event.stopPropagation();
      if (on) trip(agent.agentId, BREAKER_OFF_REASON);
      else reset(agent.agentId);
    });
    return sw;
  }

  function pauseButton(agent, focusKey, long = false) {
    const halted = agent.halted;
    const b = el(doc, 'button', { type: 'button', class: 'btn btn-small' + (long ? ' btn-pause' : ''), 'data-focus': focusKey, disabled: busy.has(agent.agentId) }, [
      el(doc, 'span', { class: 'btn-icon', 'aria-hidden': 'true', text: halted ? '▶' : '❚❚' }),
      (halted ? 'Resume' : 'Pause') + (long ? ' agent' : ''),
    ]);
    b.setAttribute('aria-label', (halted ? 'Resume ' : 'Pause ') + agent.name);
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      if (halted) reset(agent.agentId);
      else trip(agent.agentId, PAUSE_REASON);
    });
    return b;
  }

  function avatar(agent, size = '') {
    return el(doc, 'span', { class: 'avatar ' + size, 'data-tone': agent.halted ? 'rose' : agent.tone, 'aria-hidden': 'true', text: agent.initial });
  }

  function renderOverview() {
    const summary = summarizeWorkforce(agents, counts, now());
    if (!changed('overview', [summary, error ? 'err' : 'ok'])) return;
    const anyRunning = agents.some((a) => a.status === 'running');
    const anyHalted = agents.some((a) => a.halted);
    projectPill.replaceChildren(el(doc, 'span', { class: 'pill-dot', 'aria-hidden': 'true' }), error ? 'Offline' : anyHalted ? 'Breaker tripped' : anyRunning ? 'Running' : 'Idle');
    projectPill.dataset.kind = error ? 'alert' : anyHalted ? 'off' : anyRunning ? 'running' : 'queued';
    metrics.replaceChildren(
      ...summary.map((m) =>
        el(doc, 'div', { class: 'metric', 'data-key': m.key }, [
          el(doc, 'span', { class: 'metric-label', text: m.label }),
          el(doc, 'span', { class: 'metric-row' }, [el(doc, 'span', { class: 'metric-value', text: error ? '—' : m.value }), el(doc, 'span', { class: 'metric-sub', text: error ? '' : m.sub })]),
        ]),
      ),
    );
  }

  function renderCards() {
    const data = agents.map((a) => [a.agentId, a.status, a.progress, a.done, a.total, a.eta, a.objective, a.halted, busy.has(a.agentId)]);
    if (!changed('cards', [data, selectedId])) return;
    agentCount.textContent = agents.length ? agents.length + ' assigned' : '';
    if (!agents.length) {
      cards.replaceChildren(el(doc, 'p', { class: 'empty', text: error ? 'Connect the engine to see your agents.' : 'Loading agents…' }));
      return;
    }
    withFocus(() =>
      cards.replaceChildren(
        ...agents.map((a) => {
          const selected = a.agentId === selectedId;
          const select = el(doc, 'button', { type: 'button', class: 'card-select', 'aria-pressed': String(selected), 'data-focus': 'select:' + a.agentId }, [
            avatar(a),
            el(doc, 'span', { class: 'card-title' }, [el(doc, 'span', { class: 'card-name', text: a.name }), el(doc, 'span', { class: 'card-code', text: a.code })]),
          ]);
          select.addEventListener('click', () => selectAgent(a.agentId));
          const card = el(doc, 'article', { class: 'agent-card', role: 'listitem', 'data-status': a.status, 'data-selected': String(selected) }, [
            el(doc, 'div', { class: 'card-head' }, [select, pill(a.pillKind, a.pill), pauseButton(a, 'pause:' + a.agentId)]),
            el(doc, 'p', { class: 'card-objective', text: a.objective }),
            el(doc, 'div', { class: 'card-progress' }, [
              el(doc, 'span', { class: 'mini-label', text: 'Progress' }),
              el(doc, 'span', { class: 'mini-label', text: a.progress + '%' }),
              el(doc, 'div', { class: 'bar', role: 'progressbar', 'aria-label': a.name + ' progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(a.progress) }, [
                el(doc, 'div', { class: 'bar-fill', 'data-tone': a.halted ? 'rose' : a.status === 'needs-input' ? 'amber' : a.tone, style: 'width:' + a.progress + '%' }),
              ]),
            ]),
            el(doc, 'div', { class: 'card-foot' }, [
              el(doc, 'span', { class: 'foot-cell' }, [el(doc, 'span', { class: 'mini-label', text: 'ETA' }), el(doc, 'span', { class: 'mono', text: a.eta })]),
              el(doc, 'span', { class: 'foot-cell' }, [el(doc, 'span', { class: 'mini-label', text: 'Tasks' }), el(doc, 'span', { class: 'mono', text: a.done + ' / ' + a.total })]),
              el(doc, 'span', { class: 'wf-grow' }),
              el(doc, 'span', { class: 'foot-cell foot-breaker' }, [
                el(doc, 'span', { class: 'mini-label', text: 'API breaker' }),
                el(doc, 'span', { class: 'switch-row' }, [breakerSwitch(a, 'API breaker', 'breaker:' + a.agentId), el(doc, 'span', { class: 'switch-text', text: a.halted ? 'Off' : 'On' })]),
              ]),
            ]),
          ]);
          // Clicking anywhere on the card (not on its controls) selects it, like the card's name button.
          card.addEventListener('click', (event) => {
            if (!event.target.closest('button')) selectAgent(a.agentId);
          });
          return card;
        }),
      ),
    );
  }

  function selectAgent(agentId) {
    if (selectedId === agentId) return;
    selectedId = agentId;
    record = null;
    bridgeResult = [];
    render();
    refresh();
    const narrow = win.matchMedia && win.matchMedia('(max-width: 1100px)').matches;
    if (narrow && detail.scrollIntoView) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function tabButton(id, label, count) {
    const active = detailTab === id;
    const b = el(doc, 'button', { type: 'button', role: 'tab', id: 'wf-tab-' + id, 'aria-selected': String(active), 'aria-controls': 'wf-pane', tabindex: active ? '0' : '-1', 'data-focus': 'tab:' + id }, [
      label,
      count !== undefined ? el(doc, 'span', { class: 'tab-count', text: String(count) }) : null,
    ]);
    b.addEventListener('click', () => setTab(id));
    b.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      setTab(DETAIL_TABS[(DETAIL_TABS.indexOf(id) + step + DETAIL_TABS.length) % DETAIL_TABS.length], true);
    });
    return b;
  }

  function setTab(id, focus = false) {
    detailTab = id;
    if (id === 'skills') loadSkills();
    renderDetail(true);
    if (focus) {
      const b = detail.querySelector('#wf-tab-' + id);
      if (b) b.focus();
    }
  }

  function renderActivity(agent) {
    const items = activityItems(record);
    const live = agent.status === 'running';
    const head = el(doc, 'div', { class: 'pane-head' }, [el(doc, 'h3', { text: 'Live activity' }), live ? el(doc, 'span', { class: 'live-note' }, [el(doc, 'span', { class: 'pill-dot', 'aria-hidden': 'true' }), 'Updating now']) : null]);
    if (!items.length) return [head, el(doc, 'p', { class: 'empty', text: agent.latest ? 'Loading the run timeline…' : 'No runs yet for ' + agent.name + '.' })];
    return [
      head,
      el(doc, 'ol', { class: 'timeline' }, items.map((i) =>
        el(doc, 'li', { class: 'tl-item', 'data-kind': i.kind }, [
          el(doc, 'span', { class: 'tl-mark', 'aria-hidden': 'true', text: i.kind === 'ok' ? '✓' : i.kind === 'bad' ? '!' : '✦' }),
          el(doc, 'span', { class: 'tl-time mono', text: i.at }),
          el(doc, 'span', { class: 'tl-body' }, [el(doc, 'span', { class: 'tl-title', text: i.title }), i.detail ? el(doc, 'span', { class: 'tl-detail', text: i.detail }) : null]),
        ]),
      )),
    ];
  }

  function renderTasks(agent) {
    const rows = taskRows(record, agent);
    if (!rows.length) return [el(doc, 'p', { class: 'empty', text: agent.latest ? 'Loading steps…' : 'No task loop has run for ' + agent.name + ' yet.' })];
    return [
      el(doc, 'ul', { class: 'checklist' }, rows.map((r) => {
        // Only a running step (switch off: trip this agent's breaker) and a tripped step (switch on: reset it) map to
        // engine controls; finished and queued steps show their state.
        const interactive = r.state === 'running' || r.state === 'tripped';
        const on = r.state !== 'tripped' && r.state !== 'failed';
        const sw = el(doc, 'button', {
          type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': r.name + (interactive ? (on ? ': trip breaker' : ': reset breaker') : ''),
          disabled: !interactive || busy.has(agent.agentId), 'data-focus': 'step:' + r.id,
          title: interactive ? (on ? 'Stop this agent before its next step' : 'Reset the breaker so the agent can run again') : r.label,
        }, [el(doc, 'span', { class: 'switch-knob', 'aria-hidden': 'true' })]);
        if (interactive) sw.addEventListener('click', () => (on ? trip(agent.agentId, 'Step ' + r.id + ' switched off from Mission Control') : reset(agent.agentId)));
        return el(doc, 'li', { class: 'check-row', 'data-state': r.state }, [
          el(doc, 'span', { class: 'check-mark', 'aria-hidden': 'true', text: r.state === 'complete' ? '✓' : '' }),
          el(doc, 'span', { class: 'check-body' }, [el(doc, 'span', { class: 'check-name', text: r.name }), el(doc, 'span', { class: 'check-sub', text: r.sub })]),
          el(doc, 'span', { class: 'check-label', text: r.label }),
          sw,
        ]);
      })),
    ];
  }

  function renderOutput(agent) {
    const lines = outputLines(record);
    return [
      el(doc, 'div', { class: 'terminal' }, [
        el(doc, 'div', { class: 'terminal-head' }, [el(doc, 'span', { 'aria-hidden': 'true', text: '>_' }), el(doc, 'span', { text: 'agent.output' })]),
        el(doc, 'pre', { class: 'terminal-body', tabindex: '0', 'aria-label': agent.name + ' output', text: lines.length ? lines.join('\n') : agent.latest ? 'Waiting for the first step to finish…' : 'No output yet.' }),
      ]),
    ];
  }

  function renderSkills() {
    if (!skills) {
      return [el(doc, 'p', { class: 'empty', text: skillsError && skillsError !== 'loading' ? 'Could not load the AEPS playbooks: ' + skillsError + '.' : 'Loading AEPS playbooks…' })];
    }
    const head = el(doc, 'div', { class: 'pane-head' }, [el(doc, 'h3', { text: 'AEPS skills registry' }), el(doc, 'span', { class: 'mini-label', text: skills.length + ' linked' })]);
    if (!skills.length) {
      return [head, el(doc, 'div', { class: 'empty' }, [
        el(doc, 'p', { text: 'No SKILL.md playbooks are linked yet.' }),
        el(doc, 'p', { text: 'Link skill folders under .aether/skills/AEPS/ in the portal repo, then redeploy; each SKILL.md shows up here.' }),
      ])];
    }
    return [head, el(doc, 'ul', { class: 'skills' }, skills.map((s) =>
      el(doc, 'li', { class: 'skill' }, [
        el(doc, 'details', {}, [
          el(doc, 'summary', {}, [
            el(doc, 'span', { class: 'skill-icon', 'aria-hidden': 'true', text: '§' }),
            el(doc, 'span', { class: 'skill-text' }, [
              el(doc, 'span', { class: 'skill-name', text: s.name + (s.version ? ' · v' + s.version : '') }),
              el(doc, 'span', { class: 'skill-desc', text: s.description || 'No description in the front matter.' }),
              el(doc, 'span', { class: 'skill-path mono', text: s.path }),
            ]),
          ]),
          el(doc, 'pre', { class: 'skill-body', text: s.body || '' }),
        ]),
      ]),
    ))];
  }

  function renderBridge(agent) {
    const base = api.baseUrl;
    const id = encodeURIComponent(agent.agentId);
    const endpoints = [
      ['GET', '/api/agents/' + id + '/state', 'Read breaker state'],
      ['GET', '/api/tasks?agent_id=' + id, 'Read task runs'],
      ['POST', '/api/agents/execute-task', 'Run a task loop (agent_id, task_id, steps)'],
      ['POST', '/api/agents/trip-breaker', 'Halt (agent_id, reason)'],
      ['POST', '/api/agents/reset', 'Resume (agent_id)'],
    ];
    if (agent.agentId === ELARION_AGENT_ID) endpoints.splice(2, 0, ['POST', '/api/master-brain/chat', 'Elarion chat turn (session_id, message)']);
    const cli = [
      'export AETHER_ENGINE=' + base,
      'curl -s "$AETHER_ENGINE/api/agents/' + id + '/state" -H "Authorization: Bearer $AETHER_ENGINE_JWT"',
      'curl -s -X POST "$AETHER_ENGINE/api/agents/execute-task" -H "Authorization: Bearer $AETHER_ENGINE_JWT" -H "Content-Type: application/json" -d \'{"agent_id":"' + agent.agentId + '","task_id":"cli-run","steps":[{"step_id":"hello","action":"echo"}]}\'',
    ].join('\n');
    const test = el(doc, 'button', { type: 'button', class: 'btn btn-small', 'data-focus': 'bridge:test', text: 'Test bridge' });
    test.addEventListener('click', async () => {
      bridgeResult = [{ ok: null, text: 'Testing ' + base + ' …' }];
      renderDetail(true);
      const results = [];
      try {
        const h = await api.getEngineHealth();
        results.push({ ok: true, text: 'GET /health → ' + h.status + ' (' + h.system + ')' });
      } catch (e) {
        results.push({ ok: false, text: 'GET /health → ' + ((e && e.message) || e) });
      }
      try {
        const s = await api.getAgentState(agent.agentId);
        results.push({ ok: true, text: 'GET /api/agents/' + agent.agentId + '/state → ' + s.state + (s.reason ? ' (' + s.reason + ')' : '') });
      } catch (e) {
        results.push({ ok: false, text: 'GET state → ' + (e && e.isUnauthorized ? describeAuthError(e) : (e && e.message) || e) });
      }
      bridgeResult = results;
      if (!destroyed) renderDetail(true);
    });
    const change = el(doc, 'button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Change engine' });
    change.addEventListener('click', () => onConnect());
    const chat = agent.agentId === ELARION_AGENT_ID ? el(doc, 'button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Open Elarion chat' }) : null;
    if (chat) chat.addEventListener('click', () => onOpenElarion());
    return [
      el(doc, 'div', { class: 'pane-head' }, [el(doc, 'h3', { text: 'Elarion API bridge' }), el(doc, 'span', { class: 'mini-label', text: 'state reads & writes' })]),
      el(doc, 'dl', { class: 'bridge-facts' }, [
        el(doc, 'dt', { text: 'Engine' }), el(doc, 'dd', { class: 'mono', text: base }),
        el(doc, 'dt', { text: 'Agent id' }), el(doc, 'dd', { class: 'mono', text: agent.agentId }),
        el(doc, 'dt', { text: 'Auth' }), el(doc, 'dd', { text: 'Bearer JWT minted by the portal (or the engine’s local bypass)' }),
      ]),
      el(doc, 'ul', { class: 'endpoints' }, endpoints.map(([method, path, what]) =>
        el(doc, 'li', {}, [el(doc, 'span', { class: 'method', 'data-method': method, text: method }), el(doc, 'code', { class: 'mono', text: path }), el(doc, 'span', { class: 'endpoint-what', text: what })]),
      )),
      el(doc, 'div', { class: 'bridge-actions' }, [test, change, chat]),
      bridgeResult.length ? el(doc, 'ul', { class: 'bridge-results', 'aria-live': 'polite' }, bridgeResult.map((r) => el(doc, 'li', { 'data-ok': String(r.ok), text: r.text }))) : null,
      el(doc, 'div', { class: 'terminal' }, [
        el(doc, 'div', { class: 'terminal-head' }, [el(doc, 'span', { 'aria-hidden': 'true', text: '>_' }), el(doc, 'span', { text: 'Elarion CLI · bridge hook' })]),
        el(doc, 'pre', { class: 'terminal-body', tabindex: '0', text: cli }),
      ]),
    ];
  }

  function renderDetail(force = false) {
    const agent = agents.find((a) => a.agentId === selectedId);
    const recordSig = record ? [record.run_id, record.status, record.results.length, record.history.length] : null;
    const sig = [agent && { ...agent, tokens: 0 }, recordSig, detailTab, skills && skills.length, skillsError, bridgeResult, agent && busy.has(agent.agentId)];
    if (!changed('detail', sig) && !force) return;
    if (!agent) {
      detail.replaceChildren(el(doc, 'p', { class: 'empty', text: error ? 'No agent data while the engine is offline.' : 'Select an agent to see its activity.' }));
      return;
    }
    let pane;
    if (detailTab === 'tasks') pane = renderTasks(agent);
    else if (detailTab === 'output') pane = renderOutput(agent);
    else if (detailTab === 'skills') pane = renderSkills();
    else if (detailTab === 'bridge') pane = renderBridge(agent);
    else pane = renderActivity(agent);

    const emergency = el(doc, 'button', {
      type: 'button', class: 'btn btn-danger', role: 'switch', 'aria-checked': String(agent.halted), 'data-focus': 'emergency', disabled: busy.has(agent.agentId),
    }, [el(doc, 'span', { class: 'switch switch-danger', 'aria-hidden': 'true' }, [el(doc, 'span', { class: 'switch-knob' })]), agent.halted ? 'Restart' : 'Shut down']);
    emergency.setAttribute('aria-label', agent.halted ? 'Restart ' + agent.name : 'Emergency shut down ' + agent.name);
    emergency.addEventListener('click', () => (agent.halted ? reset(agent.agentId) : trip(agent.agentId, EMERGENCY_REASON)));

    withFocus(() =>
      detail.replaceChildren(
        el(doc, 'div', { class: 'detail-head' }, [
          avatar(agent, 'avatar-lg'),
          el(doc, 'div', { class: 'detail-title' }, [
            el(doc, 'div', { class: 'detail-name-row' }, [el(doc, 'h2', { text: agent.name }), pill(agent.pillKind, agent.pill)]),
            el(doc, 'span', { class: 'detail-sub', text: agent.code + ' · ' + agent.role }),
          ]),
        ]),
        el(doc, 'div', { class: 'objective' }, [
          el(doc, 'span', { class: 'objective-icon', 'aria-hidden': 'true', text: '>_' }),
          el(doc, 'div', {}, [
            el(doc, 'p', { class: 'eyebrow eyebrow-accent', text: 'Current objective' }),
            el(doc, 'p', { class: 'objective-title', text: agent.objectiveTitle }),
            el(doc, 'p', { class: 'objective-text', text: agent.objective }),
          ]),
        ]),
        el(doc, 'div', { class: 'detail-stats' }, [
          el(doc, 'div', { class: 'dstat' }, [el(doc, 'span', { class: 'mini-label', text: 'Runtime' }), el(doc, 'span', { class: 'mono dstat-value', 'data-runtime': '', text: runtimeText(agent) })]),
          el(doc, 'div', { class: 'dstat' }, [el(doc, 'span', { class: 'mini-label', text: 'Current task' }), el(doc, 'span', { class: 'mono dstat-value', text: agent.done + ' / ' + agent.total })]),
          el(doc, 'div', { class: 'dstat' }, [el(doc, 'span', { class: 'mini-label', text: 'Success rate' }), el(doc, 'span', { class: 'mono dstat-value', text: agent.successRate === null ? '—' : agent.successRate + '%' })]),
          pauseButton(agent, 'detail-pause', true),
        ]),
        el(doc, 'div', { class: 'subtabs', role: 'tablist', 'aria-label': agent.name + ' details' }, [
          tabButton('activity', 'Activity'),
          tabButton('tasks', 'Tasks', record ? record.total_steps : agent.total),
          tabButton('output', 'Output'),
          tabButton('skills', 'Skills', skills ? skills.length : undefined),
          tabButton('bridge', 'API Bridge'),
        ]),
        el(doc, 'div', { class: 'pane', id: 'wf-pane', role: 'tabpanel', 'aria-labelledby': 'wf-tab-' + detailTab }, pane),
        el(doc, 'div', { class: 'emergency' }, [
          el(doc, 'span', { class: 'emergency-icon', 'aria-hidden': 'true' }, [el(doc, 'span')]),
          el(doc, 'div', { class: 'emergency-text' }, [
            el(doc, 'p', { class: 'emergency-title', text: 'Emergency breaker' }),
            el(doc, 'p', { class: 'emergency-sub', text: agent.halted ? 'Halted' + (agent.reason ? ': ' + agent.reason : '') + '. Restart to let it run again.' : 'Immediately halt this agent and preserve its current state.' }),
          ]),
          emergency,
        ]),
      ),
    );
  }

  function runtimeText(agent) {
    if (!agent.startedAt) return '—';
    return formatClock((agent.status === 'running' ? now() : agent.finishedAt || now()) - agent.startedAt);
  }

  function render() {
    renderOverview();
    renderCards();
    renderDetail();
  }

  // The runtime counter ticks every second without rebuilding the panel.
  ticker = setInterval(() => {
    const agent = agents.find((a) => a.agentId === selectedId);
    const cell = detail.querySelector('[data-runtime]');
    if (agent && cell && agent.status === 'running') cell.textContent = runtimeText(agent);
  }, 1000);

  refreshBtn.addEventListener('click', () => refresh());
  // Trips and resets from anywhere on the page (header breaker, Elarion) refresh the cards. State reads are skipped:
  // refresh() makes them itself.
  const offState = onEngineState((detail) => {
    if (detail.source === 'state') return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 50);
  });
  const onVisibility = () => {
    if (!doc.hidden) refresh();
  };
  doc.addEventListener('visibilitychange', onVisibility);

  render();
  refresh();

  return {
    refresh,
    selectAgent,
    setTab,
    getAgents: () => agents,
    getSelected: () => selectedId,
    elements: { banner, metrics, cards, detail },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      clearInterval(ticker);
      clearTimeout(bannerTimer);
      offState();
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
