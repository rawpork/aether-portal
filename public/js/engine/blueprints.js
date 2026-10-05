// Blueprints workspace for Mission Control: ingest a blueprint spec (paste, upload or drop JSON), validate it,
// compile it on the engine (POST /api/blueprint/compile), and browse compiled artifacts (GET /api/artifacts and
// /api/artifacts/:id) with their route matrix, generated scaffold and sources.
//
// Tier gating: every tier can draft, validate, compile and preview. "Deploy & Execute Blueprint" is a Pro Engine
// action: Pro runs the blueprint's phases as a sub-agent task loop on master-brain; other tiers get the upgrade prompt.
import { getEngineApi } from '../engine-api.bundle.js';
import { EXAMPLE_SPEC, blueprintToTaskSteps, isProTier, parseBlueprintSpec, routeMatrix } from './blueprint-spec.js';
import { describeAuthError } from './connection.js';
import { runPreflight } from './outcomes.js';

export const EXECUTE_AGENT_ID = 'master-brain';

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

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function mountBlueprintWorkspace(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const tier = options.tier || 'free';
  const pro = isProTier(tier);
  const upgradeUrl = options.upgradeUrl || '';
  const onUpgrade = options.onUpgrade || (() => {});
  const onStarted = options.onStarted || (() => {});
  const onExecuted = options.onExecuted || (() => {});
  // (blueprint, outcome) after every run: the Outcomes list records it and, when it completed, adds it to Space.
  const onCompleted = options.onCompleted || (() => {});

  let artifacts = [];
  let selectedId = null;
  let selected = null; // full blueprint, or { error }
  let destroyed = false;

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------
  const editor = el(doc, 'textarea', {
    class: 'bp-editor',
    rows: '12',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Blueprint spec JSON',
    'aria-describedby': 'bp-feedback',
    placeholder: '{\n  "projectName": "My project",\n  "links": [{ "url": "https://…" }]\n}',
  });
  const fileInput = el(doc, 'input', { type: 'file', accept: '.json,application/json', class: 'bp-file', hidden: true });
  const uploadButton = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Upload .json' });
  const exampleButton = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Insert example' });
  const validateButton = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Validate' });
  const compileButton = el(doc, 'button', { type: 'submit', class: 'bp-primary', text: 'Compile blueprint' });
  const feedback = el(doc, 'div', { id: 'bp-feedback', class: 'bp-feedback', 'aria-live': 'polite' });
  const form = el(doc, 'form', { class: 'bp-card bp-ingest', autocomplete: 'off', 'aria-labelledby': 'bp-ingest-title' }, [
    el(doc, 'div', { class: 'bp-card-head' }, [
      el(doc, 'h2', { id: 'bp-ingest-title', text: 'Blueprint ingestion' }),
      el(doc, 'span', { class: 'bp-tier', 'data-tier': pro ? 'pro' : 'free', text: pro ? 'Pro Engine' : 'Free · draft, validate & preview' }),
    ]),
    el(doc, 'p', { class: 'mc-muted', text: 'Paste, upload or drop a blueprint spec: source links plus project settings. It is checked against the engine’s compile contract before it is sent.' }),
    editor,
    fileInput,
    el(doc, 'div', { class: 'bp-actions' }, [uploadButton, exampleButton, el(doc, 'span', { class: 'mc-spacer' }), validateButton, compileButton]),
    feedback,
  ]);

  function showFeedback(kind, title, items = []) {
    const box = el(doc, 'div', { class: 'bp-result', 'data-kind': kind }, [el(doc, 'p', { class: 'bp-result-title', text: title })]);
    if (items.length) {
      box.append(
        el(doc, 'ul', { class: 'bp-issues' }, items.map((i) => el(doc, 'li', { 'data-level': i.level }, [el(doc, 'code', { text: i.path }), doc.createTextNode(' ' + i.message)]))),
      );
    }
    feedback.replaceChildren(box);
  }

  function issues(result) {
    return [
      ...result.errors.map((e) => ({ ...e, level: 'error' })),
      ...result.warnings.map((w) => ({ ...w, level: 'warning' })),
      ...result.notes.map((n) => ({ path: 'note', message: n, level: 'note' })),
    ];
  }

  function validate() {
    const result = parseBlueprintSpec(editor.value);
    if (!result.ok) {
      showFeedback('error', result.errors.length === 1 ? 'The spec has 1 problem.' : 'The spec has ' + result.errors.length + ' problems.', issues(result));
      editor.setAttribute('aria-invalid', 'true');
    } else {
      const links = result.spec.links.length;
      showFeedback('ok', 'Valid spec: ' + (result.spec.projectName || 'Untitled Aether Project') + ' · ' + links + (links === 1 ? ' source link' : ' source links') + '.', issues(result));
      editor.removeAttribute('aria-invalid');
    }
    return result;
  }

  function engineErrorText(error) {
    if (!error) return 'Unknown error.';
    if (error.isUnreachable) return 'Can’t reach the Aether Engine at ' + api.baseUrl + '. Is it running?';
    if (error.isUnauthorized) return describeAuthError(error);
    return error.message || 'The engine returned an error.';
  }

  async function compile() {
    const result = validate();
    if (!result.ok) return;
    compileButton.disabled = true;
    compileButton.textContent = 'Compiling…';
    try {
      const compiled = await api.compileBlueprint(result.spec);
      showFeedback('ok', 'Compiled ' + compiled.blueprint_id + (compiled.logged ? '' : ' (the engine could not write its forensic log)') + '. Opened below.');
      await refresh();
      await select(compiled.blueprint_id, compiled.blueprint);
    } catch (error) {
      if (error && error.status === 400 && error.body && Array.isArray(error.body.validation_errors)) {
        showFeedback('error', 'The engine rejected the spec.', error.body.validation_errors.map((e) => ({ ...e, level: 'error' })));
      } else {
        showFeedback('error', engineErrorText(error));
      }
    } finally {
      compileButton.disabled = false;
      compileButton.textContent = 'Compile blueprint';
    }
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.size > 256 * 1024) {
      showFeedback('error', file.name + ' is larger than 256 KB.');
      return;
    }
    editor.value = await file.text();
    validate();
  }

  uploadButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    loadFile(fileInput.files && fileInput.files[0]);
    fileInput.value = '';
  });
  editor.addEventListener('dragover', (event) => {
    event.preventDefault();
    editor.classList.add('bp-drop');
  });
  editor.addEventListener('dragleave', () => editor.classList.remove('bp-drop'));
  editor.addEventListener('drop', (event) => {
    event.preventDefault();
    editor.classList.remove('bp-drop');
    loadFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
  });
  exampleButton.addEventListener('click', () => {
    editor.value = JSON.stringify(EXAMPLE_SPEC, null, 2);
    validate();
    editor.focus();
  });
  validateButton.addEventListener('click', validate);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    compile();
  });

  // ---------------------------------------------------------------------------
  // Artifacts: list and viewer
  // ---------------------------------------------------------------------------
  const listStatus = el(doc, 'span', { class: 'mc-muted', 'aria-live': 'polite' });
  const refreshButton = el(doc, 'button', { type: 'button', class: 'toggle-button bp-refresh', text: 'Refresh' });
  const list = el(doc, 'ul', { class: 'bp-list', 'aria-label': 'Compiled blueprints' });
  const listEmpty = el(doc, 'p', { class: 'mc-empty', text: 'No compiled blueprints yet. Compile a spec above.' });
  const viewer = el(doc, 'article', { class: 'bp-viewer', 'aria-label': 'Blueprint viewer' });
  const artifactsCard = el(doc, 'section', { class: 'bp-card bp-artifacts', 'aria-labelledby': 'bp-artifacts-title' }, [
    el(doc, 'div', { class: 'bp-card-head' }, [el(doc, 'h2', { id: 'bp-artifacts-title', text: 'Artifacts' }), listStatus, el(doc, 'span', { class: 'mc-spacer' }), refreshButton]),
    el(doc, 'div', { class: 'bp-browser' }, [el(doc, 'div', { class: 'bp-list-wrap' }, [listEmpty, list]), viewer]),
  ]);

  // Upgrade prompt for the Pro-gated action.
  const upgradeClose = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Not now' });
  const upgradeActions = el(doc, 'div', { class: 'modal-actions' }, [upgradeClose]);
  if (upgradeUrl) upgradeActions.append(el(doc, 'a', { class: 'bp-primary bp-upgrade-link', href: upgradeUrl, text: 'Upgrade to Pro' }));
  const upgradeModal = el(doc, 'div', { class: 'modal-backdrop bp-upgrade-modal', hidden: true }, [
    el(doc, 'div', { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bp-upgrade-title' }, [
      el(doc, 'h3', { id: 'bp-upgrade-title', text: 'Deploy & Execute is a Pro Engine feature' }),
      el(doc, 'p', {
        class: 'engine-modal-text',
        text: 'Your Free plan can draft, validate, compile and preview blueprints. Pro runs a compiled blueprint’s phases as a sub-agent task loop on your engine, with live progress in the Task Loop Monitor and the circuit breaker in control.',
      }),
      el(doc, 'p', { class: 'engine-modal-text mc-muted', text: upgradeUrl ? 'Upgrading unlocks it on this account.' : 'Ask your workspace admin to switch your account to Pro.' }),
      upgradeActions,
    ]),
  ]);
  doc.body.append(upgradeModal);
  function closeUpgrade() {
    upgradeModal.hidden = true;
    const trigger = viewer.querySelector('.bp-deploy');
    if (trigger) trigger.focus();
  }
  upgradeClose.addEventListener('click', closeUpgrade);
  upgradeModal.addEventListener('click', (event) => {
    if (event.target === upgradeModal) closeUpgrade();
  });
  upgradeModal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeUpgrade();
  });

  function renderList() {
    listEmpty.hidden = artifacts.length > 0;
    list.replaceChildren(
      ...artifacts.map((a) => {
        const meta = [formatWhen(a.created_at), a.phases != null ? a.phases + ' phases' : '', a.sources != null ? a.sources + ' sources' : ''].filter(Boolean).join(' · ');
        const button = el(doc, 'button', { type: 'button', class: 'bp-list-item', 'data-id': a.blueprint_id }, [
          el(doc, 'span', { class: 'bp-list-name', text: a.project_name || a.blueprint_id }),
          el(doc, 'span', { class: 'mc-chip', 'data-status': a.status, text: a.status }),
          el(doc, 'span', { class: 'bp-list-meta', text: meta }),
        ]);
        if (a.blueprint_id === selectedId) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => select(a.blueprint_id));
        return el(doc, 'li', {}, [button]);
      }),
    );
  }

  function table(headers, rows, caption) {
    return el(doc, 'div', { class: 'bp-table-wrap' }, [
      el(doc, 'table', { class: 'bp-table' }, [
        el(doc, 'caption', { text: caption }),
        el(doc, 'thead', {}, [el(doc, 'tr', {}, headers.map((h) => el(doc, 'th', { scope: 'col', text: h })))]),
        el(doc, 'tbody', {}, rows.map((cells) => el(doc, 'tr', {}, cells.map((c) => el(doc, 'td', {}, [typeof c === 'string' ? doc.createTextNode(c) : c]))))),
      ]),
    ]);
  }

  function fact(label, value) {
    return el(doc, 'div', { class: 'bp-fact' }, [el(doc, 'span', { class: 'bp-fact-value', text: value }), el(doc, 'span', { class: 'bp-fact-label', text: label })]);
  }

  function renderViewer() {
    if (!selectedId) {
      viewer.replaceChildren(el(doc, 'p', { class: 'mc-empty', text: 'Select a compiled blueprint to preview it.' }));
      return;
    }
    if (!selected) {
      viewer.replaceChildren(el(doc, 'p', { class: 'mc-muted', text: 'Loading ' + selectedId + '…' }));
      return;
    }
    if (selected.error) {
      viewer.replaceChildren(el(doc, 'p', { class: 'bp-result', 'data-kind': 'error', text: 'Could not load ' + selectedId + ': ' + engineErrorText(selected.error) }));
      return;
    }
    const bp = selected;
    const meta = bp.metadata || {};
    const interview = bp.interview_responses || {};
    const miserly = bp.miserly_integration || {};
    const phases = bp.execution_phases || [];

    // Deploy & Execute (Pro-gated).
    const deploy = el(doc, 'button', { type: 'button', class: 'bp-primary bp-deploy' }, [doc.createTextNode('Deploy & Execute Blueprint')]);
    if (!pro) {
      deploy.setAttribute('aria-haspopup', 'dialog');
      deploy.append(el(doc, 'span', { class: 'bp-pro-badge', text: 'PRO' }));
    }
    const deployStatus = el(doc, 'p', { class: 'bp-deploy-status mc-muted', 'aria-live': 'polite' });
    const confirmCancel = el(doc, 'button', { type: 'button', class: 'toggle-button bp-confirm-cancel', text: 'Cancel' });
    const confirmRun = el(doc, 'button', { type: 'button', class: 'bp-primary bp-confirm-run', text: 'Run blueprint' });
    // "Ready to run?" preflight: engine connection, model keys, budget and an estimate, before anything is spent.
    const checkList = el(doc, 'ul', { class: 'bp-checks' });
    const confirmRow = el(doc, 'div', { class: 'bp-confirm bp-preflight', hidden: true, role: 'group', 'aria-label': 'Ready to run?' }, [
      el(doc, 'h4', { class: 'bp-preflight-title', text: 'Ready to run?' }),
      el(doc, 'p', { class: 'mc-muted', text: phases.length + (phases.length === 1 ? ' phase' : ' phases') + ' on ' + EXECUTE_AGENT_ID + ', one model call each through the engine.' }),
      checkList,
      el(doc, 'div', { class: 'bp-preflight-actions' }, [confirmCancel, confirmRun]),
    ]);
    const showPreflight = async () => {
      confirmRun.disabled = true;
      checkList.replaceChildren(el(doc, 'li', { class: 'bp-check', 'data-ok': 'pending', text: 'Checking the engine…' }));
      const { checks, canRun } = await runPreflight({ api, phases: phases.length, budgetCapUsd: miserly.enabled ? miserly.budget_cap_usd : null });
      checkList.replaceChildren(...checks.map((check) => el(doc, 'li', { class: 'bp-check', 'data-ok': check.ok === true ? 'yes' : check.ok === false ? 'no' : 'note' }, [
        el(doc, 'span', { class: 'bp-check-mark', 'aria-hidden': 'true', text: check.ok === true ? '✓' : check.ok === false ? '✕' : '•' }),
        el(doc, 'strong', { text: check.label }),
        doc.createTextNode(' ' + check.detail),
      ])));
      confirmRun.disabled = !canRun;
      if (canRun) confirmRun.focus();
    };
    deploy.addEventListener('click', () => {
      if (!pro) {
        onUpgrade(bp);
        upgradeModal.hidden = false;
        upgradeClose.focus();
        return;
      }
      confirmRow.hidden = false;
      showPreflight();
    });
    confirmCancel.addEventListener('click', () => {
      confirmRow.hidden = true;
      deploy.focus();
    });
    confirmRun.addEventListener('click', () => execute(bp, deploy, confirmRow, deployStatus));

    const json = JSON.stringify(bp, null, 2);
    const download = el(doc, 'button', { type: 'button', class: 'toggle-button bp-download', text: 'Download JSON' });
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = el(doc, 'a', { href: url, download: bp.blueprint_id + '.json' });
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const sourceCell = (url) => (/^https?:\/\//i.test(url) ? el(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }) : doc.createTextNode(String(url)));
    const connectors = interview.unresolved_connectors || [];

    viewer.replaceChildren(
      el(doc, 'header', { class: 'bp-viewer-head' }, [
        el(doc, 'div', {}, [
          el(doc, 'h3', { text: bp.project_name }),
          el(doc, 'p', { class: 'mc-muted', text: [bp.blueprint_id, formatWhen(meta.created_at), 'by ' + (meta.creator || 'unknown'), 'LOD ' + (meta.lod_spatial_level || '?')].filter(Boolean).join(' · ') }),
        ]),
        el(doc, 'span', { class: 'mc-chip', 'data-status': bp.status, text: bp.status }),
      ]),
      el(doc, 'div', { class: 'bp-facts' }, [
        fact('Sources', String((bp.sources || []).length)),
        fact('Phases', String(phases.length)),
        fact('Scaffold files', String((bp.project_scaffold || []).length)),
        fact('Miserly budget', miserly.enabled ? '$' + Number(miserly.budget_cap_usd || 0).toFixed(2) : 'Proxy off'),
        fact('Database / hosting', (interview.database || '?') + ' / ' + (interview.hosting || '?')),
      ]),
      el(doc, 'div', { class: 'bp-deploy-row' }, [deploy, download]),
      confirmRow,
      deployStatus,
      el(doc, 'h4', { text: 'Route matrix' }),
      table(
        ['#', 'Phase', 'Agent role', 'MCP tools', 'Model route'],
        routeMatrix(bp).map((r) => [String(r.phase), r.name, r.role, r.tools.join(', ') || '—', r.route + (r.budget != null ? ' · cap $' + Number(r.budget).toFixed(2) : '')]),
        'How each execution phase is routed',
      ),
      el(doc, 'h4', { text: 'Generated artifacts' }),
      table(['Path', 'Template', 'Required'], (bp.project_scaffold || []).map((f) => [f.path, f.template, f.required ? 'Yes' : 'No']), 'Project scaffold the blueprint generates'),
      el(doc, 'h4', { text: 'Sources' }),
      table(['Source', 'Summary'], (bp.sources || []).map((s) => [sourceCell(s.url), s.scraped_summary || '']), 'Ingested sources'),
      connectors.length ? el(doc, 'p', { class: 'bp-warning', text: 'Unresolved connectors: ' + connectors.join(', ') }) : doc.createTextNode(''),
      el(doc, 'details', { class: 'bp-raw' }, [el(doc, 'summary', { text: 'Raw blueprint JSON' }), el(doc, 'pre', { text: json })]),
    );
  }

  async function execute(bp, deploy, confirmRow, deployStatus) {
    confirmRow.hidden = true;
    deploy.disabled = true;
    const taskId = 'deploy-' + bp.blueprint_id;
    deployStatus.textContent = 'Running ' + taskId + '… progress is live in the Task Loop Monitor.';
    try {
      const run = api.executeSubAgentTask(EXECUTE_AGENT_ID, taskId, blueprintToTaskSteps(bp));
      onStarted(taskId);
      const outcome = await run;
      const tokens = outcome.total_tokens.input + outcome.total_tokens.output;
      deployStatus.textContent =
        outcome.status === 'COMPLETED'
          ? 'Executed all ' + outcome.completed_steps + ' phases · ' + tokens.toLocaleString() + ' tokens.'
          : 'Halted by the circuit breaker before ' + outcome.interrupted_step_id + ' (' + outcome.completed_steps + ' phases done).';
      onExecuted(outcome);
      onCompleted(bp, outcome);
    } catch (error) {
      deployStatus.textContent = 'Execution failed: ' + engineErrorText(error);
    } finally {
      deploy.disabled = false;
    }
  }

  async function select(id, preloaded) {
    selectedId = id;
    selected = preloaded || null;
    renderList();
    renderViewer();
    if (preloaded) return;
    try {
      const bp = await api.getArtifact(id);
      if (selectedId === id) selected = bp;
    } catch (error) {
      if (selectedId === id) selected = { error };
    }
    if (selectedId === id) renderViewer();
  }

  async function refresh() {
    if (destroyed) return;
    listStatus.textContent = 'Loading…';
    try {
      artifacts = (await api.listArtifacts()).artifacts;
      listStatus.textContent = artifacts.length + (artifacts.length === 1 ? ' blueprint' : ' blueprints');
      renderList();
    } catch (error) {
      listStatus.textContent = engineErrorText(error);
    }
  }

  refreshButton.addEventListener('click', refresh);

  container.replaceChildren(form, artifactsCard);
  renderViewer();
  refresh();

  // Puts a spec into the editor and validates it (used for outcome blueprints sent from the main portal).
  function loadSpec(text) {
    editor.value = text;
    const result = validate();
    editor.focus();
    return result;
  }

  return {
    refresh,
    select,
    validate,
    loadSpec,
    getSelected: () => selected,
    elements: { form, editor, fileInput, uploadButton, exampleButton, validateButton, compileButton, feedback, list, listEmpty, viewer, upgradeModal, refreshButton },
    destroy() {
      destroyed = true;
      upgradeModal.remove();
      container.replaceChildren();
    },
  };
}
