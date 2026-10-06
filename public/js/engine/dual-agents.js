// Dual-agent console (Mission Control -> Operator -> Claude ⇄ Gemini): two feeds side by side (stacked on phones).
// - Claude, for architecture and planning: chat turns sent with purpose "plan".
// - Gemini, for fast ingestion and background steps: chat turns sent with purpose "step".
// The engine's MODEL_ROUTES decides the provider for each purpose, and each reply says which model answered. Task
// steps the engine ran in the background land in the feed of the provider that answered them.
// Every agent message has "Paste to <other agent>": its code blocks (or the whole text when there are none) go into
// the other agent's input, ready to send. The Inter-agent copy bar switches between Manual Copy (that button) and
// Auto-Send (each reply goes to the other agent by itself, at most MAX_AUTO_HOPS times in a row), and wraps what is
// passed on in an optional pre-send prefix and post-send suffix. A reply that asks something (numbered options, or a
// yes/no question) is a decision gate: it gets quick-reply chips, and Auto-Send waits for your pick.
import { getEngineApi } from '../engine-api.bundle.js';
import { choiceReply, decisionOptions, renderChoiceChips } from './choice-chips.js';
import { describeEngineError } from './operator-console.js';

export const AGENTS = [
  { id: 'claude', name: 'Claude', role: 'Architecture & planning', purpose: 'plan', match: /claude|anthropic/i },
  { id: 'gemini', name: 'Gemini', role: 'Fast ingestion & background steps', purpose: 'step', match: /gemini|google/i },
];
export const POLL_MS = 8000;
// Background step outputs shown per agent when the console opens; newer ones are added as they finish.
export const BACKLOG_PER_AGENT = 3;
const RUN_TEXT_MAX = 6000;
// Agent-to-agent hand-offs Auto-Send makes before it waits for you (a message you send resets the count).
export const MAX_AUTO_HOPS = 6;
export const COPY_KEY = 'aether.dual.copy';
export const COPY_MODES = [
  { id: 'manual', label: 'Manual Copy', hint: 'Paste a reply to the other agent yourself, then edit and send it.' },
  { id: 'auto', label: 'Auto-Send', hint: 'Each reply goes to the other agent by itself, pausing at questions and after ' + MAX_AUTO_HOPS + ' hand-offs.' },
];

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

// Fenced code blocks in a reply, fences included, in order.
export function codeBlocks(text) {
  return [...String(text || '').matchAll(/(`{3,})[^\n]*\n[\s\S]*?\n\1(?!`)/g)].map((m) => m[0]);
}

// What Paste to Agent carries: the code blocks when there are any, else the whole reply.
export function pastePayload(text) {
  const blocks = codeBlocks(text);
  return blocks.length ? blocks.join('\n\n') : String(text || '').trim();
}

// What one agent hands the other: the prefix, the text and the suffix, a blank line apart.
export function wrapRelay(text, { pre = '', post = '' } = {}) {
  return [String(pre || '').trim(), String(text || '').trim(), String(post || '').trim()].filter(Boolean).join('\n\n');
}

// The saved copy settings: { mode: 'manual' | 'auto', pre, post }.
export function loadCopySettings(storage) {
  let saved = null;
  try {
    saved = JSON.parse((storage && storage.getItem(COPY_KEY)) || 'null');
  } catch { /* storage blocked or unreadable */ }
  const value = saved && typeof saved === 'object' ? saved : {};
  return { mode: value.mode === 'auto' ? 'auto' : 'manual', pre: typeof value.pre === 'string' ? value.pre : '', post: typeof value.post === 'string' ? value.post : '' };
}

// Which feed a model belongs to ('claude' | 'gemini'), from its model name or route; null for others.
export function providerOf(model, tier) {
  const name = String(model || '') + ' ' + String(tier || '');
  const agent = AGENTS.find((a) => a.match.test(name));
  return agent ? agent.id : null;
}

