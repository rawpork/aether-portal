// Decision center (every Mission Control view): the "Do this next" banner above the views, and numbered choice
// popups whenever the operator has something to decide, so the next step is always one tap (or one number key) away.
// - Elarion asks (a run waits on a choice step): the question with its options, answered on the engine.
// - A project run finishes, fails or is halted: what to do about it.
// - Skill ingestion ("add repo <url>", "add skill <url or text>", "learn <...>"): Elarion reads the source and drafts
//   a SKILL.md; Save / Edit first / Discard. Saved skills land in Aether_Engine/skills/<name>/SKILL.md.
// - A finished run whose sandbox build passed and scored as viable: "Where would you like to launch this live?"
//   (keep it on free staging, attach your own domain on Cloudflare, or a recommended host).
// Popups open only for things that happen while the page is open (runs that finished earlier don't pop up), one at
// a time. Number keys pick, arrow keys move, Esc closes the ones that can wait.
import { getEngineApi } from '../engine-api.bundle.js';
import { describeEngineError } from './operator-console.js';
import { nextAction } from './workforce.js';
import { taskTitle } from './labels.js';
import { pollDelay } from './poll-rate.js';
import { mountIngestForm } from './ingest-form.js';
import { buildAgentSpec, mountAgentSpecForm, specFileName, specToJson, specToMarkdown } from './agent-spec.js';

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

// Where the "Do this next" banner belongs. Never on the page its own button leads to ("Open Projects" while Projects is open is
// advice about where you already are). The overview shows it otherwise. Anywhere else it shows only when something urgent blocks
// the work (the engine, the key, a question waiting); suggestions to start or review a project belong on the overview alone.
export function bannerVisibleOn(action, view) {
  if (!action) return false;
  if (action.action && action.action.view === view) return false;
  if (view === 'overview') return true;
  return (action.kind === 'warn' || action.kind === 'alert') && Boolean(action.action);
}

// A banner is identified by what it says, so a dismissed one stays gone until the situation (and so the message) changes.
export const DISMISSED_KEY = 'aether.mc.bannerDismissed';
export const bannerKey = (action) => [action.kind, action.title, action.text].join('|');
const MAX_DISMISSED = 30;

