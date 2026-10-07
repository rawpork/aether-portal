// Agent dialogue (Mission Control -> Operator -> Agent dialogue): a task run shown as the agents' conversation.
// Each prompt step is one agent's turn: a badge in that agent's colour, what it was asked (its brief, folded away),
// its reply, and its "Hand-off:" line pulled out as the proposed output for the next agent. Choice steps sit in the
// thread where they happen: waiting ones as numbered chips [1] [2] [3] that answer the engine straight away, answered
// ones with the choice made. A running step shows as typing; steps still to come are listed faintly.
// Studio workflow runs (agent `workflow:<id>`) are labelled with the workflow's own agent and checkpoint names.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeEngineError } from './operator-console.js';
import { agentName, taskTitle } from './labels.js';

export const ACTIVE_POLL_MS = 2000;
export const IDLE_POLL_MS = 6000;
export const MAX_RUNS = 20;
// Agent badge colours, in order of first appearance in a run.
export const AGENT_COLOURS = ['#00ffcc', '#ffb627', '#7aa2ff', '#ff7ab6', '#9be15d', '#c49bff'];

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

// A reply split into what the agent said and its hand-off line ("Hand-off: ..."), if it wrote one.
export function splitHandOff(text) {
  const value = String(text || '');
  const match = /(^|\n)\s*\**hand[- ]?off\**\s*:\s*([\s\S]*)$/i.exec(value);
  if (!match) return { body: value.trim(), handOff: '' };
  // A bold label (**Hand-off:**) leaves its closing asterisks in front of the text.
  return { body: value.slice(0, match.index).trim(), handOff: match[2].replace(/^\*+\s*/, '').trim() };
}

const workflowIdOf = (record) => (String(record.agent_id || '').startsWith('workflow:') ? record.agent_id.slice('workflow:'.length) : null);

// The thread for one run: [{ kind: 'agent' | 'choice' | 'typing' | 'pending' | 'system', ... }].
// labels: node id -> { label, kind } (a Studio workflow's nodes), when known.
export function buildThread(record, labels = new Map()) {
  const plan = record.plan || [];
  const results = new Map((record.results || []).map((r) => [r.step_index, r]));
  const choices = new Map((record.choices || []).map((c) => [c.step_id, c]));
  const colours = new Map();
  const speaker = (stepId) => {
    const known = labels.get(stepId);
    const name = known && known.kind === 'agent' ? known.label : workflowIdOf(record) ? stepId : record.agent_id;
    if (!colours.has(name)) colours.set(name, AGENT_COLOURS[colours.size % AGENT_COLOURS.length]);
    return { name, colour: colours.get(name) };
  };
  const running = record.status === 'RUNNING' && !record.awaiting ? record.completed_steps : -1;
  const thread = [];
  plan.forEach((step, index) => {
    const result = results.get(index);
    const title = labels.get(step.step_id)?.label || step.step_id;
    if (step.action === 'choice') {
      const made = choices.get(step.step_id);
      if (record.awaiting && record.awaiting.step_index === index) {
        thread.push({ kind: 'choice', index, title, question: record.awaiting.question, options: record.awaiting.options, waiting: true });
      } else if (made) {
        thread.push({ kind: 'choice', index, title, question: made.question, options: [], waiting: false, chosen: made, stopped: record.stopped?.step_index === index });
      } else if (index >= record.completed_steps) {
        thread.push({ kind: 'pending', index, title: 'Checkpoint: ' + title });
      }
      return;
    }
    if (step.action === 'prompt') {
      const who = speaker(step.step_id);
      if (result) {
        const reply = splitHandOff(result.output && typeof result.output.response === 'string' ? result.output.response : '');
        thread.push({ kind: 'agent', index, ...who, brief: step.summary || '', body: reply.body, handOff: reply.handOff, tokens: result.tokens });
      } else if (index === running) {
        thread.push({ kind: 'typing', index, ...who });
      } else if (record.status === 'RUNNING') {
        thread.push({ kind: 'pending', index, title: who.name });
      }
      return;
    }
    // echo / wait steps: a short system line once done.
    if (result) thread.push({ kind: 'system', index, text: title + ' (' + step.action + ') done' });
  });
  if (record.status === 'HALTED') thread.push({ kind: 'system', text: 'Halted by the circuit breaker' + (record.halt && record.halt.reason ? ': ' + record.halt.reason : '') + '.', tone: 'alert' });
  if (record.status === 'FAILED') thread.push({ kind: 'system', text: 'Failed' + (record.failure ? ': ' + record.failure.error : '') + '.', tone: 'alert' });
  if (record.status === 'COMPLETED') thread.push({ kind: 'system', text: record.stopped ? 'You stopped the run at ' + (labels.get(record.stopped.step_id)?.label || record.stopped.step_id) + '.' : 'Run complete.', tone: 'ok' });
  return thread;
}