// Background step outputs from task records, for the feeds: [{ key, agent, title, text, at, model }], oldest first.
export function backgroundItems(records) {
  const items = [];
  for (const record of records) {
    for (const result of record.results || []) {
      const output = result.output || {};
      if (typeof output.response !== 'string' || !output.response.trim()) continue;
      // A Gemini step Claude stood in for stays in Gemini's feed, with the reason shown.
      const agent = /fallback:[\s\S]*gemini/i.test(String(output.tier || '')) ? 'gemini' : providerOf(output.model, output.tier);
      if (!agent) continue;
      items.push({ key: record.run_id + ':' + result.step_index, agent, title: record.task_id + ' · ' + result.step_id, text: output.response, at: result.started_at || record.started_at || '', model: output.model || '', tier: output.tier || '' });
    }
  }
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Why another model answered, from the engine's tier ("direct-anthropic (fallback: <provider error>)"), in plain
// words: { reason, text } or null when the intended provider answered.
export function fallbackNote(tier, agentName) {
  const match = /fallback:\s*([\s\S]*?)\)?$/.exec(String(tier || ''));
  if (!match) return null;
  const error = match[1];
  const status = /HTTP (\d{3})/.exec(error);
  const reason = /quota|exceeded/i.test(error) ? 'its usage quota is used up (check the plan and billing for the key)'
    : /high demand|overloaded|unavailable/i.test(error) || (status && status[1] === '503') ? 'it is overloaded right now'
      : /timed out/i.test(error) ? 'it timed out'
        : status ? 'it answered HTTP ' + status[1] : 'it could not be reached';
  return { reason, text: agentName + ' was unavailable (' + reason + '), so Claude answered this one instead.' };
}

// A reply as paragraphs and <pre> code blocks (text only, nothing parsed as HTML).
function renderBody(doc, text) {
  const body = el(doc, 'div', { class: 'da-body' });
  const source = String(text || '');
  let last = 0;
  for (const match of source.matchAll(/(`{3,})([^\n]*)\n([\s\S]*?)\n\1(?!`)/g)) {
    const prose = source.slice(last, match.index).trim();
    if (prose) body.append(el(doc, 'p', { text: prose }));
    body.append(el(doc, 'pre', { class: 'da-code', 'data-lang': match[2].trim() }, [el(doc, 'code', { text: match[3] })]));
    last = match.index + match[0].length;
  }
  const rest = source.slice(last).trim();
  if (rest) body.append(el(doc, 'p', { text: rest }));
  return body;
}

