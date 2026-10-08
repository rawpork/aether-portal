// New project: one front door. Four ways in, one way through.
//
//   [ Pick Template | Select Space Cards | Describe Goal | Paste Links ]  ->  "Ready to run?" review  ->  Approve & Run
//
// Every tab produces the same thing, a blueprint spec (blueprint-spec.js), which is compiled on the engine and then shown on one
// review card: the plan in plain words, what it will use (a token estimate and the budget, when there is one), whether the engine
// and a model key are ready, and a single Approve & Run. Nothing is spent until that button. The raw blueprint JSON still exists,
// under "Advanced" on Projects, for people who write specs by hand.
//
// The pure functions at the top (turning each tab's input into a spec, and a blueprint into plain-language plan lines) are
// exported so they can be tested without a page.

import { trapFocus, announce } from '../a11y.js';
import { parseBlueprintSpec } from './blueprint-spec.js';
import { runPreflight } from './outcomes.js';
import {
  AUTH_TYPES,
  BRIEF_SOURCE_URL,
  CATEGORIES,
  DATABASES,
  TEMPLATES,
  USAGE_KEY,
  briefToSpec,
  categoryOf,
  loadUsage,
  normalizeDomain,
  popularTemplates,
  templateDefaults,
} from './templates.js';

export const TABS = [
  { id: 'template', label: 'Pick Template' },
  { id: 'cards', label: 'Select Space Cards' },
  { id: 'goal', label: 'Describe Goal' },
  { id: 'links', label: 'Paste Links' },
];
export const DEFAULT_TAB = 'template';

export const MAX_CARDS = 13; // what Space's "Make it a project" packages too
export const MAX_LINKS = 20;
export const MAX_GOAL_CHARS = 4000;
export const MIN_GOAL_CHARS = 20;
export const NAME_MAX_CHARS = 120;

const DEFAULT_INTERVIEW = { database: 'cloudflare_d1', hosting: 'cloudflare_workers', unresolvedConnectors: [] };

const clean = (value) => String(value == null ? '' : value).trim();
const oneLine = (value) => clean(value).replace(/\s+/g, ' ');
const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

// ---- tab input -> spec ----

// The words of a goal, as a project name: "Build a landing page for my 3D printing shop" -> "Build a landing page for my 3D printing".
export function nameFromGoal(goal) {
  const words = oneLine(goal).replace(/[.!?]+$/, '').split(' ').slice(0, 7).join(' ');
  return truncate(words, 60) || 'New project';
}

export function goalToSpec({ name = '', goal = '' } = {}) {
  const text = clean(goal);
  return {
    projectName: truncate(oneLine(name), NAME_MAX_CHARS) || nameFromGoal(text),
    lodLevel: 2,
    useMiserlyProxy: false,
    links: [{ url: BRIEF_SOURCE_URL, title: 'Project goal', rawSnippet: truncate('Project goal from the operator: ' + oneLine(text), 1200) }],
    interviewResponses: { ...DEFAULT_INTERVIEW },
  };
}

// Pasted text -> the http(s) links in it, one title each (the host), de-duplicated; what could not be used is reported.
export function parseLinks(text) {
  const links = [];
  const invalid = [];
  const seen = new Set();
  for (const token of clean(text).split(/[\s,;]+/).filter(Boolean)) {
    let url;
    try {
      url = new URL(token);
    } catch {
      invalid.push(token);
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      invalid.push(token);
      continue;
    }
    const key = url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url: url.href, title: url.hostname.replace(/^www\./, '') });
  }
  return { links, invalid };
}

export function linksToSpec({ name = '', links = [] } = {}) {
  const host = links.length ? links[0].title : '';
  return {
    projectName: truncate(oneLine(name), NAME_MAX_CHARS) || (host ? 'Project from ' + host : 'New project'),
    lodLevel: 2,
    useMiserlyProxy: false,
    links: links.map((l) => ({ url: l.url, title: l.title })),
    interviewResponses: { ...DEFAULT_INTERVIEW },
  };
}

