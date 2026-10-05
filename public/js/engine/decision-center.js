// Decision center (every Mission Control view): the "Do this next" banner above the views, and numbered choice
// popups whenever the operator has something to decide, so the next step is always one tap (or one number key) away.
// - Elarion asks (a run waits on a choice step): the question with its options, answered on the engine.
// - A project run finishes, fails or is halted: what to do about it.
// - Skill ingestion ("add repo <url>", "add skill <url or text>", "learn <...>"): Elarion reads the source and drafts
//   a SKILL.md; Save / Edit first / Discard. Saved skills land in Aether_Engine/skills/<name>/SKILL.md.
// Popups open only for things that happen while the page is open (runs that finished earlier don't pop up), one at
// a time. Number keys pick, arrow keys move, Esc closes the ones that can wait.
import { getEngineApi } from '../engine-api.bundle.js';
import { describeEngineError } from './operator-console.js';
import { nextAction } from './workforce.js';

export const POLL_MS = 4000;
export const SKILL_COMMAND = /^\s*(?:add\s+(?:repo|skill)|learn)\s+([\s\S]+)$/i;

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}

// The source of a skill command ("add repo https://github.com/a/b" -> the URL), or null for anything else.
export function skillCommandSource(text) {
  const match = SKILL_COMMAND.exec(String(text || ''));
  return match ? match[1].trim() : null;
}

// What changed between two task lists that deserves a popup: [{ type: 'choice' | 'completed' | 'failed' | 'halted',
// task }]. prev: Map task key -> { status, awaitingKey } from the previous poll (null on the first poll: nothing pops).
export function taskEvents(prev, tasks) {
  if (!prev) return [];
  const events = [];
  for (const task of tasks) {
    const key = task.agent_id + '/' + task.task_id;
    const before = prev.get(key);
    const awaitingKey = task.awaiting ? task.run_id + ':' + task.awaiting.step_index : null;
    if (awaitingKey && (!before || before.awaitingKey !== awaitingKey)) events.push({ type: 'choice', task });
    const wasRunning = before ? before.status === 'RUNNING' && before.run_id === task.run_id : false;
    const isNewRun = !before || before.run_id !== task.run_id;
    if ((wasRunning || isNewRun) && task.status !== 'RUNNING' && String(task.task_id).startsWith('deploy-')) {
      // A run that started and ended between two polls counts too.
      if (task.status === 'COMPLETED') events.push({ type: 'completed', task });
      else if (task.status === 'FAILED') events.push({ type: 'failed', task });
      else if (task.status === 'HALTED') events.push({ type: 'halted', task });
    }
  }
  return events;
}

export function snapshot(tasks) {
  return new Map(tasks.map((t) => [t.agent_id + '/' + t.task_id, { status: t.status, run_id: t.run_id, awaitingKey: t.awaiting ? t.run_id + ':' + t.awaiting.step_index : null }]));
}

