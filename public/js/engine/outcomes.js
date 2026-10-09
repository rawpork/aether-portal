// Mission Control project flow, after the Blueprints workspace:
// - Space handoff: "Make it a project" on a portal card leaves a project payload in same-origin storage and opens
//   /mission-control?project=1; takeProjectPayload() reads it once, and the card ids are remembered for the run.
// - Preflight ("Ready to run?"): before Deploy & Execute, checks the engine connection and auth, which model provider
//   the phases will use, the budget cap and an estimated token count. No dollar figures are invented: a cap shows only
//   when Miserly is in use.
// - Outcomes & Deliverables: every executed project run (deploy-* tasks) with its phases' results, the links the agents
//   produced, a Markdown report to download, and the Outcome card it became in Space (POST /api/outcomes), opened
//   with one tap. Project runs (POST /api/projects/run) also show Elarion's plan (goals and DAG) and every
//   deliverable file the agents wrote as a ````file:<path> block, each downloadable, and all of them go into the
//   report the Outcome card carries.
// - Live preview: only when the blueprint explicitly asked for one (the plan's preview_page) and the run wrote
//   preview/index.html, that page is saved as a draft at /s/<slug> (POST /api/sites). It goes public only when the
//   operator presses Approve & publish.
import { getEngineApi, isRelayUrl, onEngineState } from '../engine-api.bundle.js';
import { describeEngineError } from './operator-console.js';
import { statusLabel, taskTitle } from './labels.js';
import { humanTitle, stepMapSteps, stepMapNode, deliverableBanner } from './step-chat.js';

export const PROJECT_PAYLOAD_KEY = 'aether.projectPayload';
export const PROJECT_RUNS_KEY = 'aether.projectRuns';
export const PROJECT_SOURCES_KEY = 'aether.projectSources';
export const PAYLOAD_MAX_AGE_MS = 30 * 60 * 1000;
// Rough per-phase token use for the estimate: one model turn reading the blueprint context and writing a section.
export const EST_INPUT_PER_PHASE = 2500;
export const EST_OUTPUT_PER_PHASE = 1500;
const MAX_RUNS = 10;
const MAX_STORED = 40;

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

const readJson = (storage, key, fallback) => {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (storage, key, value) => {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked: the feature degrades, nothing breaks */ }
};

// ---- Space handoff ----

// The payload "Make it a project" left (once): { spec, sourceIds } or null when missing, stale or malformed. The card
// ids are remembered under the project's name, for the Outcome the run becomes.
export function takeProjectPayload(storage, now = Date.now()) {
  const payload = readJson(storage, PROJECT_PAYLOAD_KEY, null);
  try { storage.removeItem(PROJECT_PAYLOAD_KEY); } catch { /* ignore */ }
  if (!payload || typeof payload !== 'object' || !payload.spec || !Array.isArray(payload.spec.links)) return null;
  if (!(now - Number(payload.at) <= PAYLOAD_MAX_AGE_MS)) return null;
  const sourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds.map(String).slice(0, 50) : [];
  const name = String(payload.spec.projectName || '');
  if (name && sourceIds.length) {
    const sources = readJson(storage, PROJECT_SOURCES_KEY, {});
    sources[name] = sourceIds;
    const names = Object.keys(sources);
    if (names.length > MAX_STORED) delete sources[names[0]];
    writeJson(storage, PROJECT_SOURCES_KEY, sources);
  }
  return { spec: payload.spec, sourceIds };
}

// ---- Preflight ----

const PROVIDERS = { 'direct-anthropic': 'Claude (Anthropic)', 'direct-gemini': 'Gemini (Google)', 'direct-openai': 'OpenAI', miserly: 'Miserly.io', 'miserly-free': 'Sandbox (canned replies)' };

