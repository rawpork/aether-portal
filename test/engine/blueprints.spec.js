// Blueprint ingestion and artifact dashboard against the real client bundle and a simulated engine.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { EXAMPLE_SPEC } from '../../public/js/engine/blueprint-spec.js';
import { mountBlueprintWorkspace } from '../../public/js/engine/blueprints.js';

function compiledFrom(spec, n) {
  return {
    blueprint_id: 'bp_0000000' + n + '_179000000000' + n,
    project_name: spec.projectName || 'Untitled Aether Project',
    status: 'APPROVED_FOR_EXECUTION',
    metadata: { creator: 'Kenneth Olson', lod_spatial_level: spec.lodLevel || 2, created_at: '2026-10-01T12:0' + n + ':00.000Z' },
    interview_responses: { database: 'cloudflare_d1', hosting: 'cloudflare_workers', miserly_budget_cap_usd: 2.5, unresolved_connectors: ['telegram_bot'] },
    sources: spec.links.map((l, i) => ({ source_id: 'src_' + (i + 1), url: l.url, scraped_summary: l.rawSnippet || 'Ingested from ' + (l.title || l.url), content_type: 'web_link' })),
    execution_phases: [
      { phase_index: 1, phase_name: 'Content Ingestion & Normalization', agent_role: 'Data Synthesizer', required_mcp_tools: ['fetch_url_content', 'sanitize_text'], prompt_template: 'Analyze all scraped sources.' },
      { phase_index: 2, phase_name: 'Codebase Scaffold Generation', agent_role: 'System Architect', required_mcp_tools: ['file_system_writer', 'schema_validator'], prompt_template: 'Build project.' },
    ],
    project_scaffold: [
      { path: 'CLAUDE.md', template: 'claude_md_standard', required: true },
      { path: 'PROJECT_STATE.md', template: 'project_state_standard', required: true },
    ],
    miserly_integration: { enabled: Boolean(spec.useMiserlyProxy), proxy_endpoint: spec.useMiserlyProxy ? 'https://miserly-io.klo377.workers.dev' : null, budget_cap_usd: 2.5 },
  };
}

function createEngine() {
  const engine = {
    stored: [],
    calls: [],
    taskOutcome: 'COMPLETED',
    config: { execution_mode: 'direct-anthropic', direct_fallback: { anthropic_key_configured: true, gemini_key_configured: true }, model_routes_effective: { step: 'direct-gemini' } },
    async fetch(url, init = {}) {
      const { pathname } = new URL(url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      engine.calls.push({ method, pathname, body });
      const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'POST' && pathname === '/api/blueprint/compile') {
        if (!Array.isArray(body.links) || !body.links.length) {
          return reply(400, { error: 'Invalid payload: does not match blueprint_schema.json#/definitions/compile_request.', validation_errors: [{ path: '/links', message: 'must NOT have fewer than 1 items' }] });
        }
        const blueprint = compiledFrom(body, engine.stored.length + 1);
        engine.stored.push(blueprint);
        return reply(200, { success: true, message: 'Blueprint successfully compiled and stored.', blueprint_id: blueprint.blueprint_id, artifact_path: '/out/' + blueprint.blueprint_id + '.json', logged: true, blueprint });
      }
      if (pathname === '/api/engine/config') {
        if (!engine.config) return reply(401, { error: 'Invalid token signature.' });
        return reply(200, engine.config);
      }
      if (pathname === '/api/artifacts') {
        const artifacts = [...engine.stored].reverse().map((b) => ({ filename: b.blueprint_id + '.json', blueprint_id: b.blueprint_id, project_name: b.project_name, created_at: b.metadata.created_at, status: b.status, phases: 2, sources: b.sources.length }));
        return reply(200, { success: true, count: artifacts.length, artifacts });
      }
      const one = /^\/api\/artifacts\/(.+)$/.exec(pathname);
      if (one) {
        const found = engine.stored.find((b) => b.blueprint_id === one[1]);
        return found ? reply(200, found) : reply(404, { error: 'No compiled blueprint ' + one[1] + '.' });
      }
      if (method === 'POST' && pathname === '/api/agents/execute-task') {
        const summary = { task_id: body.task_id, agent_id: body.agent_id, run_id: 'r', results: [], total_tokens: { input: 300, output: 80 } };
        if (engine.taskOutcome === 'HALTED') {
          return reply(423, { ...summary, error: 'Agent execution is currently HALTED by circuit breaker', status: 'HALTED', completed_steps: 1, interrupted_step_index: 1, interrupted_step_id: 'phase-2', halted_at: 't' });
        }
        return reply(200, { ...summary, status: 'COMPLETED', completed_steps: body.steps.length });
      }
      return reply(404, { error: 'not found' });
    },
  };
  return engine;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

let engine, ws, container, upgrades, executed, started;

async function mount(options = {}) {
  container = document.createElement('div');
  document.body.append(container);
  const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch });
  ws = mountBlueprintWorkspace(container, {
    api,
    onUpgrade: (bp) => upgrades.push(bp.blueprint_id),
    onStarted: (id) => started.push(id),
    onExecuted: (o) => executed.push(o.status),
    ...options,
  });
  await settle();
  return ws;
}

