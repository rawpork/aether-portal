// Mission Control project flow, after the Blueprints workspace:
// - Space handoff: "Make it a project" on a portal card leaves a project payload in same-origin storage and opens
//   /mission-control?project=1; takeProjectPayload() reads it once, and the card ids are remembered for the run.
// - Preflight ("Ready to run?"): before Deploy & Execute, checks the engine connection and auth, which model provider
//   the phases will use, the budget cap and an estimated token count. No dollar figures are invented: a cap shows only
//   when Miserly is in use.
// - Outcomes & Deliverables: every executed project run (deploy-* tasks) with its phases' results, the links the agents
//   produced, a Markdown report to download, and the Outcome card it became in Space (POST /api/outcomes), opened
//   with one tap.
import { getEngineApi, isRelayUrl, onEngineState } from '../engine-api.bundle.js';
import { describeEngineError } from './operator-console.js';

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

// A run's Markdown report: project, status, each phase's result, the links found and the generated scaffold.
export function runReport(record, run = {}) {
  const lines = ['# ' + (run.project || record.task_id), '', '- Run: ' + record.task_id + ' · ' + record.status + ' · ' + (record.finished_at || record.started_at), '- Tokens: ' + (record.total_tokens.input + record.total_tokens.output).toLocaleString(), ''];
  for (const result of record.results || []) {
    lines.push('## ' + (run.phaseNames && run.phaseNames[result.step_id] ? run.phaseNames[result.step_id] : result.step_id), '', responseOf(result).trim() || '_(no text)_', '');
  }
  const links = extractLinks((record.results || []).map(responseOf));
  if (links.length) lines.push('## Links', '', ...links.map((url) => '- ' + url), '');
  if (run.scaffold && run.scaffold.length) lines.push('## Generated artifacts', '', ...run.scaffold.map((path) => '- `' + path + '`'), '');
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
    const steps = (record.results || []).map((result) => ({
      title: run.phaseNames && run.phaseNames[result.step_id] ? run.phaseNames[result.step_id] : result.step_id,
      detail: responseOf(result).replace(/\s+/g, ' ').slice(0, 600),
    }));
    const response = await portalFetch('/api/outcomes', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title: run.project || record.task_id, goal: run.goal || '', steps, report: runReport(record, run), source_ids: sources }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
    saveRun(record.task_id, { nodeId: body.id });
    return body.id;
  }

  function download(record) {
    const url = URL.createObjectURL(new Blob([runReport(record, runs()[record.task_id] || {})], { type: 'text/markdown' }));
    const a = el(doc, 'a', { href: url, download: record.task_id + '.md' });
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    const phases = el(doc, 'div', { class: 'oc-phases' }, (record.results || []).map((result) => {
      const text = responseOf(result).trim();
      return el(doc, 'details', { class: 'oc-phase' }, [
        el(doc, 'summary', { text: (run.phaseNames && run.phaseNames[result.step_id]) || result.step_id }),
        el(doc, 'p', { text: text || '(no text)' }),
      ]);
    }));
    const linkRow = links.length
      ? el(doc, 'div', { class: 'oc-links' }, links.map((url) => el(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'oc-link', text: '↗ ' + url.replace(/^https?:\/\//, '').slice(0, 48) })))
      : doc.createTextNode('');
    return el(doc, 'li', { class: 'oc-run', 'data-status': record.status }, [
      el(doc, 'div', { class: 'oc-run-head' }, [
        el(doc, 'strong', { text: run.project || record.task_id }),
        el(doc, 'span', { class: 'mc-chip', 'data-status': record.status, text: record.status }),
      ]),
      el(doc, 'p', { class: 'mc-muted oc-run-meta', text: record.completed_steps + '/' + record.total_steps + ' phases · ' + (record.total_tokens.input + record.total_tokens.output).toLocaleString() + ' tokens · ' + String(record.finished_at || record.started_at).slice(0, 16).replace('T', ' ') }),
      linkRow,
      phases,
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
