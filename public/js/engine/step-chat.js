// Human titles, the inline step map, the final-deliverable banner and "Chat with Elarion on this step". Pure helpers plus small
// DOM builders; outcomes.js and workflow-console.js use them. Nothing here talks to the engine: prefilling Elarion's prompt fires a
// window event that brain-dock.js turns into text in the composer (the operator still presses Send).

export const PREFILL_EVENT = 'aether:elarion-prefill';

// Raw ids that must not appear as a card title: wf_2aa95528, bp_ba7a9a2a_1791182033292, deploy-bp_..., step-3.
const RAW_ID = /^(?:deploy-)?(?:wf|bp|run|task|step)[-_][a-z0-9_-]{1,}$/i;
export const looksLikeRawId = (text) => RAW_ID.test(String(text || '').trim());

const clean = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

// The title a card shows: the project name when it is a real name, else the goal's first words, else a plain fallback.
export function humanTitle({ project, title, goal } = {}, fallback = 'Untitled project') {
  for (const candidate of [project, title]) {
    const text = clean(candidate);
    if (text && !looksLikeRawId(text)) return text;
  }
  const g = clean(goal);
  if (g) return g.length > 70 ? g.slice(0, 67).trimEnd() + '…' : g;
  return fallback;
}

// A run's ordered steps for the map: [{ id, name, state }], state = done | running | failed | todo. `nameOf(stepId)` names a step.
export function stepMapSteps(record, nameOf) {
  const results = (record.results || []).filter((r) => r.step_id !== 'plan');
  const steps = results.map((r) => ({ id: r.step_id, name: nameOf(r.step_id), state: r.error || r.status === 'FAILED' ? 'failed' : 'done' }));
  const total = Number(record.total_steps) || steps.length;
  const running = record.status === 'RUNNING' || record.status === 'QUEUED';
  for (let i = steps.length; i < total; i++) steps.push({ id: 'pending-' + i, name: 'Step ' + (i + 1), state: running && i === steps.length ? 'running' : 'todo' });
  return steps;
}

// "@step(3) Design the page: " then the operator's wish; the operator edits it before sending.
export function stepPrompt(index, name, wish) {
  return '@step(' + index + ') ' + clean(name) + ': ' + clean(wish);
}

export const STEP_CHAT_OPTIONS = [
  ['Use a local skill instead of web search', 'Use the matching skill from the local skills repo instead of web search, then rerun this step.'],
  ['Redo with different instructions', 'Rewrite this step\'s instructions as follows, then rerun it: '],
  ['Explain what this step did', 'Explain what this step did and what it handed to the next step.'],
  ['Why did this fail?', 'Tell me why this step failed or fell short, and how to fix it.'],
];

export function prefillElarion(doc, text) {
  const win = doc.defaultView || globalThis;
  win.dispatchEvent(new win.CustomEvent(PREFILL_EVENT, { detail: { text } }));
}

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (value != null) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

// The dropdown beside a step: "💬 Chat with Elarion on this Step" -> choices that prefill the composer.
export function stepChatMenu(doc, index, name) {
  const menu = el(doc, 'details', { class: 'sc-menu' }, [el(doc, 'summary', { class: 'sc-chat', title: 'Ask Elarion about this step', text: '💬 Chat with Elarion on this Step' })]);
  for (const [label, wish] of STEP_CHAT_OPTIONS) {
    const item = el(doc, 'button', { type: 'button', class: 'sc-option', text: label });
    item.addEventListener('click', () => {
      prefillElarion(doc, stepPrompt(index, name, wish));
      menu.removeAttribute('open');
    });
    menu.append(item);
  }
  return menu;
}

// [Phase 1] ➔ [Phase 2] ➔ ... ➔ [Deliverable], each phase with its chat menu.
export function stepMapNode(doc, steps, { complete = false } = {}) {
  const map = el(doc, 'ol', { class: 'sc-map', 'aria-label': 'Steps' });
  steps.forEach((step, i) => {
    map.append(el(doc, 'li', { class: 'sc-step', 'data-state': step.state }, [el(doc, 'span', { class: 'sc-chip', text: step.name }), stepChatMenu(doc, i + 1, step.name)]));
    map.append(el(doc, 'li', { class: 'sc-arrow', 'aria-hidden': 'true', text: '➔' }));
  });
  map.append(el(doc, 'li', { class: 'sc-step sc-final', 'data-state': complete ? 'done' : 'todo' }, [el(doc, 'span', { class: 'sc-chip', text: 'Deliverable' })]));
  return map;
}

// Shown at 100%: live URL, a score badge, a download. Parts that do not exist are left out, never faked.
export function deliverableBanner(doc, { url, score, verdict, download } = {}) {
  const banner = el(doc, 'div', { class: 'sc-deliverable', role: 'group', 'aria-label': 'Final deliverable' }, [el(doc, 'span', { class: 'sc-deliverable-title', text: '🎯 Final deliverable' })]);
  if (score != null) banner.append(el(doc, 'span', { class: 'sc-score', title: verdict || '', text: 'Score ' + score + '/100' + (verdict ? ' · ' + verdict : '') }));
  if (url) banner.append(el(doc, 'a', { class: 'bp-primary sc-live', href: url, target: '_blank', rel: 'noopener', text: '↗ Open live site' }));
  if (download) {
    const button = el(doc, 'button', { type: 'button', class: 'toggle-button sc-download', text: '⤓ ' + download.label });
    button.addEventListener('click', download.onClick);
    banner.append(button);
  }
  return banner;
}