const feedbackText = () => ws.elements.feedback.textContent;
const issueLevels = () => [...ws.elements.feedback.querySelectorAll('.bp-issues li')].map((li) => li.dataset.level + ' ' + li.textContent);

async function compileExample() {
  ws.elements.exampleButton.click();
  ws.elements.form.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
}

beforeEach(() => {
  engine = createEngine();
  upgrades = [];
  executed = [];
  started = [];
});

afterEach(() => {
  ws && ws.destroy();
  container && container.remove();
  ws = container = null;
});

describe('blueprint ingestion', () => {
  it('validates pasted JSON locally and lists every problem without calling the engine', async () => {
    await mount();
    ws.elements.editor.value = JSON.stringify({ projectName: 7, links: [{ title: 'no url' }], lodLevel: 0, mystery: 1 });
    ws.elements.validateButton.click();
    expect(feedbackText()).toMatch(/^The spec has 3 problems\./);
    expect(issueLevels()).toEqual([
      "error /links/0 must have required property 'url'",
      'error /projectName must be string',
      'error /lodLevel must be >= 1',
      'warning /mystery is not part of the spec and will be ignored',
    ]);
    expect(ws.elements.editor.getAttribute('aria-invalid')).toBe('true');
    expect(engine.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('does not send an invalid spec on Compile', async () => {
    await mount();
    ws.elements.editor.value = '{ "links": ';
    ws.elements.form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(feedbackText()).toMatch(/Invalid JSON: it ends early \(line 1, column 12\)/);
    expect(engine.calls.some((c) => c.pathname === '/api/blueprint/compile')).toBe(false);
  });

  it('loads an uploaded .json file into the editor and validates it', async () => {
    await mount();
    const file = new File([JSON.stringify({ projectName: 'Uploaded', links: ['https://a.test'] })], 'spec.json', { type: 'application/json' });
    Object.defineProperty(ws.elements.fileInput, 'files', { value: [file], configurable: true });
    ws.elements.fileInput.dispatchEvent(new Event('change'));
    await settle();
    expect(JSON.parse(ws.elements.editor.value).projectName).toBe('Uploaded');
    expect(feedbackText()).toMatch(/^Valid spec: Uploaded · 1 source link\./);
    expect(issueLevels()).toEqual(['note note Turned plain URL strings into { "url": ... } links.']);
  });

  it('compiles through POST /api/blueprint/compile with the validated payload and opens the result', async () => {
    await mount();
    await compileExample();
    const call = engine.calls.find((c) => c.pathname === '/api/blueprint/compile');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual(EXAMPLE_SPEC);
    expect(feedbackText()).toBe('Compiled bp_00000001_1790000000001. Opened below.');
    expect(ws.elements.list.querySelector('[aria-current="true"]').dataset.id).toBe('bp_00000001_1790000000001');
    expect(ws.elements.viewer.querySelector('h3').textContent).toBe('Aether Knowledge Sync');
  });

  it('shows the engine’s own validation errors on a 400', async () => {
    // A valid spec locally, but the (simulated) engine sees an empty links list and rejects it with its own errors.
    engine.fetch = ((original) => async (url, init) => {
      if (init && init.body) init = { ...init, body: JSON.stringify({ links: [] }) };
      return original(url, init);
    })(engine.fetch);
    await mount();
    ws.elements.editor.value = JSON.stringify({ links: ['https://a.test'] });
    ws.elements.form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(feedbackText()).toMatch(/^The engine rejected the spec\./);
    expect(issueLevels()).toEqual(['error /links must NOT have fewer than 1 items']);
  });

  it('explains an unreachable engine', async () => {
    engine.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await mount();
    await compileExample();
    expect(feedbackText()).toBe('Can’t reach the Aether Engine at http://localhost:3333. Is it running?');
  });
});

describe('artifact dashboard', () => {
  it('lists compiled blueprints newest first and renders the selected one in full', async () => {
    await mount();
    await compileExample();
    ws.elements.editor.value = JSON.stringify({ projectName: 'Second', links: [{ url: 'javascript:alert(1)' }] });
    ws.elements.form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    const names = [...ws.elements.list.querySelectorAll('.bp-list-name')].map((n) => n.textContent);
    expect(names).toEqual(['Second', 'Aether Knowledge Sync']);

    ws.elements.list.querySelectorAll('.bp-list-item')[1].click();
    await settle();
    const viewer = ws.elements.viewer;
    expect(engine.calls.some((c) => c.pathname === '/api/artifacts/bp_00000001_1790000000001')).toBe(true);
    expect(viewer.querySelector('h3').textContent).toBe('Aether Knowledge Sync');
    expect([...viewer.querySelectorAll('.bp-fact')].map((f) => f.textContent)).toEqual([
      '2Sources',
      '2Phases',
      '2Scaffold files',
      '$2.50Miserly budget',
      'cloudflare_d1 / cloudflare_workersDatabase / hosting',
    ]);
    const [matrix, scaffold, sources] = [...viewer.querySelectorAll('table')];
    expect([...matrix.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent).join(' | '))).toEqual([
      '1 | Content Ingestion & Normalization | Data Synthesizer | fetch_url_content, sanitize_text | Miserly.io proxy · cap $2.50',
      '2 | Codebase Scaffold Generation | System Architect | file_system_writer, schema_validator | Miserly.io proxy · cap $2.50',
    ]);
    expect([...scaffold.querySelectorAll('tbody tr')].map((tr) => tr.cells[0].textContent + ':' + tr.cells[2].textContent)).toEqual(['CLAUDE.md:Yes', 'PROJECT_STATE.md:Yes']);
    const link = sources.querySelector('a');
    expect(link.getAttribute('href')).toBe('https://developers.cloudflare.com/d1/');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(viewer.querySelector('.bp-warning').textContent).toBe('Unresolved connectors: telegram_bot');
    expect(JSON.parse(viewer.querySelector('.bp-raw pre').textContent).blueprint_id).toBe('bp_00000001_1790000000001');

    // A non-http source is shown as text, never as a link.
    ws.elements.list.querySelectorAll('.bp-list-item')[0].click();
    await settle();
    const secondSources = [...ws.elements.viewer.querySelectorAll('table')][2];
    expect(secondSources.querySelector('a')).toBe(null);
    expect(secondSources.querySelector('tbody td').textContent).toBe('javascript:alert(1)');
  });

  it('shows a clear message when an artifact cannot be loaded', async () => {
    await mount();
    await ws.select('bp_deadbeef_1');
    await settle();
    expect(ws.elements.viewer.textContent).toBe('Could not load bp_deadbeef_1: No compiled blueprint bp_deadbeef_1.');
  });
});

describe('tier gating: Deploy & Execute Blueprint', () => {
  it('Free: badges the action PRO and opens the upgrade prompt instead of executing', async () => {
    await mount({ tier: 'free' });
    await compileExample();
    const deploy = ws.elements.viewer.querySelector('.bp-deploy');
    expect(deploy.querySelector('.bp-pro-badge').textContent).toBe('PRO');
    expect(container.querySelector('.bp-tier').textContent).toBe('Free · draft, validate & preview');
    deploy.click();
    expect(ws.elements.upgradeModal.hidden).toBe(false);
    expect(ws.elements.upgradeModal.textContent).toMatch(/Ask your workspace admin to switch your account to Pro\./);
    expect(ws.elements.upgradeModal.querySelector('a')).toBe(null);
    expect(upgrades).toEqual(['bp_00000001_1790000000001']);
    expect(engine.calls.some((c) => c.pathname === '/api/agents/execute-task')).toBe(false);
    ws.elements.upgradeModal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ws.elements.upgradeModal.hidden).toBe(true);
  });

  it('Free with an upgrade URL: the prompt links to it', async () => {
    await mount({ tier: 'free', upgradeUrl: 'https://billing.example/upgrade' });
    await compileExample();
    ws.elements.viewer.querySelector('.bp-deploy').click();
    expect(ws.elements.upgradeModal.querySelector('a').getAttribute('href')).toBe('https://billing.example/upgrade');
  });

  it('Pro: a "Ready to run?" preflight checks the engine, then runs every phase as a task loop on master-brain', async () => {
    await mount({ tier: 'pro' });
    await compileExample();
    const deploy = ws.elements.viewer.querySelector('.bp-deploy');
    expect(deploy.querySelector('.bp-pro-badge')).toBe(null);
    deploy.click();
    const confirm = ws.elements.viewer.querySelector('.bp-confirm');
    expect(confirm.hidden).toBe(false);
    expect(confirm.querySelector('.bp-preflight-title').textContent).toBe('Ready to run?');
    expect(confirm.textContent).toMatch(/2 phases on master-brain/);
    expect(confirm.querySelector('.bp-confirm-run').disabled).toBe(true);
    await settle();
    expect([...confirm.querySelectorAll('.bp-check')].map((li) => li.dataset.ok + ':' + li.querySelector('strong').textContent)).toEqual(['yes:Engine connection', 'yes:Model keys', 'note:Budget', 'note:Estimate']);
    expect(confirm.querySelector('.bp-confirm-run').disabled).toBe(false);
    expect(engine.calls.some((c) => c.pathname === '/api/agents/execute-task')).toBe(false);

    confirm.querySelector('.bp-confirm-run').click();
    await settle();
    const run = engine.calls.find((c) => c.pathname === '/api/agents/execute-task');
    expect(run.body.agent_id).toBe('master-brain');
    expect(run.body.task_id).toBe('deploy-bp_00000001_1790000000001');
    expect(run.body.steps.map((s) => s.step_id + ':' + s.params.prompt)).toEqual(['phase-1:Analyze all scraped sources.', 'phase-2:Build project.']);
    expect(started).toEqual(['deploy-bp_00000001_1790000000001']);
    expect(executed).toEqual(['COMPLETED']);
    expect(ws.elements.viewer.querySelector('.bp-deploy-status').textContent).toBe('Executed all 2 phases · 380 tokens.');
  });

  it('Pro: keeps Run disabled when the preflight cannot reach the engine', async () => {
    engine.config = null;
    await mount({ tier: 'pro' });
    await compileExample();
    ws.elements.viewer.querySelector('.bp-deploy').click();
    await settle();
    const confirm = ws.elements.viewer.querySelector('.bp-confirm');
    expect(confirm.querySelector('.bp-check').dataset.ok).toBe('no');
    expect(confirm.querySelector('.bp-confirm-run').disabled).toBe(true);
  });

  it('Pro: reports a breaker halt mid-run', async () => {
    engine.taskOutcome = 'HALTED';
    await mount({ tier: 'pro' });
    await compileExample();
    ws.elements.viewer.querySelector('.bp-deploy').click();
    await settle();
    ws.elements.viewer.querySelector('.bp-confirm-run').click();
    await settle();
    expect(ws.elements.viewer.querySelector('.bp-deploy-status').textContent).toBe('Halted by the circuit breaker before phase-2 (1 phases done).');
    expect(executed).toEqual(['HALTED']);
  });
});