// The checks shown on the "Ready to run?" card: [{ id, ok: true | false | null (warning), label, detail }] and
// whether the run can start. config is GET /api/engine/config, or null with error when it failed.
export function preflightChecks({ config, error = null, phases, relay, budgetCapUsd = null }) {
  const checks = [];
  if (!config) {
    checks.push({ id: 'engine', ok: false, label: 'Engine connection', detail: error ? describeEngineError(error) : 'The engine did not answer.' });
    return { checks, canRun: false };
  }
  checks.push({ id: 'engine', ok: true, label: 'Engine connection', detail: relay ? 'Reachable and signed in, through the portal relay (tunnel up).' : 'Reachable and signed in.' });
  const mode = (config.model_routes_effective && config.model_routes_effective.step) || config.execution_mode;
  const keys = config.direct_fallback || {};
  const keyList = [keys.anthropic_key_configured && 'Anthropic', keys.gemini_key_configured && 'Gemini', keys.openai_key_configured && 'OpenAI'].filter(Boolean);
  if (mode === 'unconfigured') {
    checks.push({ id: 'keys', ok: false, label: 'Model keys', detail: 'No model key on the engine: add ANTHROPIC_API_KEY or GEMINI_API_KEY to its .env, or a Miserly key in Settings.' });
  } else if (mode === 'miserly-free') {
    checks.push({ id: 'keys', ok: null, label: 'Model keys', detail: 'Sandbox mode: phases get canned replies and no real work is done.' });
  } else {
    checks.push({ id: 'keys', ok: true, label: 'Model keys', detail: 'Phases run on ' + (PROVIDERS[mode] || mode) + (keyList.length ? ' · keys on the engine: ' + keyList.join(', ') : '') + '.' });
  }
  if (config.execution_mode === 'miserly' && budgetCapUsd != null) {
    checks.push({ id: 'budget', ok: true, label: 'Budget', detail: 'Miserly caps this run at $' + Number(budgetCapUsd).toFixed(2) + '.' });
  } else {
    checks.push({ id: 'budget', ok: null, label: 'Budget', detail: 'No Miserly budget cap: direct mode bills your provider account for each phase.' });
  }
  const input = phases * EST_INPUT_PER_PHASE;
  const output = phases * EST_OUTPUT_PER_PHASE;
  checks.push({ id: 'estimate', ok: null, label: 'Estimate', detail: phases + (phases === 1 ? ' phase' : ' phases') + ' · about ' + (input + output).toLocaleString() + ' tokens (' + input.toLocaleString() + ' in, ' + output.toLocaleString() + ' out). A rough guide, not a quote.' });
  return { checks, canRun: mode !== 'unconfigured' };
}

export async function runPreflight({ api, phases, budgetCapUsd }) {
  try {
    const config = await api.getEngineConfig();
    return preflightChecks({ config, phases, relay: isRelayUrl(api.baseUrl), budgetCapUsd });
  } catch (error) {
    return preflightChecks({ config: null, error, phases, relay: isRelayUrl(api.baseUrl) });
  }
}

// ---- Outcomes ----

// Links an agent wrote into its answers (http/https), de-duplicated, trailing punctuation trimmed.
export function extractLinks(texts, max = 8) {
  const out = [];
  for (const text of texts) {
    for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, '');
      if (!out.includes(url)) out.push(url);
      if (out.length >= max) return out;
    }
  }
  return out;
}

const responseOf = (result) => (result && result.output && typeof result.output.response === 'string' ? result.output.response : '');

export const PREVIEW_PATH = 'preview/index.html';

