// Operator Console for Mission Control: two panes over the engine's task runs.
// - Activity (left): an auto-scrolling log of what the agents are doing: runs starting, each step starting and
//   finishing (with a line of what a model step said), questions asked, the operator's answers, halts and failures.
//   It follows the newest line unless the operator has scrolled up to read.
// - Waiting for you (right): every choice step a task is paused on (engine `choice` action), as numbered chips
//   [1] [2] [3]. A chip, or its number key while the pane has focus, answers it straight away
//   (POST /api/agents/:agentId/tasks/:taskId/choice) and the task carries on.
// Polls GET /api/tasks every 2 s while anything runs (5 s otherwise) and reads the records of recent runs for their
// step history.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';
import { agentName, taskTitle } from './labels.js';
import { pollDelay } from './poll-rate.js';

export const ACTIVE_POLL_MS = 2000;
export const IDLE_POLL_MS = 5000;
// Finished runs stay in the log's feed this long after they end.
export const RECENT_MS = 10 * 60 * 1000;
export const MAX_FOLLOWED_RUNS = 6;
export const MAX_LOG_LINES = 400;
const OUTPUT_SNIPPET_CHARS = 160;

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

// What went wrong, in the Task Monitor's words.
export function describeEngineError(error) {
  if (error && error.isUnreachable) return 'Engine offline · retrying';
  if (error && error.isUnauthorized) return describeAuthError(error);
  return String((error && error.body && error.body.error) || (error && error.message) || 'Engine error');
}

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

// A short line for a finished step's output: what a model said, a choice made, or the output as JSON.
export function outputSnippet(output) {
  if (output == null) return '';
  if (typeof output === 'string') return clip(output.replace(/\s+/g, ' ').trim(), OUTPUT_SNIPPET_CHARS);
  if (typeof output.response === 'string') return clip(output.response.replace(/\s+/g, ' ').trim(), OUTPUT_SNIPPET_CHARS);
  if (typeof output.choice === 'string') return 'chose [' + output.option + '] ' + output.choice;
  try {
    return clip(JSON.stringify(output), OUTPUT_SNIPPET_CHARS);
  } catch {
    return '';
  }
}

// The log lines one task record contributes, each with a stable key so a poll only appends what is new.
// { key, at, kind, text }.
export function recordLines(record) {
  const who = agentName(record.agent_id) + ' / ' + taskTitle(record.task_id);
  const run = record.run_id;
  const resultByIndex = new Map((record.results || []).map((r) => [r.step_index, r]));
  const lines = [];
  (record.history || []).forEach((entry, i) => {
    const key = run + ':h' + i;
    const step = entry.step_index !== undefined ? 'step ' + (entry.step_index + 1) + ' (' + entry.step_id + ')' : '';
    switch (entry.event) {
      case 'STARTED':
        lines.push({ key, at: entry.at, kind: 'start', text: who + ' started' + (entry.detail ? ' · ' + entry.detail : '') });
        break;
      case 'STEP_STARTED':
        lines.push({ key, at: entry.at, kind: 'step', text: who + ' · ' + step + ' running' });
        break;
      case 'STEP_COMPLETED': {
        const result = resultByIndex.get(entry.step_index);
        const snippet = result ? outputSnippet(result.output) : '';
        lines.push({ key, at: entry.at, kind: 'done', text: who + ' · ' + step + ' done' + (snippet ? ': ' + snippet : '') });
        break;
      }
      case 'STEP_FAILED':
        lines.push({ key, at: entry.at, kind: 'fail', text: who + ' · ' + step + ' failed' + (entry.detail ? ': ' + entry.detail : '') });
        break;
      case 'HALTED':
        lines.push({ key, at: entry.at, kind: 'halt', text: who + ' halted' + (step ? ' at ' + step : '') + (entry.detail ? ': ' + entry.detail : '') });
        break;
      case 'COMPLETED':
        lines.push({ key, at: entry.at, kind: 'complete', text: who + ' completed' });
        break;
      default:
        break;
    }
  });
  if (record.awaiting) {
    const a = record.awaiting;
    lines.push({ key: run + ':ask' + a.step_index, at: a.asked_at, kind: 'ask', text: who + ' asks: ' + a.question });
  }
  (record.choices || []).forEach((c, i) => {
    lines.push({ key: run + ':chose' + i, at: c.at, kind: 'answer', text: 'You chose [' + c.option + '] ' + c.choice + ' for ' + who });
  });
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
};