export function mountDecisionCenter(doc, options = {}) {
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const slot = options.slot || null;
  const onNavigate = options.onNavigate || (() => {});
  // The engine's setup summary (key state), read each time the banner is drawn; undefined until it is known.
  const getSetup = options.getSetup || (() => undefined);
  let view = options.view || 'overview';
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
  // Banners the operator dismissed (see bannerKey).
  let dismissed = [];
  try {
    const stored = JSON.parse((storage && storage.getItem && storage.getItem(DISMISSED_KEY)) || '[]');
    if (Array.isArray(stored)) dismissed = stored.map(String).slice(-MAX_DISMISSED);
  } catch { /* nothing remembered */ }

  // ---- choice popup

  // Shows a popup and resolves with the picked option's index, or -1 when it was closed. options: [{ label, hint? }].
  // beforeClose(index) may return false to keep the popup open (a form that still has something to fix).
  function choose({ title, body = null, options: choices, dismissible = true, kind = 'note', beforeClose = null }) {
    return new Promise((resolve) => {
      queue.push({ title, body, choices, dismissible, kind, beforeClose, resolve });
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
      if (Number.isInteger(n) && n >= 1 && n <= buttons.length && !(event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) {
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
        const focusables = [...modal.querySelectorAll('button, textarea, a[href], input, select')].filter((n) => !n.disabled);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      if (item.beforeClose && item.beforeClose(i) === false) return;
      close(i);
    }));
    if (item.dismissible) scrim.addEventListener('click', (event) => { if (event.target === scrim) close(-1); });
    doc.addEventListener('keydown', onKey, true);
    open = { scrim, close };
    doc.body.append(scrim);
    (modal.querySelector('[data-autofocus]') || modal.querySelector('textarea') || buttons[0]).focus({ preventScroll: true });
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

  // source: a link or text; opts.name: a hint for the skill's name.
  async function learn(source, opts = {}) {
    const working = progress('Learning a new skill', 'Elarion is reading ' + (/^https?:\/\//i.test(source) ? source : 'your text') + ' and writing a SKILL.md. This takes up to a minute.');
    let result;
    try {
      result = await api.ingestSkill(source, opts.name ? { name: opts.name } : {});
    } catch (e) {
      working.close();
      await choose({ title: 'Could not learn from that', body: describeEngineError(e), options: [{ label: 'OK' }], kind: 'warn' });
      return null;
    }
    working.close();
    return reviewDraft(result.draft, result.exists);
  }

  // The + Skill button: a template picks the defaults, the operator fills a title, a tag, the content, a target agent and a
  // priority, and the form compiles to the engine's { source, name } (src/ingest-form.js). A form with a problem stays open.
  async function askSource() {
    const form = mountIngestForm(doc);
    let payload = null;
    const intro = el(doc, 'p', { class: 'dc-body', text: 'Give Elarion a link, or paste text, and say what it is. It writes a SKILL.md for you to review before anything is saved.' });
    const pick = await choose({
      title: 'Learn a skill',
      body: el(doc, 'div', { class: 'dc-ingest-wrap' }, [intro, form.element]),
      options: [{ label: 'Learn it', hint: 'Takes up to a minute' }, { label: 'Cancel' }],
      beforeClose: (index) => {
        if (index !== 0) return true;
        const checked = form.validate();
        if (!checked.ok) return false;
        payload = checked.payload;
        return true;
      },
    });
    if (pick !== 0 || !payload) return null;
    return learn(payload.source, payload.name ? { name: payload.name } : {});
  }

  // ---- agent spec

  // Copies text: the clipboard API where the page may use it, else the old select-and-copy. Returns whether it worked.
  async function copyText(text) {
    if (options.copyText) return options.copyText(text);
    try {
      if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
        await win.navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the older way */
    }
    try {
      const scratch = el(doc, 'textarea', { 'aria-hidden': 'true', tabindex: '-1', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
      scratch.value = text;
      doc.body.append(scratch);
      scratch.select();
      const done = doc.execCommand && doc.execCommand('copy');
      scratch.remove();
      return Boolean(done);
    } catch {
      return false;
    }
  }

  // Saves text as a file download. Returns whether it could start one.
  function saveFile(name, text, type) {
    if (options.saveFile) return options.saveFile(name, text, type);
    try {
      const url = win.URL.createObjectURL(new win.Blob([text], { type }));
      const link = el(doc, 'a', { href: url, download: name, hidden: true });
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => win.URL.revokeObjectURL(url), 1000);
      return true;
    } catch {
      return false;
    }
  }

  // The Agent spec button: a form for the agent's role, what it may do and its guardrails, then the spec to copy or download.
  // Nothing is created or started; the popup says so, and the result says how a spec gets used.
  async function askAgentSpec() {
    let values = null;
    for (;;) {
      const form = mountAgentSpecForm(doc, { values });
      let checked = null;
      const intro = el(doc, 'p', { class: 'dc-body', text: 'Describe an agent: its role, how it should work and what it may do. This writes a spec you can copy or download. Nothing starts: an agent runs when a project that uses it is deployed, or as an agent in a Studio workflow.' });
      const pick = await choose({
        title: 'Agent spec',
        body: el(doc, 'div', { class: 'dc-ingest-wrap' }, [intro, form.element]),
        options: [{ label: 'Generate spec', hint: 'Starts nothing' }, { label: 'Cancel' }],
        beforeClose: (index) => {
          if (index !== 0) return true;
          const result = form.validate();
          if (!result.ok) return false;
          checked = result.form;
          return true;
        },
      });
      if (pick !== 0 || !checked) return null;
      values = checked;

      const spec = buildAgentSpec(checked);
      const json = specToJson(spec);
      const brief = specToMarkdown(spec);
      const status = el(doc, 'p', { class: 'dc-hint dc-spec-status', role: 'status', 'aria-live': 'polite' });
      const preview = el(doc, 'pre', { class: 'dc-preview', text: brief });
      const result = await choose({
        title: 'Agent spec: ' + spec.name,
        body: el(doc, 'div', {}, [
          el(doc, 'p', { class: 'dc-body', text: 'Here is the spec. Paste the brief into a project, or hand the JSON to Claude Code to build. Nothing has been started.' }),
          preview,
          status,
        ]),
        options: [
          { label: 'Copy as brief', hint: 'Plain text for a project or a prompt' },
          { label: 'Copy as JSON', hint: spec.schema },
          { label: 'Download JSON', hint: specFileName(spec) },
          { label: 'Edit', hint: 'Change the answers' },
          { label: 'Done' },
        ],
        beforeClose: (index) => {
          // Copy and download keep the popup open and say what happened; Edit and Done close it.
          if (index === 0 || index === 1) {
            copyText(index === 0 ? brief : json).then((ok) => {
              status.textContent = ok ? 'Copied the ' + (index === 0 ? 'brief' : 'JSON') + '.' : 'Could not copy automatically. Select the text above and copy it.';
            });
            return false;
          }
          if (index === 2) {
            status.textContent = saveFile(specFileName(spec), json, 'application/json') ? 'Downloaded ' + specFileName(spec) + '.' : 'Could not start the download.';
            return false;
          }
          return true;
        },
      });
      if (result === 3) continue;
      return spec;
    }
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
        body: task.awaiting.question + ' · ' + taskName(task),
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
      let record = null;
      try {
        record = await api.getTaskStatus(task.agent_id, task.task_id);
      } catch { /* the plain finished popup still works */ }
      const built = record ? (record.results || []).find((r) => r.step_id === 'build') : null;
      const output = built && built.output ? built.output : null;
      if (output && output.viability && output.viability.viable) {
        await launchChoice(task, output);
        return;
      }
      const pick = await choose({
        title: 'Project finished',
        body: taskName(task) + ' · ' + task.completed_steps + ' of ' + task.total_steps + ' steps. Its files, any website draft and the Space card are under Projects.',
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
        body: taskName(task) + (detail ? ': ' + detail : ''),
        options: [{ label: 'See the failed step', hint: 'Studio → Engine activity' }, { label: 'Run it again', hint: 'Projects → Deploy & Execute' }, { label: 'Close' }],
        kind: 'warn',
      });
      if (pick === 0) onNavigate('studio');
      else if (pick === 1) onNavigate('blueprints');
      return;
    }
    const pick = await choose({
      title: 'A run was stopped by the breaker',
      body: taskName(task) + (detail ? ': ' + detail : ''),
      options: [{ label: 'Reset the agent', hint: 'Lets it run again' }, { label: 'Leave it stopped' }],
      kind: 'warn',
    });
    if (pick === 0) api.resetBreaker(task.agent_id).catch(() => {});
  }

  // ---- launch

  // A task's readable name: the project it deploys when we remember the run, else a plain title.
  const taskName = (task) => taskTitle(task.task_id, () => (runsStore()[task.task_id] || {}).project || '');
  const runsStore = () => {
    try { return JSON.parse((storage && storage.getItem('aether.projectRuns')) || '{}') || {}; } catch { return {}; }
  };
  function rememberLaunch(taskId, launch) {
    const runs = runsStore();
    runs[taskId] = { ...(runs[taskId] || {}), launch };
    try { storage && storage.setItem('aether.projectRuns', JSON.stringify(runs)); } catch { /* storage blocked */ }
  }
  const openTab = (url) => { try { win.open(url, '_blank', 'noopener'); } catch { /* popup blocked: the link is in the popup text */ } };

  // The viability gate's question, with the staging link and the score.
  async function launchChoice(task, output) {
    const staging = output.staging && output.staging.url ? output.staging : null;
    const v = output.viability;
    const body = el(doc, 'div', {}, [
      el(doc, 'p', { class: 'dc-body', text: taskName(task) + ' built cleanly in the sandbox and scored ' + v.score + '/100 (' + v.verdict + ').' + (staging ? ' It is live on free staging now.' : '') }),
      staging ? el(doc, 'p', { class: 'dc-body' }, [el(doc, 'a', { href: staging.url, target: '_blank', rel: 'noopener', text: '↗ ' + staging.url })]) : null,
      v.settings_needed && v.settings_needed.length ? el(doc, 'p', { class: 'dc-warn', text: 'Before real users: set ' + v.settings_needed.join(', ') + ' on the host you choose.' }) : null,
    ]);
    const pick = await choose({
      title: 'Where would you like to launch this live?',
      body,
      options: [
        { label: 'Keep on Free Staging', hint: staging ? staging.alias || staging.url : 'Cloudflare Pages, free' },
        { label: 'Attach Custom Domain on Cloudflare (Free)', hint: 'Your own domain on this Pages project' },
        { label: 'Deploy to Recommended Host', hint: 'Vercel, Netlify or Supabase' },
        { label: 'Decide later', hint: 'It stays on staging' },
      ],
      kind: 'go',
    });
    if (pick === 0) {
      rememberLaunch(task.task_id, 'staging');
      const open = await choose({ title: 'Staying on free staging', body: 'It stays at ' + (staging ? staging.alias || staging.url : 'its staging address') + '. You can attach a domain or move hosts any time from Projects.', options: [{ label: 'Open the site' }, { label: 'Done' }] });
      if (open === 0 && staging) openTab(staging.url);
    } else if (pick === 1) {
      rememberLaunch(task.task_id, 'custom-domain');
      const project = staging ? staging.project : '';
      const steps = el(doc, 'ol', { class: 'dc-steps' }, [
        el(doc, 'li', { text: 'Your domain\u2019s DNS must be on Cloudflare (free plan). Domains at GoDaddy: add the site in Cloudflare, then switch the nameservers at GoDaddy to the two Cloudflare gives you.' }),
        el(doc, 'li', { text: 'Open the Pages project' + (project ? ' ' + project : '') + ' → Custom domains → Set up a domain, and enter www.yourdomain.com or a subdomain.' }),
        el(doc, 'li', { text: 'Cloudflare adds the DNS record and the HTTPS certificate itself; it is usually live within minutes.' }),
      ]);
      const go = await choose({ title: 'Attach your own domain (free)', body: steps, options: [{ label: 'Open the Cloudflare dashboard', hint: 'Pages → ' + (project || 'your project') + ' → Custom domains' }, { label: 'Done' }] });
      if (go === 0) openTab('https://dash.cloudflare.com/?to=/:account/pages/view/' + encodeURIComponent(project) + '/domains');
    } else if (pick === 2) {
      let links = [];
      try {
        links = (await api.getEngineConfig()).launch_links || [];
      } catch { /* the defaults below */ }
      if (!links.length) {
        links = [
          { id: 'vercel', label: 'Vercel', url: 'https://vercel.com/new', affiliate: false, what: 'Front ends and Next.js; free hobby tier.' },
          { id: 'netlify', label: 'Netlify', url: 'https://app.netlify.com/start', affiliate: false, what: 'Static sites and forms; free starter tier.' },
          { id: 'supabase', label: 'Supabase', url: 'https://supabase.com/dashboard/new', affiliate: false, what: 'Postgres database, auth and storage for a SaaS back end; free tier.' },
        ];
      }
      const host = await choose({
        title: 'Pick a host',
        body: 'Each opens the host\u2019s own setup in a new tab; bring the deliverable files from Projects (each downloads with one tap).' + (links.some((l) => l.affiliate) ? ' Links marked affiliate earn Aether a referral fee at no cost to you.' : ''),
        options: [...links.map((l) => ({ label: l.label + (l.affiliate ? ' (affiliate link)' : ''), hint: l.what })), { label: 'Back' }],
      });
      if (host >= 0 && host < links.length) {
        rememberLaunch(task.task_id, links[host].id);
        openTab(links[host].url);
      }
    }
  }

  // ---- banner

  function renderBanner() {
    if (!slot) return;
    let runs = {};
    try {
      runs = JSON.parse((storage && storage.getItem('aether.projectRuns')) || '{}') || {};
    } catch { /* no run hints */ }
    const action = nextAction({ error, tasks, runs, setup: getSetup() });
    const visible = bannerVisibleOn(action, view) && !dismissed.includes(bannerKey(action));
    const sig = JSON.stringify([action, visible]);
    if (sig === lastBanner) return;
    lastBanner = sig;
    slot.hidden = !visible;
    if (!visible) return;
    slot.className = 'wf-next';
    slot.dataset.kind = action.kind;
    const children = [el(doc, 'div', { class: 'wf-next-text' }, [el(doc, 'p', { class: 'eyebrow', text: 'Do this next' }), el(doc, 'p', { class: 'wf-next-title', text: action.title }), el(doc, 'p', { class: 'wf-next-sub', text: action.text })])];
    if (action.action) {
      const go = el(doc, 'button', { type: 'button', class: 'btn btn-primary wf-next-go', text: action.action.label });
      go.addEventListener('click', () => onNavigate(action.action.view));
      children.push(go);
    }
    // One tap puts it away. It stays away until the message changes, and the status pill still carries anything urgent.
    const dismiss = el(doc, 'button', { type: 'button', class: 'wf-next-dismiss', 'aria-label': 'Dismiss: ' + action.title, title: 'Dismiss', text: '×' });
    dismiss.addEventListener('click', () => dismissBanner(action));
    children.push(dismiss);
    slot.replaceChildren(...children);
  }

  function dismissBanner(action) {
    const key = bannerKey(action);
    if (!dismissed.includes(key)) dismissed = [...dismissed, key].slice(-MAX_DISMISSED);
    try { storage && storage.setItem && storage.setItem(DISMISSED_KEY, JSON.stringify(dismissed)); } catch { /* storage blocked: it stays dismissed for this page */ }
    lastBanner = '';
    renderBanner();
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
    if (!destroyed) timer = setTimeout(poll, pollDelay(error && error.isUnreachable ? pollMs * 3 : pollMs));
  }

  poll();
  return {
    // Mission Control tells the banner which view is open; it can then stay off pages where it is not actionable.
    setView(next) {
      view = next;
      renderBanner();
    },
    refreshBanner: renderBanner,
    // The current banner's message, if one is on screen: { kind, title, text } (tests and the page use it).
    getBanner: () => {
      if (!slot || slot.hidden) return null;
      const title = slot.querySelector('.wf-next-title');
      return title ? { kind: slot.dataset.kind, title: title.textContent, text: (slot.querySelector('.wf-next-sub') || {}).textContent || '' } : null;
    },
    dismissBanner: () => {
      const dismiss = slot && slot.querySelector('.wf-next-dismiss');
      if (dismiss) dismiss.click();
    },
    choose,
    learn,
    askSource,
    askAgentSpec,
    poll,
    isOpen: () => Boolean(open),
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      if (open) open.close(-1);
    },
  };
}