// Space's own packaging, for the cards picked here: a link card is its link; any other card is its /node page with the note
// text as the snippet.
export function cardsToSpec(cards, { origin = '', name = '' } = {}) {
  const picked = cards.slice(0, MAX_CARDS);
  const links = picked.map((card) => {
    const raw = String(card.url || '');
    const isHttp = /^https?:/i.test(raw);
    const snippet = [card.description, card.user_note, isHttp ? '' : raw, (card.tags || []).map((t) => '#' + (t.tag || t)).join(' ')].filter(Boolean).join(' · ');
    return {
      url: isHttp ? raw : origin + '/node/' + encodeURIComponent(card.id),
      title: truncate(String(card.title || card.name || 'Untitled'), 200),
      rawSnippet: truncate(snippet, 1200),
    };
  });
  const first = picked[0] ? String(picked[0].title || picked[0].name || '') : '';
  return {
    projectName: truncate(oneLine(name), NAME_MAX_CHARS) || truncate(oneLine(first), NAME_MAX_CHARS) || 'Project from Space',
    lodLevel: 2,
    useMiserlyProxy: false,
    links,
    interviewResponses: { ...DEFAULT_INTERVIEW },
  };
}

// ---- compiled blueprint -> plain language ----

// One line per phase: what happens, who does it. Phases come from the compiled blueprint.
export function planLines(bp) {
  return (bp.execution_phases || []).map((phase, i) => {
    const what = oneLine(phase.phase_name || 'Phase ' + (i + 1));
    const who = oneLine(phase.agent_role || '');
    const tools = (phase.required_mcp_tools || []).length;
    return { n: Number(phase.phase_index) || i + 1, what, who, tools };
  });
}

// "Elarion will read 3 sources, then work through 2 phases and produce 2 starter files."
export function planSummary(bp) {
  const sources = (bp.sources || []).length;
  const phases = (bp.execution_phases || []).length;
  const scaffold = Array.isArray(bp.project_scaffold) ? bp.project_scaffold : (bp.project_scaffold && Array.isArray(bp.project_scaffold.files) ? bp.project_scaffold.files : []);
  let text = 'Elarion will read ' + sources + (sources === 1 ? ' source' : ' sources') + ', then work through ' + phases + (phases === 1 ? ' phase' : ' phases');
  if (scaffold.length) text += ' and prepare ' + scaffold.length + (scaffold.length === 1 ? ' starter file' : ' starter files');
  return text + '.';
}

// ---- the dialog ----

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child) node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}

let counter = 0;

