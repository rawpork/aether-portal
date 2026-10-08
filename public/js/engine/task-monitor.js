// Agent task loop monitor for Mission Control: live progress of sub-agent task runs (GET /api/tasks) and project
// status from compiled blueprints (GET /api/artifacts). Polls every 2s while any task is RUNNING, every 5s otherwise,
// and at once when an agent's breaker state changes. Selecting a task shows its step timeline
// (GET /api/agents/:agentId/tasks/:taskId), refreshed while it runs.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';
import { agentName, groupConsecutive, projectTitle, repeatsText, statusLabel, taskTitle } from './labels.js';

export const ACTIVE_POLL_MS = 2000;
export const IDLE_POLL_MS = 5000;
export const PROJECTS_REFRESH_MS = 30000;
export const MAX_PROJECTS = 6;

const STAT_LABELS = { running: 'Active', completed: 'Completed', halted: 'Halted', failed: 'Failed', tokens: 'Tokens used' };

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

export function formatDuration(ms) {
  if (!(ms >= 0)) return '';
  if (ms < 1000) return ms + 'ms';
  const seconds = ms / 1000;
  if (seconds < 60) return seconds.toFixed(seconds < 10 ? 1 : 0) + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + Math.round(seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

export function formatAgo(iso, now = Date.now()) {
  const diff = now - new Date(iso).getTime();
  if (!(diff >= 0)) return '';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

const tokensText = (t) => t.input.toLocaleString() + ' in / ' + t.output.toLocaleString() + ' out';

// One line describing where a task stands.
export function describeTask(task) {
  switch (task.status) {
    case 'RUNNING':
      return task.current_step ? 'Running step ' + (task.current_step.index + 1) + ': ' + task.current_step.step_id : 'Starting';
    case 'COMPLETED':
      return 'All ' + task.total_steps + ' steps done';
    case 'HALTED':
      return 'Halted before step ' + ((task.interrupted_step_index ?? task.completed_steps) + 1) + (task.halt && task.halt.reason ? ': ' + task.halt.reason : '');
    case 'FAILED':
      return 'Failed at step ' + ((task.failure ? task.failure.step_index : task.completed_steps) + 1) + (task.failure ? ': ' + task.failure.error : '');
    default:
      return statusLabel(task.status);
  }
}

// Step rows for an expanded task: finished steps from its results, then the running / halted / failed step, then
// how many are still queued (the engine does not report queued step ids).
export function buildStepRows(record) {
  const rows = record.results.map((r) => ({
    state: 'done',
    name: r.step_id + ' · ' + r.action,
    detail: formatDuration(r.duration_ms) + (r.tokens.input || r.tokens.output ? ' · ' + tokensText(r.tokens) : ''),
  }));
  const next = record.results.length;
  let stepId = null;
  for (let i = record.history.length - 1; i >= 0; i--) {
    if (record.history[i].step_index === next) {
      stepId = record.history[i].step_id;
      break;
    }
  }
  if (record.status === 'RUNNING' && stepId) rows.push({ state: 'running', name: stepId, detail: 'running' });
  if (record.status === 'HALTED') rows.push({ state: 'halted', name: stepId || 'step ' + (next + 1), detail: 'not run: breaker tripped' });
  if (record.status === 'FAILED') rows.push({ state: 'failed', name: stepId || 'step ' + (next + 1), detail: record.failure ? record.failure.error : 'failed' });
  const accounted = rows.length;
  const queued = record.total_steps - accounted;
  if (queued > 0) rows.push({ state: 'queued', name: queued + (queued === 1 ? ' more step' : ' more steps') + (record.status === 'RUNNING' ? ' queued' : ' not run'), detail: '' });
  return rows;
}

// Consecutive identical step rows read once with a count: "echo · echo ×3".
export function collapseRepeats(rows) {
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.state === row.state && last.baseName === row.name && last.detail === row.detail) {
      last.count += 1;
      last.name = last.baseName + ' ×' + last.count;
    } else out.push({ ...row, baseName: row.name, count: 1 });
  }
  return out.map(({ baseName, count, ...row }) => row);
}

const STEP_MARKS = { done: '✓', running: '●', halted: '⏸', failed: '✕', queued: '○' };

export function mountTaskMonitor(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const statusEl = options.statusEl || null;
  const activePollMs = options.activePollMs || ACTIVE_POLL_MS;
  const idlePollMs = options.idlePollMs || IDLE_POLL_MS;
  const projectsRefreshMs = options.projectsRefreshMs || PROJECTS_REFRESH_MS;
  const now = options.now || Date.now;
  const onOpenProject = options.onOpenProject || null;

  let tasks = [];
  let timer = null;
  let polling = false;
  let destroyed = false;
  let lastProjects = 0;
  const rows = new Map(); // key -> { item, refs }
  const expanded = new Map(); // key -> latest TaskRecord (or null while loading)

  // --- layout
  const stats = {};
  const statsRow = el(doc, 'div', { class: 'mc-stats', role: 'group', 'aria-label': 'Task totals' });
  for (const kind of Object.keys(STAT_LABELS)) {
    stats[kind] = el(doc, 'span', { class: 'mc-stat-value', text: '0' });
    statsRow.append(el(doc, 'div', { class: 'mc-stat', 'data-kind': kind }, [stats[kind], el(doc, 'span', { class: 'mc-stat-label', text: STAT_LABELS[kind] })]));
  }
  const taskList = el(doc, 'ul', { class: 'mc-list', 'aria-label': 'Task runs' });
  const taskEmpty = el(doc, 'p', { class: 'mc-empty', text: 'No task runs yet. Tasks sent to /api/agents/execute-task appear here with live progress.' });
  const projectList = el(doc, 'ul', { class: 'mc-list', 'aria-label': 'Projects' });
  const projectEmpty = el(doc, 'p', { class: 'mc-empty', text: 'No compiled blueprints yet.' });
  container.replaceChildren(
    statsRow,
    el(doc, 'section', { class: 'mc-section', 'aria-label': 'Tasks' }, [el(doc, 'h2', { text: 'Tasks' }), taskEmpty, taskList]),
    el(doc, 'section', { class: 'mc-section', 'aria-label': 'Projects' }, [el(doc, 'h2', { text: 'Projects' }), projectEmpty, projectList]),
  );

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // --- tasks
  const keyOf = (task) => task.agent_id + '/' + task.task_id;
  // Folded groups of repeated runs the operator opened, so a poll's rebuild keeps them open.
  const openGroups = new Set();
  // Project names by blueprint id, from the last artifacts list, so a deploy task reads "Deploy: <project>".
  let projectNames = new Map();
  const projectNameFor = (id) => projectNames.get(id) || '';

  function createRow(key, task) {
    const chip = el(doc, 'span', { class: 'mc-chip' });
    const name = el(doc, 'span', { class: 'mc-task-name' });
    const time = el(doc, 'span', { class: 'mc-task-time' });
    const progress = el(doc, 'div', { class: 'mc-progress', role: 'progressbar', 'aria-valuemin': '0' });
    const fill = el(doc, 'div', { class: 'mc-progress-fill' });
    progress.append(fill);
    const where = el(doc, 'span', { class: 'mc-task-where' });
    const counts = el(doc, 'span', { class: 'mc-task-counts' });
    const tokens = el(doc, 'span', { class: 'mc-task-tokens' });
    const head = el(doc, 'button', { type: 'button', class: 'mc-task-head', 'aria-expanded': 'false' }, [
      chip,
      name,
      time,
      progress,
      el(doc, 'span', { class: 'mc-task-line' }, [counts, where, tokens]),
    ]);
    const steps = el(doc, 'ol', { class: 'mc-steps', hidden: true, 'aria-label': 'Steps of ' + taskTitle(task.task_id, projectNameFor) });
    const item = el(doc, 'li', { class: 'mc-task' }, [head, steps]);
    const refs = { chip, name, time, progress, fill, where, counts, tokens, head, steps };
    head.addEventListener('click', () => toggleDetail(key, rows.get(key).task));
    return { item, refs, task };
  }

  function updateRow(row, task) {
    const { refs } = row;
    row.task = task;
    row.item.dataset.status = task.status;
    refs.chip.dataset.status = task.status;
    refs.chip.textContent = statusLabel(task.status);
    refs.name.replaceChildren(doc.createTextNode(taskTitle(task.task_id, projectNameFor) + ' '), el(doc, 'span', { class: 'mc-task-agent', text: '· ' + agentName(task.agent_id) }));
    refs.name.title = task.agent_id + '/' + task.task_id;
    // How long it took and how long ago, in words: "14ms · 2d ago", not a clock time to work out.
    const ago = formatAgo(task.status === 'RUNNING' ? task.started_at : task.finished_at || task.started_at, now());
    refs.time.textContent =
      task.status === 'RUNNING' ? 'started ' + ago : formatDuration(new Date(task.finished_at).getTime() - new Date(task.started_at).getTime()) + (ago ? ' · ' + ago : '');
    refs.time.title = 'Started ' + new Date(task.started_at).toLocaleString();
    const pct = task.total_steps ? Math.round((task.completed_steps / task.total_steps) * 100) : 0;
    refs.fill.style.width = pct + '%';
    refs.progress.setAttribute('aria-valuemax', String(task.total_steps));
    refs.progress.setAttribute('aria-valuenow', String(task.completed_steps));
    refs.progress.setAttribute('aria-label', task.completed_steps + ' of ' + task.total_steps + ' steps complete');
    refs.counts.textContent = task.completed_steps + '/' + task.total_steps + ' steps';
    refs.where.textContent = describeTask(task);
    refs.tokens.textContent = task.total_tokens.input || task.total_tokens.output ? tokensText(task.total_tokens) : '';
  }

  function renderTasks(list) {
    tasks = list;
    taskEmpty.hidden = list.length > 0;
    const seen = new Set();
    // Last render's folded groups come apart first; the rows inside them are put back below, in order.
    for (const group of taskList.querySelectorAll('.mc-task-group')) group.remove();
    for (const task of list) {
      const key = keyOf(task);
      seen.add(key);
      let row = rows.get(key);
      if (!row) {
        row = createRow(key, task);
        rows.set(key, row);
      }
      updateRow(row, task);
    }
    // Runs of identical tasks (same name, agent, outcome and step count) show their newest one, with the repeats folded under it.
    const sameRun = (t) => [taskTitle(t.task_id, projectNameFor), t.agent_id, t.status, t.total_steps, t.completed_steps].join('|');
    for (const group of groupConsecutive(list, sameRun)) {
      // Appending an existing node moves it, which keeps rows in the engine's newest-first order.
      taskList.append(rows.get(keyOf(group.lead)).item);
      if (!group.rest.length) continue;
      const leadKey = keyOf(group.lead);
      const inner = el(doc, 'ul', { class: 'mc-task-sub' }, group.rest.map((t) => rows.get(keyOf(t)).item));
      const details = el(doc, 'details', { class: 'mc-repeats' }, [el(doc, 'summary', { text: repeatsText(group.rest.length, 'run') }), inner]);
      if (openGroups.has(leadKey)) details.open = true;
      details.addEventListener('toggle', () => (details.open ? openGroups.add(leadKey) : openGroups.delete(leadKey)));
      taskList.append(el(doc, 'li', { class: 'mc-task-group' }, [details]));
    }
    for (const [key, row] of rows) {
      if (seen.has(key)) continue;
      row.item.remove();
      rows.delete(key);
      expanded.delete(key);
    }
  }

  function renderStats(list, counts) {
    stats.running.textContent = String(counts.running);
    stats.completed.textContent = String(counts.completed);
    stats.halted.textContent = String(counts.halted);
    stats.failed.textContent = String(counts.failed);
    const total = list.reduce((sum, t) => sum + t.total_tokens.input + t.total_tokens.output, 0);
    stats.tokens.textContent = total.toLocaleString();
  }

  function renderSteps(key) {
    const row = rows.get(key);
    const record = expanded.get(key);
    if (!row) return;
    const { steps, head } = row.refs;
    steps.hidden = !expanded.has(key);
    head.setAttribute('aria-expanded', String(expanded.has(key)));
    if (!expanded.has(key)) return;
    if (!record) {
      steps.replaceChildren(el(doc, 'li', { class: 'mc-step', text: 'Loading steps…' }));
      return;
    }
    if (record.error) {
      steps.replaceChildren(el(doc, 'li', { class: 'mc-step', 'data-state': 'failed', text: 'Could not load steps: ' + (record.error.message || 'engine error') }));
      return;
    }
    steps.replaceChildren(
      ...collapseRepeats(buildStepRows(record)).map((s) =>
        el(doc, 'li', { class: 'mc-step', 'data-state': s.state }, [
          el(doc, 'span', { class: 'mc-step-mark', 'aria-hidden': 'true', text: STEP_MARKS[s.state] }),
          el(doc, 'span', { class: 'mc-step-name', text: s.name }),
          el(doc, 'span', { class: 'mc-step-detail', text: s.detail }),
        ]),
      ),
    );
  }

  async function loadDetail(key, task) {
    try {
      const record = await api.getTaskStatus(task.agent_id, task.task_id);
      if (expanded.has(key)) expanded.set(key, record);
    } catch (error) {
      if (expanded.has(key)) expanded.set(key, { results: [], history: [], total_steps: 0, status: 'ERROR', error });
    }
    renderSteps(key);
  }

  function toggleDetail(key, task) {
    if (expanded.has(key)) {
      expanded.delete(key);
      renderSteps(key);
      return;
    }
    expanded.set(key, null);
    renderSteps(key);
    loadDetail(key, task);
  }

  // --- projects
  function renderProjects(artifacts) {
    projectNames = new Map(artifacts.filter((a) => a.project_name).map((a) => [a.blueprint_id, a.project_name]));
    const latest = [...artifacts].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, MAX_PROJECTS);
    projectEmpty.hidden = latest.length > 0;
    const projectItem = (a) => {
      const parts = [
        el(doc, 'span', { class: 'mc-project-name', text: projectTitle(a) }),
        el(doc, 'span', { class: 'mc-chip', 'data-status': a.status, text: statusLabel(a.status) }),
        el(doc, 'span', { class: 'mc-project-meta', text: a.created_at ? 'Compiled ' + formatAgo(a.created_at, now()) : '' }),
      ];
      if (!onOpenProject) return el(doc, 'li', { class: 'mc-project' }, parts);
      const button = el(doc, 'button', { type: 'button', class: 'mc-project mc-project-link', title: 'Open in Blueprints' }, parts);
      button.addEventListener('click', () => onOpenProject(a.blueprint_id));
      return el(doc, 'li', {}, [button]);
    };
    // Five compiles of the same blueprint are one project with earlier versions, not five identical rows.
    projectList.replaceChildren(
      ...groupConsecutive(latest, (a) => projectTitle(a) + '|' + a.status).flatMap((group) => {
        const rowsOut = [projectItem(group.lead)];
        if (group.rest.length) {
          const details = el(doc, 'details', { class: 'mc-repeats' }, [el(doc, 'summary', { text: repeatsText(group.rest.length, 'version') }), el(doc, 'ul', { class: 'mc-project-sub' }, group.rest.map(projectItem))]);
          rowsOut.push(el(doc, 'li', { class: 'mc-project-group' }, [details]));
        }
        return rowsOut;
      }),
    );
  }

  // --- polling
  function schedule() {
    clearTimeout(timer);
    if (destroyed) return;
    timer = setTimeout(poll, tasks.some((t) => t.status === 'RUNNING') ? activePollMs : idlePollMs);
  }

  async function poll() {
    if (destroyed || polling) return;
    if (doc.hidden) return schedule();
    polling = true;
    try {
      const { tasks: list, counts } = await api.listTasks();
      renderTasks(list);
      renderStats(list, counts);
      for (const [key] of expanded) {
        const row = rows.get(key);
        if (row && (row.task.status === 'RUNNING' || expanded.get(key)?.status === 'RUNNING')) loadDetail(key, row.task);
      }
      if (now() - lastProjects >= projectsRefreshMs) {
        lastProjects = now();
        const { artifacts } = await api.listArtifacts();
        renderProjects(artifacts);
      }
      setStatus(counts.running ? counts.running + ' running · live' : 'Up to date');
    } catch (error) {
      if (error && error.isUnreachable) setStatus('Engine offline · retrying');
      else if (error && error.isUnauthorized) setStatus(describeAuthError(error));
      else setStatus((error && error.message) || 'Engine error');
    } finally {
      polling = false;
      schedule();
    }
  }

  // A trip or reset changes what running tasks will do next; look now rather than at the next tick.
  const unsubscribe = onEngineState((detail) => {
    if (detail.source !== 'state') poll();
  });
  function onVisibility() {
    if (!doc.hidden) poll();
  }
  doc.addEventListener('visibilitychange', onVisibility);

  setStatus('Connecting…');
  poll();

  return {
    refresh: poll,
    getTasks: () => tasks,
    elements: { statsRow, taskList, taskEmpty, projectList, projectEmpty, stats },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      unsubscribe();
      doc.removeEventListener('visibilitychange', onVisibility);
      container.replaceChildren();
    },
  };
}
