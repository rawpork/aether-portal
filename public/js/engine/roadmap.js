// Roadmap (Mission Control rail): the project's goals from ROADMAP.md and recent Claude Code sessions, read by the
// engine on its computer (GET /api/roadmap). Shows overall progress, the active goals (open top-level items with
// their sub-step progress), every phase as a progress row that opens to its goals, recent sessions (title, when,
// live now) and the memory notes. Refreshes when opened and every minute while visible.
import { getEngineApi } from '../engine-api.bundle.js';
import { describeEngineError } from './operator-console.js';

export const REFRESH_MS = 60000;
// Where a roadmap link to a file in the repo (specs/ui/01-node-canvas.md) opens. The roadmap is read from the engine's
// computer, so this is a default for this project's repository; pass options.linkBase to point somewhere else.
export const DEFAULT_LINK_BASE = 'https://github.com/rawpork/aether-portal/blob/main/';
const ACTIVE_GOALS_MAX = 8;

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

// Roadmap goals are written in markdown, so a goal can carry "[spec 01](specs/ui/01-node-canvas.md)". This splits text into
// plain pieces and links: [{ text }, { text, href }]. Only [label](target) is read; anything else stays as written.
export function parseMarkdownLinks(text) {
  const parts = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of String(text == null ? '' : text).matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: match[1], href: match[2] });
    last = match.index + match[0].length;
  }
  if (last < String(text == null ? '' : text).length) parts.push({ text: String(text).slice(last) });
  return parts;
}

// The same text without the markdown: "Step 4.1 (spec 01)". For labels and tooltips, where the link syntax is noise.
export const plainText = (text) => parseMarkdownLinks(text).map((part) => part.text).join('');