export function mountNewProject(doc, options = {}) {
  const win = doc.defaultView || globalThis;
  const api = options.api;
  // Pro is read when it matters (a plan can be made before the tier is known): a function, or a plain flag (default Pro).
  const isPro = () => (typeof options.pro === 'function' ? Boolean(options.pro()) : options.pro !== false);
  const storage = options.storage !== undefined ? options.storage : (() => { try { return win.localStorage; } catch { return null; } })();
  const portalFetch = options.portalFetch || ((url, init) => win.fetch(url, init));
  const origin = options.origin !== undefined ? options.origin : (win.location && win.location.origin) || '';
  const onCompiled = options.onCompiled || (() => {});
  const onRun = options.onRun || (async () => {});
  const onUpgrade = options.onUpgrade || (() => {});
  const id = 'np-' + ++counter;

  let scrim = null;
  let trap = null;
  let returnFocus = null;
  let tab = DEFAULT_TAB;
  let step = 'inputs'; // inputs | review
  let compiled = null; // { id, blueprint, sourceIds }
  let busy = false;
  let cards = null; // Space cards, once loaded
  let cardsError = '';
  const picked = new Set();
  let presetSpec = null; // a spec handed in (from Space's "Make it a project"): skips the tabs
  let presetSourceIds = [];

  // ---- the inputs of each tab ----
  const state = { template: TEMPLATES[0].id, brief: { projectName: '', domain: '', auth: '', database: '', notes: '' }, goalName: '', goal: '', linksName: '', linksText: '', cardName: '', cardSearch: '' };

  function panelFor(tabId) {
    return scrim && scrim.querySelector('[data-np-panel="' + tabId + '"]');
  }

  // Pick Template
  function renderTemplatePanel() {
    const panel = panelFor('template');
    const usage = loadUsage(storage);
    const popular = popularTemplates(usage).map((t) => t.id);
    const ordered = [...TEMPLATES].sort((a, b) => (popular.includes(b.id) ? 1 : 0) - (popular.includes(a.id) ? 1 : 0) || CATEGORIES.findIndex((c) => c.id === a.category) - CATEGORIES.findIndex((c) => c.id === b.category));
    const radios = ordered.map((t) => {
      const input = el(doc, 'input', { type: 'radio', name: id + '-template', value: t.id, id: id + '-t-' + t.id });
      input.checked = t.id === state.template;
      input.addEventListener('change', () => {
        state.template = t.id;
        state.brief.database = '';
        state.brief.auth = '';
        renderTemplatePanel();
      });
      return el(doc, 'label', { class: 'np-card', for: input.id, 'data-selected': String(t.id === state.template) }, [
        input,
        el(doc, 'span', { class: 'np-card-body' }, [
          el(doc, 'span', { class: 'np-card-title', text: t.name }),
          el(doc, 'span', { class: 'np-card-meta', text: categoryOf(t).name + (popular.includes(t.id) ? ' · Popular' : '') }),
          el(doc, 'span', { class: 'np-card-text', text: t.summary }),
        ]),
      ]);
    });
    const template = TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
    const defaults = templateDefaults(template);
    const select = (field, list, value) => {
      const node = el(doc, 'select', { id: id + '-' + field, 'data-field': field }, list.map((o) => el(doc, 'option', { value: o.id, text: o.label })));
      node.value = value;
      node.addEventListener('change', () => (state.brief[field] = node.value));
      return el(doc, 'div', { class: 'dc-select' }, [node]);
    };
    const name = el(doc, 'input', { type: 'text', id: id + '-pname', 'data-field': 'projectName', maxlength: String(NAME_MAX_CHARS), autocomplete: 'off', placeholder: template.name });
    name.value = state.brief.projectName;
    name.addEventListener('input', () => (state.brief.projectName = name.value));
    const domain = el(doc, 'input', { type: 'text', id: id + '-domain', 'data-field': 'domain', inputmode: 'url', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', placeholder: 'yourbrand.com (optional)' });
    domain.value = state.brief.domain;
    domain.addEventListener('input', () => (state.brief.domain = domain.value));
    const notes = el(doc, 'textarea', { id: id + '-notes', 'data-field': 'notes', rows: '3', maxlength: '1200', placeholder: categoryOf(template).notesHint || 'Anything Elarion should know (optional)' });
    notes.value = state.brief.notes;
    notes.addEventListener('input', () => (state.brief.notes = notes.value));
    const field = (label, control, hint) => el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: control.id || control.querySelector('select').id, text: label }), control, hint ? el(doc, 'p', { class: 'dc-hint', text: hint }) : null]);
    panel.replaceChildren(
      el(doc, 'fieldset', { class: 'np-cards' }, [el(doc, 'legend', { class: 'mc-visually-hidden', text: 'Template' }), ...radios]),
      el(doc, 'div', { class: 'np-brief' }, [
        el(doc, 'h3', { class: 'np-subhead', text: 'A few details for ' + template.name }),
        field('Project name', name),
        field('Target domain', domain, 'Optional. Without one it launches on free staging first.'),
        el(doc, 'div', { class: 'dc-row' }, [
          field('Sign-in', select('auth', AUTH_TYPES, state.brief.auth || defaults.auth)),
          field('Database', select('database', DATABASES, state.brief.database || defaults.database)),
        ]),
        field('Anything else', notes),
      ]),
    );
  }

  // Describe Goal
  function renderGoalPanel() {
    const panel = panelFor('goal');
    const goal = el(doc, 'textarea', { id: id + '-goal', 'data-field': 'goal', 'data-autofocus': '', rows: '7', maxlength: String(MAX_GOAL_CHARS), placeholder: 'What should this project achieve? For example: A landing page with a waitlist for my 3D-printed phone stands, with email sign-ups stored and spam blocked.' });
    goal.value = state.goal;
    const count = el(doc, 'p', { class: 'dc-hint', 'aria-live': 'polite' });
    const update = () => {
      state.goal = goal.value;
      count.textContent = clean(goal.value).length < MIN_GOAL_CHARS ? 'A sentence or two is enough: say what it is for and who it is for.' : clean(goal.value).length.toLocaleString('en-US') + ' of ' + MAX_GOAL_CHARS.toLocaleString('en-US') + ' characters';
    };
    goal.addEventListener('input', update);
    const name = el(doc, 'input', { type: 'text', id: id + '-gname', 'data-field': 'goalName', maxlength: String(NAME_MAX_CHARS), autocomplete: 'off', placeholder: 'Optional: a name for the project' });
    name.value = state.goalName;
    name.addEventListener('input', () => (state.goalName = name.value));
    update();
    panel.replaceChildren(
      el(doc, 'p', { class: 'dc-body', text: 'Say what you want in your own words. Elarion plans the work from it.' }),
      el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: goal.id, text: 'Your goal' }), goal, count]),
      el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: name.id, text: 'Project name' }), name]),
    );
  }

  // Paste Links
  function renderLinksPanel() {
    const panel = panelFor('links');
    const area = el(doc, 'textarea', { id: id + '-links', 'data-field': 'links', 'data-autofocus': '', rows: '7', spellcheck: 'false', autocapitalize: 'off', placeholder: 'https://developers.cloudflare.com/d1/\nhttps://github.com/owner/repo\nOne link per line' });
    area.value = state.linksText;
    const note = el(doc, 'p', { class: 'dc-hint', 'aria-live': 'polite' });
    const update = () => {
      state.linksText = area.value;
      const { links, invalid } = parseLinks(area.value);
      note.textContent = !clean(area.value) ? 'Documentation, repos, articles: whatever the project should be built from.' : links.length + (links.length === 1 ? ' link' : ' links') + ' found' + (invalid.length ? ', ' + invalid.length + ' skipped (not an http or https link)' : '') + '.';
    };
    area.addEventListener('input', update);
    const name = el(doc, 'input', { type: 'text', id: id + '-lname', 'data-field': 'linksName', maxlength: String(NAME_MAX_CHARS), autocomplete: 'off', placeholder: 'Optional: a name for the project' });
    name.value = state.linksName;
    name.addEventListener('input', () => (state.linksName = name.value));
    update();
    panel.replaceChildren(
      el(doc, 'p', { class: 'dc-body', text: 'Paste the links Elarion should read. It builds the plan from them.' }),
      el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: area.id, text: 'Links' }), area, note]),
      el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: name.id, text: 'Project name' }), name]),
    );
  }

  // Select Space Cards
  async function loadCards() {
    if (cards || busy) return;
    const panel = panelFor('cards');
    panel.replaceChildren(el(doc, 'p', { class: 'dc-body', role: 'status', text: 'Loading your cards from Space…' }));
    try {
      const response = await portalFetch('/api/graph', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      cards = (Array.isArray(data.nodes) ? data.nodes : []).filter((n) => n && n.id && n.category !== 'outcome');
      cardsError = '';
    } catch (error) {
      cards = [];
      cardsError = 'Could not load your cards from Space (' + (error && error.message ? error.message : 'offline') + ').';
    }
    renderCardsPanel();
  }

  function renderCardsPanel() {
    const panel = panelFor('cards');
    if (!cards) return;
    const search = el(doc, 'input', { type: 'search', id: id + '-csearch', 'data-field': 'cardSearch', autocomplete: 'off', autocapitalize: 'off', placeholder: 'Search your cards' });
    search.value = state.cardSearch;
    const needle = state.cardSearch.toLowerCase();
    const shown = cards.filter((c) => !needle || String(c.title || c.name || '').toLowerCase().includes(needle) || String(c.category || '').toLowerCase().includes(needle)).slice(0, 80);
    const status = el(doc, 'p', { class: 'dc-hint', role: 'status', 'aria-live': 'polite' });
    const setStatus = () => (status.textContent = picked.size ? picked.size + ' of ' + MAX_CARDS + ' cards chosen.' : 'Choose up to ' + MAX_CARDS + ' cards. Cards that are links are read as links; notes are read as text.');
    setStatus();
    const rows = shown.map((card) => {
      const box = el(doc, 'input', { type: 'checkbox', id: id + '-c-' + card.id, value: String(card.id) });
      box.checked = picked.has(String(card.id));
      box.addEventListener('change', () => {
        if (box.checked && picked.size >= MAX_CARDS) {
          box.checked = false;
          status.textContent = 'That is the most a project can start from (' + MAX_CARDS + '). Remove one first.';
          return;
        }
        if (box.checked) picked.add(String(card.id));
        else picked.delete(String(card.id));
        setStatus();
      });
      return el(doc, 'label', { class: 'np-row', for: box.id }, [
        box,
        el(doc, 'span', { class: 'np-card-body' }, [
          el(doc, 'span', { class: 'np-card-title', text: String(card.title || card.name || 'Untitled') }),
          el(doc, 'span', { class: 'np-card-meta', text: String(card.category || 'note') }),
        ]),
      ]);
    });
    const name = el(doc, 'input', { type: 'text', id: id + '-cname', 'data-field': 'cardName', maxlength: String(NAME_MAX_CHARS), autocomplete: 'off', placeholder: 'Optional: a name for the project' });
    name.value = state.cardName;
    name.addEventListener('input', () => (state.cardName = name.value));
    search.addEventListener('input', () => {
      state.cardSearch = search.value;
      renderCardsPanel();
      const again = panelFor('cards').querySelector('[data-field="cardSearch"]');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    });
    panel.replaceChildren(
      el(doc, 'p', { class: 'dc-body', text: 'Build a project from cards you have already saved in Space.' }),
      cardsError ? el(doc, 'p', { class: 'dc-warn', role: 'alert', text: cardsError }) : null,
      el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: search.id, text: 'Find a card' }), search]),
      status,
      shown.length ? el(doc, 'div', { class: 'np-list', role: 'group', 'aria-label': 'Your cards' }, rows) : el(doc, 'p', { class: 'np-empty', text: cards.length ? 'No card matches that search.' : cardsError ? '' : 'You have no cards yet. Save some in Space first, or start another way.' }),
      el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: name.id, text: 'Project name' }), name]),
    );
  }

  // ---- inputs -> spec ----
  // { ok, spec, sourceIds } or { ok: false, message, tab }
  function buildSpec() {
    if (presetSpec) return { ok: true, spec: presetSpec, sourceIds: presetSourceIds };
    if (tab === 'template') {
      const template = TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
      const brief = { ...state.brief, auth: state.brief.auth || templateDefaults(template).auth, database: state.brief.database || templateDefaults(template).database };
      if (clean(state.brief.domain) && !normalizeDomain(state.brief.domain)) return { ok: false, message: 'That does not look like a domain. Use something like yourbrand.com, or leave it empty.', field: 'domain' };
      return { ok: true, spec: briefToSpec(template, brief), sourceIds: [], template };
    }
    if (tab === 'goal') {
      if (clean(state.goal).length < MIN_GOAL_CHARS) return { ok: false, message: 'Say a little more about the goal (at least ' + MIN_GOAL_CHARS + ' characters).', field: 'goal' };
      return { ok: true, spec: goalToSpec({ name: state.goalName, goal: state.goal }), sourceIds: [] };
    }
    if (tab === 'links') {
      const { links } = parseLinks(state.linksText);
      if (!links.length) return { ok: false, message: 'Paste at least one http or https link.', field: 'links' };
      if (links.length > MAX_LINKS) return { ok: false, message: 'That is ' + links.length + ' links; a project can start from ' + MAX_LINKS + '. Remove some.', field: 'links' };
      return { ok: true, spec: linksToSpec({ name: state.linksName, links }), sourceIds: [] };
    }
    const chosen = (cards || []).filter((c) => picked.has(String(c.id)));
    if (!chosen.length) return { ok: false, message: 'Choose at least one card.', field: 'cardSearch' };
    return { ok: true, spec: cardsToSpec(chosen, { origin, name: state.cardName }), sourceIds: chosen.map((c) => String(c.id)) };
  }

  // ---- the shell ----
  const parts = {};

  function build() {
    const tabButtons = TABS.map((t, i) => el(doc, 'button', { type: 'button', role: 'tab', id: id + '-tab-' + t.id, 'data-np-tab': t.id, 'aria-controls': id + '-panel-' + t.id, 'aria-selected': 'false', tabindex: '-1', text: t.label }));
    const panels = TABS.map((t) => el(doc, 'div', { class: 'dc-ingest np-panel', role: 'tabpanel', id: id + '-panel-' + t.id, 'aria-labelledby': id + '-tab-' + t.id, 'data-np-panel': t.id, hidden: true }));
    parts.tabs = tabButtons;
    parts.error = el(doc, 'p', { class: 'dc-warn np-error', role: 'alert', hidden: true });
    parts.inputs = el(doc, 'div', { class: 'np-inputs' }, [el(doc, 'div', { class: 'np-seg', role: 'tablist', 'aria-label': 'How do you want to start?' }, tabButtons), ...panels]);
    parts.review = el(doc, 'div', { class: 'np-review-wrap', hidden: true });
    parts.next = el(doc, 'button', { type: 'button', class: 'bp-primary np-next', text: 'Review plan' });
    parts.back = el(doc, 'button', { type: 'button', class: 'toggle-button np-back', text: 'Back', hidden: true });
    parts.cancel = el(doc, 'button', { type: 'button', class: 'toggle-button np-cancel', text: 'Cancel' });
    const close = el(doc, 'button', { type: 'button', class: 'np-close', 'aria-label': 'Close', title: 'Close', text: '×' });
    parts.close = close;
    const titleId = id + '-title';
    scrim = el(doc, 'div', { class: 'np-scrim' }, [
      el(doc, 'div', { class: 'np-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
        el(doc, 'div', { class: 'np-head' }, [el(doc, 'h2', { id: titleId, class: 'np-title', text: 'New project' }), close]),
        parts.inputs,
        parts.review,
        parts.error,
        el(doc, 'div', { class: 'np-foot' }, [parts.cancel, el(doc, 'span', { class: 'mc-spacer' }), parts.back, parts.next]),
      ]),
    ]);

    tabButtons.forEach((button, i) => {
      button.addEventListener('click', () => selectTab(button.dataset.npTab, true));
      button.addEventListener('keydown', (event) => {
        const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : 0;
        if (!move) return;
        event.preventDefault();
        const next = move === 'first' ? 0 : move === 'last' ? tabButtons.length - 1 : (i + move + tabButtons.length) % tabButtons.length;
        selectTab(tabButtons[next].dataset.npTab, true);
      });
    });
    parts.next.addEventListener('click', () => (step === 'inputs' ? review() : approve()));
    parts.back.addEventListener('click', () => backToInputs());
    parts.cancel.addEventListener('click', () => api_.close());
    close.addEventListener('click', () => api_.close());
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim && !busy) api_.close();
    });
    scrim.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        api_.close();
      }
    });
  }

  function showError(message, field) {
    parts.error.textContent = message;
    parts.error.hidden = !message;
    if (message && field) {
      const target = scrim.querySelector('[data-field="' + field + '"]');
      if (target) {
        target.setAttribute('aria-invalid', 'true');
        target.addEventListener('input', () => target.removeAttribute('aria-invalid'), { once: true });
        target.focus();
      }
    }
  }

  function selectTab(tabId, focus = false) {
    tab = tabId;
    for (const button of parts.tabs) {
      const on = button.dataset.npTab === tabId;
      button.setAttribute('aria-selected', String(on));
      button.setAttribute('tabindex', on ? '0' : '-1');
      if (on && focus) button.focus();
    }
    for (const panel of scrim.querySelectorAll('[data-np-panel]')) panel.hidden = panel.dataset.npPanel !== tabId;
    showError('');
    if (tabId === 'template') renderTemplatePanel();
    else if (tabId === 'goal') renderGoalPanel();
    else if (tabId === 'links') renderLinksPanel();
    else if (cards) renderCardsPanel();
    else loadCards();
  }

  // ---- step 2: the review ----
  async function review() {
    if (busy) return;
    showError('');
    const built = buildSpec();
    if (!built.ok) return showError(built.message, built.field);
    const checked = parseBlueprintSpec(JSON.stringify(built.spec));
    if (!checked.ok) return showError('That cannot be made into a project yet: ' + checked.errors.map((e) => e.message).join(' '), null);

    setBusy(true, 'Planning…');
    let result;
    try {
      result = await api.compileBlueprint(checked.spec);
    } catch (error) {
      setBusy(false);
      const detail = error && error.body && Array.isArray(error.body.validation_errors) ? error.body.validation_errors.map((e) => e.message).join(' ') : error && error.isUnreachable ? 'Can’t reach the Aether Engine. Is it running?' : (error && error.message) || 'The engine returned an error.';
      return showError('Could not plan the project: ' + detail);
    }
    const blueprint = result.blueprint || {};
    compiled = { id: result.blueprint_id, blueprint, sourceIds: built.sourceIds, template: built.template || null };
    if (built.template && storage) {
      const usage = loadUsage(storage);
      usage[built.template.id] = (Number(usage[built.template.id]) || 0) + 1;
      try { storage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch { /* storage blocked */ }
    }
    try { onCompiled(result.blueprint_id, blueprint, { sourceIds: built.sourceIds }); } catch { /* the list refreshing must not stop the review */ }
    setBusy(false);
    await renderReview();
  }

  async function renderReview() {
    const bp = compiled.blueprint;
    step = 'review';
    parts.inputs.hidden = true;
    parts.review.hidden = false;
    parts.next.hidden = false;
    parts.next.textContent = 'Approve & Run';
    parts.next.classList.remove('np-upgrade');
    parts.back.hidden = false;
    parts.back.textContent = 'Edit';
    scrim.querySelector('.np-title').textContent = 'Ready to run?';

    const lines = planLines(bp);
    const phases = lines.length;
    const checkList = el(doc, 'ul', { class: 'bp-checks np-checks' }, [el(doc, 'li', { class: 'bp-check', 'data-ok': 'pending', text: 'Checking the engine…' })]);
    const estimate = el(doc, 'p', { class: 'np-estimate', text: 'Estimating…' });
    const website = el(doc, 'input', { type: 'checkbox', class: 'bp-website-box', id: id + '-website' });
    website.checked = /\b(web ?site|web ?page|landing page|home ?page)\b/i.test([bp.project_name, ...(bp.execution_phases || []).map((p) => p.phase_name + ' ' + (p.prompt_template || ''))].join(' ')) || Boolean(compiled.template && compiled.template.website);
    parts.website = website;
    parts.review.replaceChildren(
      el(doc, 'section', { class: 'np-review', 'aria-labelledby': id + '-rtitle' }, [
        el(doc, 'h3', { id: id + '-rtitle', class: 'np-project', text: bp.project_name || 'Your project' }),
        el(doc, 'p', { class: 'dc-body', text: planSummary(bp) }),
        el(doc, 'h4', { class: 'np-subhead', text: 'The plan' }),
        lines.length ? el(doc, 'ol', { class: 'np-plan' }, lines.map((l) => el(doc, 'li', {}, [el(doc, 'strong', { text: l.what }), l.who ? doc.createTextNode(' · ' + l.who) : null]))) : el(doc, 'p', { class: 'dc-hint', text: 'Elarion decides the steps when it starts.' }),
        el(doc, 'h4', { class: 'np-subhead', text: 'What it will use' }),
        estimate,
        el(doc, 'h4', { class: 'np-subhead', text: 'Ready?' }),
        checkList,
        el(doc, 'label', { class: 'bp-website', for: website.id }, [website, el(doc, 'span', {}, [el(doc, 'strong', { text: 'Deliver a live website' }), doc.createTextNode(' · hosted by Aether; you preview it and it goes public only when you approve it.')])]),
        el(doc, 'p', { class: 'dc-hint', text: 'Nothing is spent until you press Approve & Run.' }),
      ]),
    );
    announce('Plan ready. Review it, then approve to run.');

    // Free accounts can plan and review but not run: the button says so instead of failing later.
    const pro = isPro();
    if (!pro) {
      parts.next.textContent = 'Approve & Run (Pro)';
      parts.next.classList.add('np-upgrade');
    }
    parts.next.disabled = true;
    const { checks, canRun } = await runPreflight({ api, phases, budgetCapUsd: bp.miserly_integration && bp.miserly_integration.enabled ? bp.miserly_integration.budget_cap_usd : null });
    const est = checks.find((c) => c.id === 'estimate');
    estimate.textContent = est ? est.detail : phases + (phases === 1 ? ' phase' : ' phases');
    const budget = checks.find((c) => c.id === 'budget');
    if (budget) estimate.textContent += ' ' + budget.detail;
    checkList.replaceChildren(
      ...checks.filter((c) => c.id !== 'estimate' && c.id !== 'budget').map((check) =>
        el(doc, 'li', { class: 'bp-check', 'data-ok': check.ok === true ? 'yes' : check.ok === false ? 'no' : 'note' }, [
          el(doc, 'span', { class: 'bp-check-mark', 'aria-hidden': 'true', text: check.ok === true ? '✓' : check.ok === false ? '✕' : '•' }),
          el(doc, 'strong', { text: check.label }),
          doc.createTextNode(' ' + check.detail),
        ]),
      ),
    );
    // A free account can always press the button (it explains the upgrade); a Pro account only when the checks allow a run.
    parts.next.disabled = pro ? !canRun : false;
    parts.canRun = canRun;
    if (!parts.next.disabled) parts.next.focus();
  }

  function backToInputs() {
    if (busy) return;
    step = 'inputs';
    parts.inputs.hidden = false;
    parts.review.hidden = true;
    parts.next.textContent = 'Review plan';
    parts.next.classList.remove('np-upgrade');
    parts.next.disabled = false;
    parts.back.hidden = true;
    scrim.querySelector('.np-title').textContent = 'New project';
    presetSpec = null;
    selectTab(tab, true);
  }

  async function approve() {
    if (busy || !compiled) return;
    if (!isPro()) {
      onUpgrade(compiled.blueprint);
      return;
    }
    const { id: blueprintId, blueprint } = compiled;
    const withWebsite = Boolean(parts.website && parts.website.checked);
    setBusy(true, 'Starting…');
    // The run follows itself for as long as it takes: the dialog closes now and the project's own page shows the progress.
    let started;
    try {
      started = onRun(blueprint, { website: withWebsite, sourceIds: compiled.sourceIds });
    } catch (error) {
      setBusy(false);
      return showError('Could not start the run: ' + ((error && error.message) || 'unknown error'));
    }
    setBusy(false);
    api_.close();
    announce('Started ' + (blueprint.project_name || 'the project') + '.');
    if (options.onStarted) options.onStarted(blueprintId, blueprint);
    // The run reports its own progress and failures; a rejection here must not become an unhandled one.
    return Promise.resolve(started).catch(() => {});
  }

  function setBusy(on, label) {
    busy = on;
    for (const button of [parts.next, parts.back, parts.cancel, parts.close]) button.disabled = on;
    for (const button of parts.tabs) button.disabled = on;
    if (on) {
      parts.next.dataset.label = parts.next.textContent;
      parts.next.textContent = label || 'Working…';
      scrim.setAttribute('aria-busy', 'true');
    } else {
      if (parts.next.dataset.label) parts.next.textContent = parts.next.dataset.label;
      delete parts.next.dataset.label;
      scrim.removeAttribute('aria-busy');
    }
  }

  const api_ = {
    // Opens the dialog on a tab (Pick Template by default).
    open(tabId = DEFAULT_TAB) {
      if (scrim) return;
      returnFocus = doc.activeElement;
      compiled = null;
      step = 'inputs';
      presetSpec = null;
      build();
      doc.body.append(scrim);
      trap = trapFocus(scrim.querySelector('.np-modal'), { returnTo: returnFocus });
      selectTab(TABS.some((t) => t.id === tabId) ? tabId : DEFAULT_TAB);
      const first = scrim.querySelector('[data-np-panel]:not([hidden]) [data-autofocus]') || parts.tabs.find((b) => b.getAttribute('aria-selected') === 'true');
      if (first) first.focus({ preventScroll: true });
    },
    // Opens straight on the review for a spec made elsewhere (Space's "Make it a project").
    async openWithSpec(spec, { sourceIds = [] } = {}) {
      api_.open('template');
      presetSpec = spec;
      presetSourceIds = sourceIds;
      await review();
    },
    close() {
      if (!scrim) return;
      if (trap) trap.release({ restore: true });
      trap = null;
      scrim.remove();
      scrim = null;
      busy = false;
      compiled = null;
    },
    isOpen: () => Boolean(scrim),
    getState: () => ({ tab, step, busy, compiled, picked: [...picked] }),
    get element() {
      return scrim;
    },
    destroy() {
      api_.close();
    },
  };
  return api_;
}