export function mountDecisionCenter(doc, options = {}) {
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const slot = options.slot || null;
  const onNavigate = options.onNavigate || (() => {});
  const pollMs = options.pollMs ?? POLL_MS;
  const storage = options.storage || (() => { try { return win.localStorage; } catch { return null; } })();
  let destroyed = false;
  let timer = null;
  let previous = null;
  let tasks = [];
  let error = null;
  let lastBanner = '';
  const queue = [];
  let open = null;

  // ---- choice popup

  // Shows a popup and resolves with the picked option's index, or -1 when it was closed. options: [{ label, hint? }].
  function choose({ title, body = null, options: choices, dismissible = true, kind = 'note' }) {
    return new Promise((resolve) => {
      queue.push({ title, body, choices, dismissible, kind, resolve });
      if (!open) showNext();
    });
  }

  function showNext() {
    const item = queue.shift();
    if (!item) return;
    const returnFocus = doc.activeElement;
    const titleId = 'dc-title-' + Math.random().toString(36).slice(2, 8);
    const buttons = item.choices.map((choice, i) => el(doc, 'button', { type: 'button', class: 'dc-option', 'data-option': String(i + 1) }, [
      el(doc, 'span', { class: 'dc-num', text: String(i + 1) }),
      el(doc, 'span', { class: 'dc-option-text' }, [el(doc, 'span', { class: 'dc-option-label', text: choice.label }), choice.hint ? el(doc, 'span', { class: 'dc-option-hint', text: choice.hint }) : null]),
    ]));
    const bodyNode = item.body == null ? null : typeof item.body === 'string' ? el(doc, 'p', { class: 'dc-body', text: item.body }) : item.body;
    const modal = el(doc, 'div', { class: 'dc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'data-kind': item.kind }, [
      el(doc, 'h2', { id: titleId, class: 'dc-title', text: item.title }),
      bodyNode,
      el(doc, 'ol', { class: 'dc-options' }, buttons.map((b) => el(doc, 'li', {}, [b]))),
      el(doc, 'p', { class: 'dc-keys', text: 'Press 1–' + buttons.length + (item.dismissible ? ' · Esc to close' : '') }),
    ]);
    const scrim = el(doc, 'div', { class: 'dc-scrim' }, [modal]);
    const close = (index) => {
      scrim.remove();
      doc.removeEventListener('keydown', onKey, true);
      open = null;
      if (returnFocus && returnFocus.focus && doc.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
      item.resolve(index);
      showNext();
    };
    const onKey = (event) => {
      if (event.key === 'Escape' && item.dismissible) {
        event.preventDefault();
        close(-1);
        return;
      }
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= buttons.length && !(event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName))) {
        event.preventDefault();
        buttons[n - 1].click();
        return;
      }
      const at = buttons.indexOf(doc.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
      } else if (event.key === 'Tab') {
        // Keep focus inside the popup.
        const focusables = [...modal.querySelectorAll('button, textarea, a[href], input')].filter((n) => !n.disabled);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    buttons.forEach((b, i) => b.addEventListener('click', () => close(i)));
    if (item.dismissible) scrim.addEventListener('click', (event) => { if (event.target === scrim) close(-1); });
    doc.addEventListener('keydown', onKey, true);
    open = { scrim, close };
    doc.body.append(scrim);
    (modal.querySelector('textarea') || buttons[0]).focus({ preventScroll: true });
  }

  // A popup with no choices while something works; close() removes it.
  function progress(title, text) {
    const modal = el(doc, 'div', { class: 'dc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'aria-busy': 'true' }, [
      el(doc, 'h2', { class: 'dc-title', text: title }),
      el(doc, 'p', { class: 'dc-body dc-working', text }),
    ]);
    const scrim = el(doc, 'div', { class: 'dc-scrim' }, [modal]);
    doc.body.append(scrim);
    return { close: () => scrim.remove() };
  }

  // ---- skill ingestion

  async function learn(source) {
    const working = progress('Learning a new skill', 'Elarion is reading ' + (/^https?:\/\//i.test(source) ? source : 'your text') + ' and writing a SKILL.md. This takes up to a minute.');
    let result;
    try {
      result = await api.ingestSkill(source);
    } catch (e) {
      working.close();
      await choose({ title: 'Could not learn from that', body: describeEngineError(e), options: [{ label: 'OK' }], kind: 'warn' });
      return null;
    }
    working.close();
    return reviewDraft(result.draft, result.exists);
  }

  async function reviewDraft(draft, exists) {
    let markdown = draft.markdown;
    for (;;) {
      const preview = el(doc, 'div', { class: 'dc-skill' }, [
        el(doc, 'p', { class: 'dc-body', text: draft.description + (draft.source && draft.source.url ? ' · from ' + draft.source.url : '') }),
        el(doc, 'pre', { class: 'dc-preview', text: markdown }),
        exists ? el(doc, 'p', { class: 'dc-warn', text: 'A skill named ' + draft.slug + ' already exists. Saving replaces it.' }) : null,
      ]);
      const pick = await choose({
        title: 'New skill: ' + draft.slug,
        body: preview,
        options: [
          { label: exists ? 'Replace the saved skill' : 'Save skill', hint: 'Aether_Engine/skills/' + draft.slug + '/SKILL.md' },
          { label: 'Edit first', hint: 'Change the text, then save' },
          { label: 'Discard' },
        ],
      });
      if (pick === 0) {
        try {
          const saved = await api.saveSkill(draft.slug, markdown, { replace: exists });
          await choose({ title: 'Skill saved', body: 'Saved to Aether_Engine/' + saved.file + '. Project runs whose topic matches it now follow its rules.', options: [{ label: 'Done' }, { label: 'Learn another', hint: 'Type add repo <link> in the bar below' }] });
          return saved;
        } catch (e) {
          const retry = await choose({ title: 'Could not save the skill', body: describeEngineError(e), options: [{ label: 'Edit and try again' }, { label: 'Discard' }], kind: 'warn' });
          if (retry !== 0) return null;
        }
      }
      if (pick === 1 || pick === 0) {
        const area = el(doc, 'textarea', { class: 'dc-editor', rows: '16', 'aria-label': 'SKILL.md' });
        area.value = markdown;
        const edited = await choose({ title: 'Edit ' + draft.slug, body: area, options: [{ label: 'Review the edit' }, { label: 'Cancel' }] });
        if (edited === 0) markdown = area.value;
        continue;
      }
      return null;
    }
  }

  // ---- engine events

  async function onEvent({ type, task }) {
    if (type === 'choice') {
      const options = task.awaiting.options || [];
      const pick = await choose({
        title: 'Elarion needs your decision',
        body: task.awaiting.question + ' · ' + task.task_id,
        options: [...options.map((o) => ({ label: o })), { label: 'Decide later', hint: 'It waits in Operator' }],
        kind: 'alert',
      });
      if (pick >= 0 && pick < options.length) {
        try {
          await api.answerTaskChoice(task.agent_id, task.task_id, pick + 1);
        } catch (e) {
          await choose({ title: 'Could not send your answer', body: describeEngineError(e), options: [{ label: 'Open Operator' }, { label: 'Close' }], kind: 'warn' }).then((i) => i === 0 && onNavigate('operator'));
        }
      }
      return;
    }
    if (type === 'completed') {
      const pick = await choose({
        title: 'Project finished',
        body: task.task_id + ' · ' + task.completed_steps + ' of ' + task.total_steps + ' steps. Its files, any website draft and the Space card are under Projects.',
        options: [{ label: 'See deliverables', hint: 'Files, website preview, Approve & publish' }, { label: 'Watch what each step wrote', hint: 'Live activity' }, { label: 'Start another project' }, { label: 'Stay here' }],
        kind: 'go',
      });
      if (pick === 0 || pick === 2) onNavigate('blueprints');
      else if (pick === 1) onNavigate('activity');
      return;
    }
    let detail = '';
    try {
      const record = await api.getTaskStatus(task.agent_id, task.task_id);
      detail = type === 'failed' && record.failure ? record.failure.error : record.halt ? record.halt.reason || '' : '';
    } catch { /* the popup still offers the next steps */ }
    if (type === 'failed') {
      const pick = await choose({
        title: 'A project run failed',
        body: task.task_id + (detail ? ': ' + detail : ''),
        options: [{ label: 'See the failed step', hint: 'Studio → Engine activity' }, { label: 'Run it again', hint: 'Projects → Deploy & Execute' }, { label: 'Close' }],
        kind: 'warn',
      });
      if (pick === 0) onNavigate('studio');
      else if (pick === 1) onNavigate('blueprints');
      return;
    }
    const pick = await choose({
      title: 'A run was stopped by the breaker',
      body: task.task_id + (detail ? ': ' + detail : ''),
      options: [{ label: 'Reset the agent', hint: 'Lets it run again' }, { label: 'Leave it stopped' }],
      kind: 'warn',
    });
    if (pick === 0) api.resetBreaker(task.agent_id).catch(() => {});
  }

  // ---- banner

  function renderBanner() {
    if (!slot) return;
    let runs = {};
    try {
      runs = JSON.parse((storage && storage.getItem('aether.projectRuns')) || '{}') || {};
    } catch { /* no run hints */ }
    const action = nextAction({ error, tasks, runs });
    const sig = JSON.stringify(action);
    if (sig === lastBanner) return;
    lastBanner = sig;
    slot.hidden = !action;
    if (!action) return;
    slot.className = 'wf-next';
    slot.dataset.kind = action.kind;
    const children = [el(doc, 'div', { class: 'wf-next-text' }, [el(doc, 'p', { class: 'eyebrow', text: 'Do this next' }), el(doc, 'p', { class: 'wf-next-title', text: action.title }), el(doc, 'p', { class: 'wf-next-sub', text: action.text })])];
    if (action.action) {
      const go = el(doc, 'button', { type: 'button', class: 'btn btn-primary wf-next-go', text: action.action.label });
      go.addEventListener('click', () => onNavigate(action.action.view));
      children.push(go);
    }
    slot.replaceChildren(...children);
  }

  async function poll() {
    if (destroyed) return;
    try {
      tasks = (await api.listTasks({ limit: 50 })).tasks || [];
      error = null;
      const events = taskEvents(previous, tasks);
      previous = snapshot(tasks);
      events.forEach((e) => { onEvent(e); });
    } catch (e) {
      error = e;
    }
    renderBanner();
    clearTimeout(timer);
    if (!destroyed) timer = setTimeout(poll, error && error.isUnreachable ? pollMs * 3 : pollMs);
  }

  poll();
  return {
    choose,
    learn,
    poll,
    isOpen: () => Boolean(open),
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      if (open) open.close(-1);
    },
  };
}