// Where a link goes, or null when it is not safe or sensible to open: http(s) addresses as they are, a repo path against the
// base, anything else (javascript:, mailto:, protocol-relative, absolute paths) not at all.
export function resolveLink(href, linkBase = DEFAULT_LINK_BASE) {
  if (/^https?:\/\//i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/') || !linkBase) return null;
  return linkBase + href.replace(/^\.\//, '');
}

const percent = (done, total) => (total ? Math.round((done / total) * 100) : 0);

// "5 min ago", "3 h ago", "2 d ago" from an ISO time.
export function ago(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.round(ms / 60000) + ' min ago';
  if (ms < 86400000) return Math.round(ms / 3600000) + ' h ago';
  return Math.round(ms / 86400000) + ' d ago';
}

// Totals and the active goals: open top-level goals from phases that are not finished, in roadmap order.
export function summarize(roadmap) {
  const phases = (roadmap && roadmap.phases) || [];
  const done = phases.reduce((n, p) => n + p.done, 0);
  const total = phases.reduce((n, p) => n + p.total, 0);
  const active = [];
  for (const phase of phases) {
    for (const goal of phase.goals) if (!goal.done) active.push({ phase: phase.title, ...goal });
  }
  return { done, total, percent: percent(done, total), active, openPhases: phases.filter((p) => p.done < p.total).length };
}

function bar(doc, done, total, label) {
  const value = percent(done, total);
  return el(doc, 'div', { class: 'rm-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(value) }, [
    el(doc, 'span', { class: 'rm-bar-fill', style: 'width:' + value + '%' }),
  ]);
}

export function mountRoadmap(container, options = {}) {
  const doc = container.ownerDocument;
  const linkBase = options.linkBase === undefined ? DEFAULT_LINK_BASE : options.linkBase;
  // Goal text as nodes: a real named link for each [label](target), the label alone when the target cannot be opened.
  const goalNodes = (text) => parseMarkdownLinks(text).map((part) => {
    if (!part.href) return doc.createTextNode(part.text);
    const target = resolveLink(part.href, linkBase);
    if (!target) return doc.createTextNode(part.text);
    const external = /^https?:\/\//i.test(part.href);
    return el(doc, 'a', {
      class: 'rm-link',
      href: target,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': part.text + (external ? '' : ', file ' + part.href) + ' (opens in a new tab)',
      text: part.text,
    });
  });
  const api = options.api || getEngineApi();
  const now = options.now || (() => Date.now());
  const status = el(doc, 'span', { class: 'mc-muted', 'aria-live': 'polite' });
  const refreshButton = el(doc, 'button', { type: 'button', class: 'toggle-button rm-refresh', text: 'Refresh' });
  const body = el(doc, 'div', { class: 'rm-body' });
  container.replaceChildren(el(doc, 'section', { class: 'surface mc-panel rm', 'aria-labelledby': 'rm-title' }, [
    el(doc, 'div', { class: 'mc-panel-head' }, [el(doc, 'h2', { id: 'rm-title', text: 'Roadmap' }), el(doc, 'div', { class: 'rm-head-actions' }, [status, refreshButton])]),
    body,
  ]));
  let destroyed = false;
  let timer = null;
  refreshButton.addEventListener('click', () => refresh());

  function render(report) {
    const parts = [];
    const roadmap = report.roadmap;
    if (roadmap) {
      const sum = summarize(roadmap);
      parts.push(el(doc, 'div', { class: 'rm-overall' }, [
        el(doc, 'div', { class: 'rm-overall-text' }, [
          el(doc, 'strong', { class: 'rm-percent', text: sum.percent + '%' }),
          el(doc, 'span', { class: 'mc-muted', text: sum.done + ' of ' + sum.total + ' goals done · ' + sum.openPhases + ' open ' + (sum.openPhases === 1 ? 'phase' : 'phases') + ' · ' + roadmap.file + (roadmap.updated_at ? ' updated ' + ago(roadmap.updated_at, now()) : '') }),
        ]),
        bar(doc, sum.done, sum.total, 'Overall progress'),
      ]));
      parts.push(el(doc, 'h3', { class: 'rm-sub', text: 'Active goals' }));
      parts.push(sum.active.length
        ? el(doc, 'ul', { class: 'rm-goals' }, sum.active.slice(0, ACTIVE_GOALS_MAX).map((goal) => el(doc, 'li', { class: 'rm-goal' }, [
          el(doc, 'span', { class: 'rm-goal-text' }, goalNodes(goal.text)),
          el(doc, 'span', { class: 'mc-muted rm-goal-phase', text: goal.phase + (goal.children.total ? ' · ' + goal.children.done + '/' + goal.children.total + ' sub-steps' : '') }),
          goal.children.total ? bar(doc, goal.children.done, goal.children.total, plainText(goal.text) + ' sub-steps') : doc.createTextNode(''),
        ])))
        : el(doc, 'p', { class: 'mc-muted', text: 'Every goal in the roadmap is done.' }));
      if (sum.active.length > ACTIVE_GOALS_MAX) parts.push(el(doc, 'p', { class: 'mc-muted rm-more', text: '+' + (sum.active.length - ACTIVE_GOALS_MAX) + ' more open goals in the phases below.' }));
      parts.push(el(doc, 'h3', { class: 'rm-sub', text: 'Phases' }));
      parts.push(el(doc, 'div', { class: 'rm-phases' }, roadmap.phases.map((phase) => el(doc, 'details', { class: 'rm-phase', 'data-complete': String(phase.done === phase.total) }, [
        el(doc, 'summary', {}, [
          el(doc, 'span', { class: 'rm-phase-title', text: phase.title }),
          el(doc, 'span', { class: 'mc-muted rm-phase-count', text: phase.done + '/' + phase.total }),
          bar(doc, phase.done, phase.total, phase.title),
        ]),
        el(doc, 'ul', { class: 'rm-phase-goals' }, phase.goals.map((goal) => el(doc, 'li', { 'data-done': String(goal.done) }, [
          el(doc, 'span', { class: 'rm-check', 'aria-hidden': 'true', text: goal.done ? '✓' : '○' }),
          el(doc, 'span', {}, [...goalNodes(goal.text), doc.createTextNode((goal.completed_on ? ' · ' + goal.completed_on : '') + (goal.children.total ? ' (' + goal.children.done + '/' + goal.children.total + ')' : ''))]),
        ]))),
      ]))));
    } else {
      parts.push(el(doc, 'p', { class: 'rm-error', text: report.roadmap_error || 'No roadmap found.' }));
    }
    parts.push(el(doc, 'h3', { class: 'rm-sub', text: 'Recent sessions' }));
    parts.push(report.sessions && report.sessions.length
      ? el(doc, 'ul', { class: 'rm-sessions' }, report.sessions.map((s) => el(doc, 'li', { class: 'rm-session', 'data-active': String(s.active) }, [
        el(doc, 'span', { class: 'rm-session-title', text: s.title }),
        el(doc, 'span', { class: 'mc-muted rm-session-meta', text: (s.active ? 'active now · ' : '') + s.project + ' · ' + ago(s.last_active_at, now()) + ' · ' + (s.size_kb >= 1024 ? (s.size_kb / 1024).toFixed(1) + ' MB' : s.size_kb + ' KB') }),
      ])))
      : el(doc, 'p', { class: 'mc-muted', text: 'No Claude Code sessions found for these projects on the engine’s computer.' }));
    if (report.memory && report.memory.length) {
      parts.push(el(doc, 'h3', { class: 'rm-sub', text: 'Remembered' }));
      parts.push(el(doc, 'ul', { class: 'rm-memory' }, report.memory.map((m) => el(doc, 'li', {}, [el(doc, 'strong', { text: m.title }), doc.createTextNode(m.hook ? ' — ' + m.hook : '')]))));
    }
    body.replaceChildren(...parts);
  }

  async function refresh() {
    if (destroyed) return null;
    status.textContent = 'Loading…';
    refreshButton.disabled = true;
    try {
      const report = await api.getRoadmap();
      render(report);
      status.textContent = '';
      return report;
    } catch (error) {
      status.textContent = '';
      body.replaceChildren(el(doc, 'p', { class: 'rm-error', text: error && error.status === 404 ? 'This engine has no roadmap route yet. Restart it on the latest version.' : describeEngineError(error) }));
      return null;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (destroyed) return;
    timer = setTimeout(async () => {
      if (!container.closest('[hidden]')) await refresh();
      schedule();
    }, REFRESH_MS);
  }

  return {
    refresh,
    start() {
      refresh();
      schedule();
    },
    elements: { body, status },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      container.replaceChildren();
    },
  };
}