export function mountDualAgents(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const pollMs = options.pollMs ?? POLL_MS;
  const storage = options.storage !== undefined ? options.storage : (() => { try { return win.localStorage; } catch { return null; } })();
  const settings = loadCopySettings(storage);
  let hops = 0;
  const status = el(doc, 'p', { class: 'mc-muted da-status', 'aria-live': 'polite' });
  const seen = new Set();
  const panes = new Map();
  let destroyed = false;
  let timer = null;
  let firstLoad = true;

  for (const agent of AGENTS) {
    const other = AGENTS.find((a) => a.id !== agent.id);
    const feed = el(doc, 'ol', { class: 'da-feed', 'aria-label': agent.name + ' messages' });
    const empty = el(doc, 'li', { class: 'da-empty', text: agent.id === 'claude' ? 'Ask Claude to design or plan. Background planning steps show up here too.' : 'Ask Gemini to read, extract or summarise. Background task steps show up here too.' });
    feed.append(empty);
    const input = el(doc, 'textarea', { class: 'da-input', rows: '3', placeholder: 'Message ' + agent.name + '…', 'aria-label': 'Message ' + agent.name });
    const send = el(doc, 'button', { type: 'submit', class: 'bp-primary da-send', text: 'Send' });
    const form = el(doc, 'form', { class: 'da-compose' }, [input, send]);
    const model = el(doc, 'span', { class: 'mc-chip da-model', text: agent.purpose === 'plan' ? 'plan route' : 'step route' });
    const pane = el(doc, 'section', { class: 'da-pane', 'data-agent': agent.id, 'aria-label': agent.name }, [
      el(doc, 'header', { class: 'da-head' }, [el(doc, 'span', { class: 'da-dot', 'aria-hidden': 'true' }), el(doc, 'strong', { text: agent.name }), el(doc, 'span', { class: 'mc-muted da-role', text: agent.role }), model]),
      feed,
      form,
    ]);
    const state = { agent, other, pane, feed, empty, input, send, form, model, sessionId: 'dual-' + agent.id + '-' + Math.random().toString(36).slice(2, 10), busy: false };
    panes.set(agent.id, state);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || state.busy) return;
      input.value = '';
      sendTo(state, text);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new win.Event('submit', { cancelable: true }));
      }
    });
  }

  // Inter-agent copy bar: the mode toggle and the prompt wrappers, saved per browser.
  const save = () => {
    try { storage && storage.setItem(COPY_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
  };
  const modeHint = el(doc, 'span', { class: 'mc-muted da-relay-hint' });
  const modeButtons = COPY_MODES.map((mode) => {
    const button = el(doc, 'button', { type: 'button', class: 'da-seg-btn', 'data-mode': mode.id, text: mode.label });
    button.addEventListener('click', () => setMode(mode.id));
    return button;
  });
  function setMode(mode) {
    settings.mode = mode === 'auto' ? 'auto' : 'manual';
    hops = 0;
    modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
    modeHint.textContent = COPY_MODES.find((m) => m.id === settings.mode).hint;
    save();
  }
  const wrapper = (cls, label, key, placeholder) => {
    const area = el(doc, 'textarea', { class: 'da-wrap-input ' + cls, rows: '2', placeholder, 'aria-label': label });
    area.value = settings[key];
    area.addEventListener('input', () => {
      settings[key] = area.value;
      save();
    });
    return { area, field: el(doc, 'label', { class: 'da-wrap-field' }, [el(doc, 'span', { class: 'da-wrap-label', text: label }), area]) };
  };
  const pre = wrapper('da-pre', 'Pre-send prefix', 'pre', 'Goes before what is passed on, e.g. "Review this design for gaps:"');
  const post = wrapper('da-post', 'Post-send suffix', 'post', 'Goes after it, e.g. "Answer with code only."');
  const wrappers = el(doc, 'details', { class: 'da-wrappers' }, [el(doc, 'summary', { text: 'Prompt wrappers' }), el(doc, 'div', { class: 'da-wrap-grid' }, [pre.field, post.field])]);
  wrappers.open = Boolean(settings.pre.trim() || settings.post.trim());
  const relayBar = el(doc, 'div', { class: 'da-relay', role: 'group', 'aria-label': 'Inter-agent copy' }, [
    el(doc, 'span', { class: 'da-relay-label', text: 'Inter-agent copy' }),
    el(doc, 'div', { class: 'da-seg' }, modeButtons),
    modeHint,
  ]);
  setMode(settings.mode);

  const grid = el(doc, 'div', { class: 'da-grid' }, [...panes.values()].map((p) => p.pane));
  container.replaceChildren(el(doc, 'div', { class: 'da' }, [relayBar, wrappers, grid, status]));

  // Puts text into an agent's input (after anything already typed) and focuses it, ready to send.
  function pasteTo(agentId, text) {
    const target = panes.get(agentId);
    const value = target.input.value.trim();
    target.input.value = (value ? value + '\n\n' : '') + text;
    target.input.focus();
    target.input.setSelectionRange && target.input.setSelectionRange(target.input.value.length, target.input.value.length);
    target.pane.classList.add('da-pasted');
    setTimeout(() => target.pane.classList.remove('da-pasted'), 700);
    if (target.pane.scrollIntoView) target.pane.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    status.textContent = 'Pasted into ' + target.agent.name + '’s input. Edit it or press Send.';
  }

  function addMessage(state, kind, text, meta = {}) {
    state.empty.remove();
    const item = el(doc, 'li', { class: 'da-msg da-' + kind });
    if (kind === 'run') {
      const details = el(doc, 'details', { class: 'da-run-details' }, [el(doc, 'summary', { text: 'Background · ' + meta.title })]);
      details.append(renderBody(doc, text.length > RUN_TEXT_MAX ? text.slice(0, RUN_TEXT_MAX) + '\n…' : text));
      item.append(details);
    } else if (kind === 'agent') {
      item.append(renderBody(doc, text));
    } else {
      item.append(el(doc, 'p', { text }));
    }
    const fallback = fallbackNote(meta.tier, state.agent.name);
    if (fallback) item.append(el(doc, 'p', { class: 'da-fallback', text: fallback.text }));
    const notes = [meta.model, meta.tokens ? meta.tokens.input.toLocaleString() + ' in / ' + meta.tokens.output.toLocaleString() + ' out' : ''].filter(Boolean);
    if (notes.length) item.append(el(doc, 'span', { class: 'da-meta', text: notes.join(' · ') }));
    if (kind === 'agent' || kind === 'run') {
      const actions = el(doc, 'div', { class: 'da-actions' });
      const paste = el(doc, 'button', { type: 'button', class: 'toggle-button da-paste', 'data-to': state.other.id, text: state.agent.id === 'claude' ? 'Paste to Gemini →' : '← Paste to Claude' });
      paste.addEventListener('click', () => pasteTo(state.other.id, wrapRelay(pastePayload(text), settings)));
      actions.append(paste);
      item.append(actions);
      const choices = kind === 'agent' ? decisionOptions(text) : [];
      if (choices.length) {
        item.classList.add('da-gate');
        item.append(renderChoiceChips(doc, choices, (option) => sendTo(state, choiceReply(option))));
      }
    }
    state.feed.append(item);
    state.feed.scrollTop = state.feed.scrollHeight;
    return item;
  }

  // Auto-Send: hands a reply to the other agent, unless it asks you something or the hand-off limit is reached.
  async function relayFrom(state, text, gated) {
    if (settings.mode !== 'auto') return;
    if (gated) {
      status.textContent = 'Auto-Send is waiting: ' + state.agent.name + ' asked a question. Pick an answer under its reply.';
      return;
    }
    if (hops >= MAX_AUTO_HOPS) {
      status.textContent = 'Auto-Send paused after ' + MAX_AUTO_HOPS + ' hand-offs. Send a message to continue.';
      return;
    }
    const target = panes.get(state.other.id);
    if (target.busy) return;
    hops += 1;
    status.textContent = 'Auto-sent ' + state.agent.name + '’s reply to ' + target.agent.name + ' (' + hops + ' of ' + MAX_AUTO_HOPS + ').';
    await sendTo(target, wrapRelay(pastePayload(text), settings), { auto: true });
  }

  async function sendTo(state, text, { auto = false } = {}) {
    if (state.busy) return;
    if (!auto) hops = 0;
    let reply = null;
    let item = null;
    state.busy = true;
    state.send.disabled = true;
    addMessage(state, 'user', text);
    const typing = el(doc, 'li', { class: 'da-msg da-typing', text: state.agent.name + ' is thinking…' });
    state.feed.append(typing);
    try {
      reply = await api.sendMasterBrainChat(text, state.sessionId, { purpose: state.agent.purpose });
      typing.remove();
      item = addMessage(state, 'agent', reply.response, { model: reply.model, tier: reply.tier, tokens: reply.tokens });
      if (reply.model) {
        state.model.textContent = reply.model;
        // The route may fall back to another provider (no key for this one): say so instead of hiding it.
        const actual = providerOf(reply.model, reply.tier);
        state.model.dataset.mismatch = actual && actual !== state.agent.id ? 'true' : 'false';
        const fallback = fallbackNote(reply.tier, state.agent.name);
        state.model.textContent = actual && actual !== state.agent.id ? reply.model + (fallback ? ' (standing in)' : '') : reply.model;
        state.model.title = fallback ? fallback.text : actual && actual !== state.agent.id ? 'The engine routed this to ' + reply.model + ' (is a ' + state.agent.name + ' key set on the engine?).' : 'Answered by ' + reply.model;
      }
    } catch (error) {
      typing.remove();
      addMessage(state, 'error', error && error.isHalted ? 'Halted by the circuit breaker. Reset the agent to continue.' : describeEngineError(error));
    } finally {
      state.busy = false;
      state.send.disabled = false;
    }
    if (reply && item) await relayFrom(state, reply.response, item.classList.contains('da-gate'));
  }

  const visible = () => !container.closest('[hidden]');

  // Background step outputs from recent runs, routed to the feed of the model that answered.
  async function refresh() {
    if (destroyed) return;
    try {
      const tasks = ((await api.listTasks({ limit: 10 })).tasks || []).slice(0, 6);
      const records = (await Promise.all(tasks.map((t) => api.getTaskStatus(t.agent_id, t.task_id).catch(() => null)))).filter(Boolean);
      let items = backgroundItems(records).filter((item) => !seen.has(item.key));
      if (firstLoad) {
        const keep = new Set(AGENTS.flatMap((a) => items.filter((i) => i.agent === a.id).slice(-BACKLOG_PER_AGENT).map((i) => i.key)));
        items.forEach((i) => { if (!keep.has(i.key)) seen.add(i.key); });
        items = items.filter((i) => keep.has(i.key));
        firstLoad = false;
      }
      for (const item of items) {
        seen.add(item.key);
        addMessage(panes.get(item.agent), 'run', item.text, { title: item.title, model: item.model, tier: item.tier });
      }
      if (status.textContent.startsWith('Background')) status.textContent = '';
    } catch (error) {
      status.textContent = 'Background steps unavailable: ' + describeEngineError(error);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (destroyed) return;
    timer = setTimeout(async () => {
      if (visible()) await refresh();
      schedule();
    }, pollMs);
  }

  return {
    refresh,
    pasteTo,
    send: (agentId, text) => sendTo(panes.get(agentId), text),
    setMode,
    getSettings: () => ({ ...settings }),
    start() {
      refresh();
      schedule();
    },
    elements: { grid, status, panes, relayBar, modeButtons, wrappers, pre: pre.area, post: post.area },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      container.replaceChildren();
    },
  };
}