// A relative path that stays inside the project (forward slashes, no "..", no drive or leading slash), or null.
export function safeRelativePath(raw) {
  const cleaned = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.length > 200 || cleaned.startsWith('/') || /^[a-z]:/i.test(cleaned) || /[\0<>:"|?*]/.test(cleaned)) return null;
  const parts = cleaned.split('/');
  return parts.some((p) => !p || p === '.' || p === '..') ? null : parts.join('/');
}

// The deliverable files in a run's answers: every ````file:<path> block (the engine's format; later versions of a
// path win), as [{ path, content }] in first-seen order.
export function deliverableFiles(record) {
  const files = new Map();
  for (const text of (record.results || []).map(responseOf)) {
    for (const match of text.matchAll(/(`{3,})file:([^\n`]+)\n([\s\S]*?)\n?\1(?!`)/g)) {
      const path = safeRelativePath(match[2]);
      if (path) files.set(path, match[3]);
    }
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

// The finish-line guard's result: { placeholders_before, placeholders_after, repairs, remaining } or null.
export function finishCheckOf(record) {
  const step = (record.results || []).find((r) => r.step_id === 'finish-line');
  return (step && step.output && step.output.finish_check) || null;
}

// The sandbox build step's result: { build, staging, viability } or null for runs without one.
export function buildOf(record) {
  const step = (record.results || []).find((r) => r.step_id === 'build');
  return step && step.output && step.output.build ? step.output : null;
}

// Elarion's plan from a project run (its "plan" step), or null for plain phase runs.
export function projectPlanOf(record) {
  const step = (record.results || []).find((r) => r.step_id === 'plan');
  return (step && step.output && step.output.elarion_plan) || null;
}

// The name a step shows: the blueprint's phase name, the plan's step title, or what the step is.
export function stepName(record, run, stepId) {
  if (run.phaseNames && run.phaseNames[stepId]) return run.phaseNames[stepId];
  if (stepId === 'deliverables') return 'Deliverables';
  if (stepId === 'review') return 'Goal check & fixes';
  if (stepId === 'gap-fill') return 'Missing pieces filled';
  if (stepId === 'finish-line') return 'Finish line & polish';
  if (stepId === 'build') return 'Sandbox build & staging';
  const plan = projectPlanOf(record);
  const node = plan && Array.isArray(plan.dag) ? plan.dag.find((d) => 'step-' + d.id === stepId) : null;
  return node ? node.title : stepId;
}

const REPORT_FILES_BUDGET = 12000;

// A run's Markdown report: project, status, Elarion's plan, each step's result, the links found, the generated
// scaffold and the deliverable files (contents included while they fit, so the Outcome card carries them).
export function runReport(record, run = {}) {
  const lines = ['# ' + (run.project || record.task_id), '', '- Run: ' + record.task_id + ' · ' + record.status + ' · ' + (record.finished_at || record.started_at), '- Tokens: ' + (record.total_tokens.input + record.total_tokens.output).toLocaleString(), ''];
  const plan = projectPlanOf(record);
  if (plan) {
    lines.push('## Plan', '', plan.summary || '', '');
    if (plan.goals && plan.goals.length) lines.push(...plan.goals.map((g) => '- Goal: ' + g), '');
    if (plan.dag && plan.dag.length) lines.push(...plan.dag.map((d, i) => (i + 1) + '. ' + d.title + (d.depends_on.length ? ' (after ' + d.depends_on.join(', ') + ')' : '')), '');
    if (plan.gaps && plan.gaps.length) lines.push('## Missing pieces found', '', ...plan.gaps.map((g) => '- ' + g.kind + ': ' + g.need + (g.evidence ? ' ("' + g.evidence + '")' : '')), '');
  }
  const finish = finishCheckOf(record);
  const built = buildOf(record);
  if (built) {
    lines.push('## Sandbox build', '', '- Build: ' + built.build.status + (built.build.reason ? ' (' + built.build.reason + ')' : '') + (built.build.rounds && built.build.rounds.length ? ', ' + built.build.rounds.length + (built.build.rounds.length === 1 ? ' round' : ' rounds') : ''));
    if (built.staging && built.staging.url) lines.push('- Staging: ' + built.staging.url);
    if (built.staging && built.staging.error) lines.push('- Staging failed: ' + built.staging.error);
    if (built.viability) lines.push('- Viability: ' + built.viability.score + '/100 (' + built.viability.verdict + ')', ...built.viability.checks.map((c) => '  - ' + c.name + ': ' + c.detail));
    lines.push('');
  }
  if (finish) lines.push('## Finish line', '', '- Placeholders left: ' + finish.placeholders_after + (finish.repairs ? ' (fixed ' + finish.placeholders_before + ' in ' + finish.repairs + (finish.repairs === 1 ? ' pass' : ' passes') + ')' : ''), '');
  for (const result of record.results || []) {
    if (result.step_id === 'plan') continue;
    lines.push('## ' + stepName(record, run, result.step_id), '', responseOf(result).trim() || '_(no text)_', '');
  }
  const links = extractLinks((record.results || []).map(responseOf));
  if (links.length) lines.push('## Links', '', ...links.map((url) => '- ' + url), '');
  if (run.scaffold && run.scaffold.length) lines.push('## Generated artifacts', '', ...run.scaffold.map((path) => '- `' + path + '`'), '');
  const files = deliverableFiles(record);
  if (files.length) {
    lines.push('## Deliverable files', '', ...files.map((f) => '- `' + f.path + '` (' + f.content.length.toLocaleString() + ' characters)'), '');
    let budget = REPORT_FILES_BUDGET;
    for (const file of files) {
      if (file.content.length > budget) continue;
      budget -= file.content.length;
      lines.push('### ' + file.path, '', '````', file.content, '````', '');
    }
  }
  if (run.siteSlug) lines.push('## Live preview', '', '- /s/' + run.siteSlug + (run.sitePublished ? '' : ' (draft until approved in Mission Control)'), '');
  return lines.join('\n');
}

export function mountOutcomesList(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const storage = options.storage || win.localStorage;
  const portalFetch = options.portalFetch || ((url, init) => win.fetch(url, init));
  const list = el(doc, 'ol', { class: 'oc-runs' });
  const empty = el(doc, 'p', { class: 'oc-empty', text: 'No project runs yet. Compile a blueprint and Deploy & Execute it; its results land here and in Space.' });
  const status = el(doc, 'span', { class: 'mc-muted', 'aria-live': 'polite' });
  container.replaceChildren(el(doc, 'section', { class: 'surface mc-panel oc-outcomes', 'aria-labelledby': 'oc-outcomes-title' }, [
    el(doc, 'div', { class: 'mc-panel-head' }, [el(doc, 'h2', { id: 'oc-outcomes-title', text: 'Outcomes & Deliverables' }), status]),
    el(doc, 'div', { class: 'oc-outcomes-body' }, [empty, list]),
  ]));
  let destroyed = false;
  const origin = win.location && win.location.origin && win.location.origin !== 'null' ? win.location.origin : '';

  const runs = () => readJson(storage, PROJECT_RUNS_KEY, {});
  const saveRun = (taskId, patch) => {
    const all = runs();
    all[taskId] = { ...(all[taskId] || {}), ...patch };
    const ids = Object.keys(all);
    if (ids.length > MAX_STORED) delete all[ids[0]];
    writeJson(storage, PROJECT_RUNS_KEY, all);
  };

  // Writes a finished run to Space as an Outcome Node, linked to the cards the project came from.
  async function sendToSpace(record) {
    const run = runs()[record.task_id] || {};
    const sources = readJson(storage, PROJECT_SOURCES_KEY, {})[run.project] || [];
    const steps = (record.results || []).filter((result) => result.step_id !== 'plan').map((result) => ({
      title: stepName(record, run, result.step_id),
      detail: responseOf(result).replace(/\s+/g, ' ').slice(0, 600),
    }));
    const plan = projectPlanOf(record);
    const goal = run.goal || (plan && plan.goals && plan.goals.length ? plan.goals.join('; ') : '');
    const body = await portalJson('/api/outcomes', { method: 'POST', body: JSON.stringify({ title: run.project || record.task_id, goal, steps, report: runReport(record, run), source_ids: sources }) });
    saveRun(record.task_id, { nodeId: body.id });
    return body.id;
  }

  async function portalJson(url, init) {
    const response = await portalFetch(url, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
    return body;
  }

  // The run's preview page as a draft at /s/<slug>: only when the blueprint asked for a live preview page and the
  // run wrote preview/index.html. Returns the site, or null when there is nothing to preview.
  async function draftPreview(record) {
    const plan = projectPlanOf(record);
    const page = deliverableFiles(record).find((f) => f.path === PREVIEW_PATH);
    if (!plan || !plan.preview_page || !page) return null;
    const run = runs()[record.task_id] || {};
    const payload = { title: run.project || record.task_id, html: page.content };
    if (run.nodeId) payload.outcome_id = run.nodeId;
    if (run.siteSlug) payload.slug = run.siteSlug;
    const body = await portalJson('/api/sites', { method: 'POST', body: JSON.stringify(payload) });
    saveRun(record.task_id, { siteSlug: body.site.slug, sitePublished: body.site.status === 'live' && !body.site.unpublished_changes });
    return body.site;
  }

  function downloadText(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el(doc, 'a', { href: url, download: name });
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function download(record) {
    downloadText(record.task_id + '.md', runReport(record, runs()[record.task_id] || {}), 'text/markdown');
  }

  // Preview link and the approval gate for the run's /s/ page: Publish… opens a confirm; Approve & publish sends it.
  function previewRow(record, run) {
    const row = el(doc, 'div', { class: 'oc-preview' });
    const message = el(doc, 'span', { class: 'mc-muted', 'aria-live': 'polite' });
    const path = '/api/sites/' + encodeURIComponent(run.siteSlug);
    row.append(el(doc, 'span', { class: 'oc-preview-label', text: run.sitePublished ? 'Live page:' : 'Preview page (draft):' }),
      el(doc, 'a', { class: 'oc-link', href: '/s/' + run.siteSlug + (run.sitePublished ? '' : '?preview=1'), target: '_blank', rel: 'noopener', text: '↗ ' + origin + '/s/' + run.siteSlug }));
    if (!run.sitePublished) {
      const publish = el(doc, 'button', { type: 'button', class: 'bp-primary oc-site-publish', text: 'Publish…' });
      const confirm = el(doc, 'div', { class: 'oc-site-confirm', hidden: true, role: 'group', 'aria-label': 'Approve publishing' });
      const approve = el(doc, 'button', { type: 'button', class: 'bp-primary oc-site-approve', text: 'Approve & publish' });
      const cancel = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Cancel' });
      confirm.append(el(doc, 'p', { text: 'Make this page public at ' + origin + '/s/' + run.siteSlug + '? Anyone with the link can see it.' }), el(doc, 'div', { class: 'bp-preflight-actions' }, [cancel, approve]));
      publish.addEventListener('click', () => { confirm.hidden = false; publish.hidden = true; approve.focus(); });
      cancel.addEventListener('click', () => { confirm.hidden = true; publish.hidden = false; });
      approve.addEventListener('click', async () => {
        approve.disabled = true;
        message.textContent = 'Publishing…';
        try {
          await portalJson(path + '/publish', { method: 'POST', body: JSON.stringify({ approve: true }) });
          saveRun(record.task_id, { sitePublished: true });
          refresh();
        } catch (error) {
          approve.disabled = false;
          message.textContent = 'Could not publish: ' + error.message;
        }
      });
      row.append(publish, message, confirm);
    } else {
      row.append(message);
    }
    return row;
  }

  function renderRun(record) {
    const run = runs()[record.task_id] || {};
    const texts = (record.results || []).map(responseOf);
    const links = extractLinks(texts);
    const actions = el(doc, 'div', { class: 'oc-run-actions' });
    const message = el(doc, 'span', { class: 'mc-muted oc-run-message', 'aria-live': 'polite' });
    const report = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Download report (.md)' });
    report.addEventListener('click', () => download(record));
    actions.append(report);
    if (run.nodeId) {
      actions.append(el(doc, 'a', { class: 'bp-primary oc-open-space', href: '/node/' + encodeURIComponent(run.nodeId), text: 'Open in Space' }));
    } else if (record.status === 'COMPLETED') {
      const send = el(doc, 'button', { type: 'button', class: 'bp-primary', text: 'Add to Space' });
      send.addEventListener('click', async () => {
        send.disabled = true;
        message.textContent = 'Adding…';
        try {
          await sendToSpace(record);
          refresh();
        } catch (error) {
          send.disabled = false;
          message.textContent = 'Could not add it: ' + error.message;
        }
      });
      actions.append(send);
    }
    actions.append(message);
    const plan = projectPlanOf(record);
    const planBlock = plan
      ? el(doc, 'details', { class: 'oc-phase oc-plan' }, [
        el(doc, 'summary', { text: (plan.planned_by === 'elarion' ? 'Elarion’s plan' : 'Plan (blueprint phases)') + ' · ' + (plan.dag || []).length + ' steps' }),
        el(doc, 'p', { text: [plan.summary, plan.fallback_reason ? '(' + plan.fallback_reason + ')' : ''].filter(Boolean).join(' ') }),
        el(doc, 'ul', { class: 'oc-goals' }, (plan.goals || []).map((g) => el(doc, 'li', { text: g }))),
        el(doc, 'ol', { class: 'oc-dag' }, (plan.dag || []).map((d) => el(doc, 'li', { text: d.title + (d.depends_on.length ? ' ← ' + d.depends_on.map((id) => stepName(record, run, 'step-' + id)).join(', ') : '') }))),
        plan.gaps && plan.gaps.length ? el(doc, 'p', { class: 'oc-gaps-title', text: 'Missing pieces Elarion found and filled:' }) : doc.createTextNode(''),
        plan.gaps && plan.gaps.length ? el(doc, 'ul', { class: 'oc-gaps' }, plan.gaps.map((g) => el(doc, 'li', { text: g.kind + ': ' + g.need }))) : doc.createTextNode(''),
      ])
      : doc.createTextNode('');
    const built = buildOf(record);
    let buildBadge = doc.createTextNode('');
    if (built) {
      const v = built.viability;
      const parts = [built.build.status === 'passed' ? '✓ Sandbox build passed' : built.build.status === 'failed' ? '✕ Sandbox build failed' : 'Sandbox build skipped: ' + (built.build.reason || '')];
      if (v) parts.push('Viability ' + v.score + '/100 · ' + v.verdict);
      buildBadge = el(doc, 'div', { class: 'oc-build', 'data-status': built.build.status }, [el(doc, 'p', { class: 'oc-build-line', text: parts.join(' · ') })]);
      if (built.staging && built.staging.url) buildBadge.append(el(doc, 'a', { class: 'oc-link', href: built.staging.url, target: '_blank', rel: 'noopener', text: '↗ Staging: ' + built.staging.url.replace(/^https:\/\//, '') }));
      if (built.staging && built.staging.error) buildBadge.append(el(doc, 'p', { class: 'mc-muted', text: 'Staging failed: ' + built.staging.error }));
      if (v && v.settings_needed && v.settings_needed.length) buildBadge.append(el(doc, 'p', { class: 'mc-muted', text: 'Set before going live: ' + v.settings_needed.join(', ') }));
    }
    const finish = finishCheckOf(record);
    const finishBadge = finish
      ? el(doc, 'p', { class: 'oc-finish', 'data-ok': String(finish.placeholders_after === 0), text: finish.placeholders_after === 0
        ? '✓ Finish line: no TODOs or placeholders left' + (finish.repairs ? ' (Elarion fixed ' + finish.placeholders_before + ')' : '')
        : '! Finish line: ' + finish.placeholders_after + ' placeholder' + (finish.placeholders_after === 1 ? '' : 's') + ' still left. See the Finish line step.' })
      : doc.createTextNode('');
    const files = deliverableFiles(record);
    const fileBlock = files.length
      ? el(doc, 'div', { class: 'oc-files' }, [
        el(doc, 'strong', { class: 'oc-files-title', text: 'Deliverables · ' + files.length + (files.length === 1 ? ' file' : ' files') }),
        el(doc, 'ul', {}, files.map((file) => {
          const get = el(doc, 'button', { type: 'button', class: 'oc-file', title: 'Download ' + file.path, text: '⤓ ' + file.path });
          get.addEventListener('click', () => downloadText(file.path.split('/').pop(), file.content, 'text/plain'));
          return el(doc, 'li', {}, [get]);
        })),
      ])
      : doc.createTextNode('');
    const phases = el(doc, 'div', { class: 'oc-phases' }, (record.results || []).filter((result) => result.step_id !== 'plan').map((result) => {
      const text = responseOf(result).trim();
      return el(doc, 'details', { class: 'oc-phase' }, [
        el(doc, 'summary', { text: stepName(record, run, result.step_id) }),
        el(doc, 'p', { text: text || '(no text)' }),
      ]);
    }));
    const linkRow = links.length
      ? el(doc, 'div', { class: 'oc-links' }, links.map((url) => el(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'oc-link', text: '↗ ' + url.replace(/^https?:\/\//, '').slice(0, 48) })))
      : doc.createTextNode('');
    const complete = record.status === 'COMPLETED' && record.completed_steps >= record.total_steps;
    const liveUrl = run.siteSlug && run.sitePublished ? origin + '/s/' + run.siteSlug : built && built.staging && built.staging.url ? built.staging.url : '';
    return el(doc, 'li', { class: 'oc-run', 'data-status': record.status }, [
      el(doc, 'div', { class: 'oc-run-head' }, [
        el(doc, 'strong', { text: humanTitle({ project: run.project, goal: run.goal }, taskTitle(record.task_id)) }),
        el(doc, 'span', { class: 'mc-chip', 'data-status': record.status, text: statusLabel(record.status) }),
      ]),
      el(doc, 'p', { class: 'mc-muted oc-run-meta', text: record.completed_steps + '/' + record.total_steps + ' steps · ' + (record.total_tokens.input + record.total_tokens.output).toLocaleString() + ' tokens · ' + String(record.finished_at || record.started_at).slice(0, 16).replace('T', ' ') }),
      stepMapNode(doc, stepMapSteps(record, (id) => stepName(record, run, id)), { complete }),
      linkRow,
      run.siteSlug ? previewRow(record, run) : doc.createTextNode(''),
      buildBadge,
      finishBadge,
      fileBlock,
      planBlock,
      phases,
      complete ? deliverableBanner(doc, { url: liveUrl, score: built && built.viability ? built.viability.score : undefined, verdict: built && built.viability ? built.viability.verdict : undefined, download: { label: 'Download report (.md)', onClick: () => download(record) } }) : doc.createTextNode(''),
      actions,
    ]);
  }

  async function refresh() {
    if (destroyed) return;
    status.textContent = 'Loading…';
    try {
      const tasks = ((await api.listTasks({ limit: 50 })).tasks || []).filter((t) => String(t.task_id).startsWith('deploy-')).slice(0, MAX_RUNS);
      const records = (await Promise.all(tasks.map((t) => api.getTaskStatus(t.agent_id, t.task_id).catch(() => null)))).filter(Boolean);
      list.replaceChildren(...records.map(renderRun));
      empty.hidden = records.length > 0;
      status.textContent = records.length ? records.length + (records.length === 1 ? ' run' : ' runs') : '';
    } catch (error) {
      status.textContent = describeEngineError(error);
    }
  }

  // A run the Blueprints workspace just finished: remember its project, phase names and scaffold, then add it to Space.
  async function recordRun(bp, outcome) {
    const taskId = 'deploy-' + bp.blueprint_id;
    const phaseNames = {};
    (bp.execution_phases || []).forEach((phase) => { phaseNames['phase-' + phase.phase_index] = phase.phase_name; });
    saveRun(taskId, { project: bp.project_name, goal: (bp.sources || []).map((s) => s.scraped_summary).filter(Boolean)[0] || '', phaseNames, scaffold: (bp.project_scaffold || []).map((f) => f.path) });
    if (outcome && outcome.status === 'COMPLETED') {
      try {
        const record = await api.getTaskStatus(outcome.agent_id || 'master-brain', taskId);
        await draftPreview(record).catch((error) => { status.textContent = 'The preview page could not be saved (' + error.message + ').'; });
        await sendToSpace(record);
      } catch (error) {
        status.textContent = 'The run finished, but adding it to Space failed (' + error.message + '); use Add to Space.';
      }
    }
    refresh();
  }

  const unsubscribe = onEngineState((detail) => {
    if (detail.source !== 'state') refresh();
  });
  refresh();
  return {
    refresh,
    recordRun,
    elements: { list, empty, status },
    destroy() {
      destroyed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      container.replaceChildren();
    },
  };
}