export function mountAgentDialogue(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const picker = el(doc, 'select', { class: 'ad-picker', 'aria-label': 'Run to follow' });
  const status = el(doc, 'span', { class: 'mc-muted ad-status', 'aria-live': 'polite' });
  const thread = el(doc, 'ol', { class: 'ad-thread', 'aria-label': 'Agent dialogue', 'aria-live': 'polite' });
  const empty = el(doc, 'p', { class: 'oc-empty', text: 'No agent runs yet. Run a Studio workflow, or any task, and the agents’ conversation shows here.' });
  container.replaceChildren(el(doc, 'div', { class: 'ad' }, [el(doc, 'div', { class: 'ad-bar' }, [picker, status]), empty, thread]));

  let tasks = [];
  let selected = null; // agent_id + '/' + task_id
  let followLatest = true;
  // The run whose thread is on screen: a different one starts at the bottom; the same one keeps the reader's place.
  let shownKey = null;
  const workflowLabels = new Map(); // workflow id -> Map(node id -> { label, kind })
  let timer = null;
  let destroyed = false;
  let busy = false;
  const sending = new Set();

  picker.addEventListener('change', () => {
    selected = picker.value;
    followLatest = false;
    refresh();
  });

  const keyOf = (t) => t.agent_id + '/' + t.task_id;

  const renderPicker = () => {
    const current = picker.value;
    picker.replaceChildren(...tasks.map((t) => {
      const option = el(doc, 'option', { value: keyOf(t), text: (t.status === 'RUNNING' ? '● ' : '') + taskTitle(t.task_id) + ' · ' + agentName(t.agent_id) });
      return option;
    }));
    picker.value = selected || current;
    picker.hidden = tasks.length === 0;
  };

  async function labelsFor(record) {
    const id = workflowIdOf(record);
    if (!id) return new Map();
    if (!workflowLabels.has(id)) {
      try {
        const wf = await api.getWorkflow(id);
        workflowLabels.set(id, new Map(wf.nodes.map((n) => [n.id, { label: n.label, kind: n.kind }])));
      } catch {
        workflowLabels.set(id, new Map());
      }
    }
    return workflowLabels.get(id);
  }

  async function answer(record, option, card) {
    const key = keyOf(record);
    if (sending.has(key)) return;
    sending.add(key);
    card.querySelectorAll('.oc-chip').forEach((chip) => { chip.disabled = true; });
    card.querySelector('.oc-chip[data-option="' + option + '"]').classList.add('chosen');
    const message = card.querySelector('.oc-prompt-message');
    message.textContent = 'Sending…';
    try {
      await api.answerTaskChoice(record.agent_id, record.task_id, option);
      message.textContent = 'Sent.';
    } catch (error) {
      card.querySelectorAll('.oc-chip').forEach((chip) => {
        chip.disabled = false;
        chip.classList.remove('chosen');
      });
      message.textContent = 'Could not send the choice: ' + describeEngineError(error);
    } finally {
      sending.delete(key);
      refresh();
    }
  }

  const renderThread = (record, items) => {
    const newRun = shownKey !== keyOf(record);
    shownKey = keyOf(record);
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    // Briefs the reader opened stay open across refreshes.
    const openBriefs = newRun ? new Set() : new Set([...thread.querySelectorAll('.ad-turn[data-index] details[open]')].map((d) => d.closest('.ad-turn').dataset.index));
    thread.replaceChildren(...items.map((item) => {
      if (item.kind === 'agent') {
        const li = el(doc, 'li', { class: 'ad-turn', 'data-index': String(item.index) });
        li.style.setProperty('--agent', item.colour);
        const head = el(doc, 'div', { class: 'ad-head' }, [
          el(doc, 'span', { class: 'ad-badge', text: item.name.slice(0, 2).toUpperCase(), 'aria-hidden': 'true' }),
          el(doc, 'strong', { class: 'ad-name', text: item.name }),
          el(doc, 'span', { class: 'ad-meta', text: item.tokens && (item.tokens.input || item.tokens.output) ? (item.tokens.input + item.tokens.output).toLocaleString() + ' tokens' : '' }),
        ]);
        const parts = [head];
        if (item.brief) {
          const brief = el(doc, 'details', { class: 'ad-brief' }, [el(doc, 'summary', { text: 'Brief' }), el(doc, 'p', { text: item.brief })]);
          if (openBriefs.has(String(item.index))) brief.open = true;
          parts.push(brief);
        }
        if (item.body) parts.push(el(doc, 'p', { class: 'ad-body', text: item.body }));
        if (item.handOff) parts.push(el(doc, 'p', { class: 'ad-handoff' }, [el(doc, 'span', { class: 'ad-handoff-label', text: 'Proposed hand-off' }), doc.createTextNode(item.handOff)]));
        li.append(...parts);
        return li;
      }
      if (item.kind === 'typing') {
        const li = el(doc, 'li', { class: 'ad-turn ad-typing' }, [
          el(doc, 'div', { class: 'ad-head' }, [el(doc, 'span', { class: 'ad-badge', text: item.name.slice(0, 2).toUpperCase(), 'aria-hidden': 'true' }), el(doc, 'strong', { class: 'ad-name', text: item.name }), el(doc, 'span', { class: 'ad-meta', text: 'working…' })]),
        ]);
        li.style.setProperty('--agent', item.colour);
        return li;
      }
      if (item.kind === 'choice') {
        const card = el(doc, 'li', { class: 'oc-prompt ad-choice' }, [
          el(doc, 'p', { class: 'oc-prompt-who', text: item.title + (item.waiting ? ' · waiting for you' : '') }),
          el(doc, 'p', { class: 'oc-prompt-question', text: item.question }),
        ]);
        if (item.waiting) {
          const chips = el(doc, 'div', { class: 'oc-chips', role: 'group', 'aria-label': 'Options' });
          item.options.forEach((option, i) => {
            const chip = el(doc, 'button', { type: 'button', class: 'oc-chip', 'data-option': String(i + 1) }, [el(doc, 'span', { class: 'oc-chip-num', text: '[' + (i + 1) + ']' }), doc.createTextNode(' ' + option)]);
            chip.addEventListener('click', () => answer(record, i + 1, card));
            chips.append(chip);
          });
          card.append(chips, el(doc, 'p', { class: 'oc-prompt-message', role: 'status' }));
        } else {
          card.append(el(doc, 'p', { class: 'ad-chosen', text: 'You chose [' + item.chosen.option + '] ' + item.chosen.choice + (item.stopped ? ' · run stopped here' : '') }));
        }
        return card;
      }
      if (item.kind === 'pending') return el(doc, 'li', { class: 'ad-pending', text: 'Up next: ' + item.title });
      return el(doc, 'li', { class: 'ad-system', 'data-tone': item.tone || '', text: item.text });
    }));
    empty.hidden = items.length > 0;
    if (newRun || atBottom) thread.scrollTop = thread.scrollHeight;
  };

  async function refresh() {
    if (destroyed || busy) return;
    busy = true;
    let running = false;
    try {
      tasks = ((await api.listTasks({ limit: MAX_RUNS })).tasks || []);
      running = tasks.some((t) => t.status === 'RUNNING');
      if (followLatest || !tasks.some((t) => keyOf(t) === selected)) {
        const pick = tasks.find((t) => t.status === 'RUNNING') || tasks[0];
        selected = pick ? keyOf(pick) : null;
      }
      renderPicker();
      const task = tasks.find((t) => keyOf(t) === selected);
      if (!task) {
        thread.replaceChildren();
        empty.hidden = false;
        status.textContent = '';
        return;
      }
      const record = await api.getTaskStatus(task.agent_id, task.task_id);
      const labels = await labelsFor(record);
      if (!sending.has(keyOf(record))) renderThread(record, buildThread(record, labels));
      status.textContent = record.awaiting ? 'Waiting for you' : record.status === 'RUNNING' ? 'Live' : record.status.toLowerCase();
    } catch (error) {
      status.textContent = describeEngineError(error);
    } finally {
      busy = false;
      if (!destroyed) {
        clearTimeout(timer);
        timer = setTimeout(refresh, running ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      }
    }
  }

  const unsubscribe = onEngineState((detail) => {
    if (detail.source !== 'state') refresh();
  });
  refresh();

  return {
    refresh,
    elements: { picker, thread, empty, status },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
      container.replaceChildren();
    },
  };
}