export function mountOperatorConsole(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const now = options.now || (() => Date.now());
  const statusEl = options.statusEl || null;

  const log = el(doc, 'ol', { class: 'oc-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Engine activity', tabindex: '0' });
  const logEmpty = el(doc, 'p', { class: 'oc-empty', text: 'No engine activity yet. Task runs show here as they happen.' });
  const prompts = el(doc, 'div', { class: 'oc-prompts', tabindex: '-1' });
  const promptsEmpty = el(doc, 'p', { class: 'oc-empty', text: 'Nothing is waiting for you. When an agent asks you to choose, the options show here as numbered buttons.' });
  const promptCount = el(doc, 'span', { class: 'oc-count', hidden: true });
  container.replaceChildren(el(doc, 'div', { class: 'oc-panes' }, [
    el(doc, 'section', { class: 'oc-pane oc-pane-log', 'aria-label': 'Activity' }, [
      el(doc, 'h3', { class: 'oc-pane-title', text: 'Activity' }),
      logEmpty,
      log,
    ]),
    el(doc, 'section', { class: 'oc-pane oc-pane-prompts', 'aria-label': 'Waiting for you' }, [
      el(doc, 'h3', { class: 'oc-pane-title' }, [doc.createTextNode('Waiting for you '), promptCount]),
      promptsEmpty,
      prompts,
    ]),
  ]));

  const seen = new Set();
  let timer = null;
  let destroyed = false;
  let busy = false;
  // Choices being sent, by task key, so a poll does not redraw their chips mid-send.
  const sending = new Set();
  // The record of each run the log follows, by run id (refetched while it runs).
  const finishedRuns = new Set();

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  // Follows the newest line unless the operator has scrolled up.
  const appendLines = (lines) => {
    if (!lines.length) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    for (const line of lines) {
      log.append(el(doc, 'li', { class: 'oc-line', 'data-kind': line.kind }, [
        el(doc, 'time', { class: 'oc-time', datetime: line.at, text: timeOf(line.at) }),
        el(doc, 'span', { class: 'oc-text', text: line.text }),
      ]));
    }
    while (log.children.length > MAX_LOG_LINES) log.firstElementChild.remove();
    logEmpty.hidden = log.children.length > 0;
    if (atBottom) log.scrollTop = log.scrollHeight;
  };

  const taskKey = (task) => task.agent_id + '/' + task.task_id;

  const renderPrompts = (waiting) => {
    if (options.onWaitingChange) options.onWaitingChange(waiting.length);
    promptsEmpty.hidden = waiting.length > 0;
    promptCount.hidden = waiting.length === 0;
    promptCount.textContent = String(waiting.length);
    const keep = new Set(waiting.map(taskKey));
    for (const card of [...prompts.children]) {
      if (!keep.has(card.dataset.task) && !sending.has(card.dataset.task)) card.remove();
    }
    for (const task of waiting) {
      const key = taskKey(task);
      const askedKey = key + '@' + task.awaiting.asked_at;
      let card = [...prompts.children].find((item) => item.dataset.task === key) || null;
      if (card && card.dataset.asked === askedKey) continue;
      if (card) card.remove();
      card = el(doc, 'article', { class: 'oc-prompt', 'data-task': key, 'data-asked': askedKey });
      const message = el(doc, 'p', { class: 'oc-prompt-message', role: 'status' });
      const chips = el(doc, 'div', { class: 'oc-chips', role: 'group', 'aria-label': 'Options' });
      task.awaiting.options.forEach((option, i) => {
        const chip = el(doc, 'button', { type: 'button', class: 'oc-chip', 'data-option': String(i + 1) }, [
          el(doc, 'span', { class: 'oc-chip-num', text: '[' + (i + 1) + ']' }),
          doc.createTextNode(' ' + option),
        ]);
        chip.addEventListener('click', () => answer(task, i + 1, card, message));
        chips.append(chip);
      });
      card.append(
        el(doc, 'p', { class: 'oc-prompt-who', text: agentName(task.agent_id) + ' / ' + taskTitle(task.task_id) }),
        el(doc, 'p', { class: 'oc-prompt-question', text: task.awaiting.question }),
        chips,
        message
      );
      prompts.append(card);
    }
  };

  async function answer(task, option, card, message) {
    const key = taskKey(task);
    if (sending.has(key)) return;
    sending.add(key);
    card.querySelectorAll('.oc-chip').forEach((chip) => { chip.disabled = true; });
    card.querySelector('.oc-chip[data-option="' + option + '"]').classList.add('chosen');
    message.textContent = 'Sending…';
    try {
      await api.answerTaskChoice(task.agent_id, task.task_id, option);
      message.textContent = 'Sent. The task carries on.';
      sending.delete(key);
      setTimeout(() => card.remove(), 600);
      refresh();
    } catch (error) {
      sending.delete(key);
      card.querySelectorAll('.oc-chip').forEach((chip) => {
        chip.disabled = false;
        chip.classList.remove('chosen');
      });
      message.textContent = 'Could not send the choice: ' + describeEngineError(error);
    }
  }

  // Number keys answer the first waiting question while the pane (or one of its chips) has focus.
  prompts.addEventListener('keydown', (event) => {
    if (!/^[1-9]$/.test(event.key)) return;
    const chip = prompts.querySelector('.oc-prompt .oc-chip[data-option="' + event.key + '"]:not(:disabled)');
    if (!chip) return;
    event.preventDefault();
    chip.click();
  });

  async function refresh() {
    if (destroyed || busy) return;
    busy = true;
    let running = false;
    try {
      const list = await api.listTasks({ limit: 50 });
      const tasks = list.tasks || [];
      running = tasks.some((t) => t.status === 'RUNNING');
      renderPrompts(tasks.filter((t) => t.awaiting));
      const followed = tasks
        .filter((t) => t.status === 'RUNNING' || (t.finished_at && now() - Date.parse(t.finished_at) < RECENT_MS))
        .filter((t) => !finishedRuns.has(t.run_id))
        .slice(0, MAX_FOLLOWED_RUNS);
      const records = await Promise.all(followed.map((t) => api.getTaskStatus(t.agent_id, t.task_id).catch(() => null)));
      const fresh = [];
      for (const record of records) {
        if (!record) continue;
        for (const line of recordLines(record)) {
          if (seen.has(line.key)) continue;
          seen.add(line.key);
          fresh.push(line);
        }
        // A finished run's lines are all in; it is not fetched again.
        if (record.status !== 'RUNNING') finishedRuns.add(record.run_id);
      }
      appendLines(fresh.sort((a, b) => a.at.localeCompare(b.at)));
      setStatus(running ? 'Live' : 'Up to date');
    } catch (error) {
      setStatus(describeEngineError(error));
    } finally {
      busy = false;
      if (!destroyed) {
        clearTimeout(timer);
        timer = setTimeout(refresh, pollDelay(running ? ACTIVE_POLL_MS : IDLE_POLL_MS));
      }
    }
  }

  // A trip or reset changes what waiting tasks will do; look now rather than at the next tick.
  const unsubscribe = onEngineState((detail) => {
    if (detail.source !== 'state') refresh();
  });
  refresh();

  return {
    refresh,
    elements: { log, prompts, logEmpty, promptsEmpty, promptCount },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
      container.replaceChildren();
    },
  };
}
