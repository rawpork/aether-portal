// Project flow: Space handoff, the "Ready to run?" preflight, and Outcomes & Deliverables.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { buildOf, deliverableFiles, extractLinks, finishCheckOf, mountOutcomesList, PROJECT_PAYLOAD_KEY, PROJECT_RUNS_KEY, PROJECT_SOURCES_KEY, preflightChecks, runReport, safeRelativePath, takeProjectPayload } from '../../public/js/engine/outcomes.js';

const memoryStorage = () => {
	const data = new Map();
	return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};
const spec = { projectName: 'Launch plan', links: [{ url: 'https://a.test', title: 'A' }, { url: 'https://portal.test/node/n2', title: 'Note', rawSnippet: 'text' }] };

describe('takeProjectPayload', () => {
	it('returns a fresh payload once and remembers its cards under the project name', () => {
		const storage = memoryStorage();
		storage.setItem(PROJECT_PAYLOAD_KEY, JSON.stringify({ spec, sourceIds: ['n1', 'n2'], at: 1000 }));
		expect(takeProjectPayload(storage, 2000)).toEqual({ spec, sourceIds: ['n1', 'n2'] });
		expect(JSON.parse(storage.getItem(PROJECT_SOURCES_KEY))).toEqual({ 'Launch plan': ['n1', 'n2'] });
		expect(takeProjectPayload(storage, 2000)).toBeNull();
	});

	it('ignores stale or malformed payloads', () => {
		const storage = memoryStorage();
		storage.setItem(PROJECT_PAYLOAD_KEY, JSON.stringify({ spec, sourceIds: [], at: 0 }));
		expect(takeProjectPayload(storage, 60 * 60 * 1000)).toBeNull();
		storage.setItem(PROJECT_PAYLOAD_KEY, '{"spec":{}}');
		expect(takeProjectPayload(storage, 1)).toBeNull();
	});
});

describe('preflightChecks', () => {
	const config = (extra) => ({ execution_mode: 'direct-anthropic', direct_fallback: { anthropic_key_configured: true, gemini_key_configured: true }, model_routes_effective: { step: 'direct-gemini' }, ...extra });

	it('passes with a reachable engine and keys, and estimates tokens without inventing prices', () => {
		const { checks, canRun } = preflightChecks({ config: config(), phases: 4, relay: true });
		expect(canRun).toBe(true);
		expect(checks.map((c) => c.id + ':' + c.ok)).toEqual(['engine:true', 'keys:true', 'budget:null', 'estimate:null']);
		expect(checks[0].detail).toMatch(/portal relay \(tunnel up\)/);
		expect(checks[1].detail).toMatch(/Gemini \(Google\).*Anthropic, Gemini/);
		expect(checks[3].detail).toMatch(/about 16,000 tokens/);
		expect(checks.map((c) => c.detail).join(' ')).not.toMatch(/\$/);
	});

	it('blocks the run when the engine is unreachable or has no model key, and warns in sandbox mode', () => {
		expect(preflightChecks({ config: null, error: new Error('down'), phases: 2 }).canRun).toBe(false);
		const none = preflightChecks({ config: config({ execution_mode: 'unconfigured', model_routes_effective: { step: 'unconfigured' } }), phases: 2 });
		expect(none.canRun).toBe(false);
		expect(none.checks[1].ok).toBe(false);
		const sandbox = preflightChecks({ config: config({ execution_mode: 'miserly-free', model_routes_effective: { step: 'miserly-free' } }), phases: 2 });
		expect(sandbox.checks[1]).toMatchObject({ ok: null, detail: expect.stringMatching(/canned replies/) });
	});

	it('shows the Miserly cap only when Miserly is in use', () => {
		const { checks } = preflightChecks({ config: config({ execution_mode: 'miserly', model_routes_effective: { step: 'miserly' } }), phases: 1, budgetCapUsd: 2.5 });
		expect(checks.find((c) => c.id === 'budget').detail).toBe('Miserly caps this run at $2.50.');
	});
});

describe('extractLinks and runReport', () => {
	const record = {
		task_id: 'deploy-bp_1', status: 'COMPLETED', started_at: '2026-10-04T12:00:00Z', finished_at: '2026-10-04T12:05:00Z', total_tokens: { input: 900, output: 300 },
		results: [
			{ step_id: 'phase-1', output: { response: 'Read https://docs.test/guide. Also https://docs.test/guide again.' } },
			{ step_id: 'phase-2', output: { response: 'Deployed preview at https://preview.test/app, done.' } },
		],
	};
	it('collects unique links from the answers', () => {
		expect(extractLinks(record.results.map((r) => r.output.response))).toEqual(['https://docs.test/guide', 'https://preview.test/app']);
	});
	it('writes a Markdown report with phases, links and scaffold', () => {
		const md = runReport(record, { project: 'Launch plan', phaseNames: { 'phase-1': 'Ingest', 'phase-2': 'Ship' }, scaffold: ['README.md'] });
		expect(md).toMatch(/^# Launch plan/);
		expect(md).toMatch(/## Ingest\n\nRead https/);
		expect(md).toMatch(/## Links\n\n- https:\/\/docs.test\/guide\n- https:\/\/preview.test\/app/);
		expect(md).toMatch(/## Generated artifacts\n\n- `README.md`/);
	});
});

describe('Outcomes & Deliverables list', () => {
	let container, view, storage, posts;
	const record = {
		task_id: 'deploy-bp_9', agent_id: 'master-brain', run_id: 'r9', status: 'COMPLETED', total_steps: 1, completed_steps: 1, started_at: '2026-10-04T12:00:00Z', finished_at: '2026-10-04T12:01:00Z',
		total_tokens: { input: 10, output: 5 }, history: [], plan: [], results: [{ step_index: 0, step_id: 'phase-1', action: 'prompt', output: { response: 'See https://out.test/report' }, tokens: { input: 10, output: 5 } }],
	};
	const engineFetch = async (url) => {
		const { pathname } = new URL(url);
		const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
		if (pathname === '/api/tasks') return json({ tasks: [{ ...record, current_step: null, interrupted_step_index: null }, { task_id: 'other', agent_id: 'x', status: 'COMPLETED', total_tokens: { input: 0, output: 0 } }], counts: {} });
		return json(record);
	};
	const portalFetch = async (url, init) => {
		posts.push({ url, body: JSON.parse(init.body) });
		return new Response(JSON.stringify({ success: true, id: 'node_outcome_1' }), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	beforeEach(() => {
		vi.useFakeTimers();
		posts = [];
		storage = memoryStorage();
		container = document.createElement('div');
		document.body.append(container);
	});
	afterEach(() => {
		view && view.destroy();
		container.remove();
		vi.useRealTimers();
	});

	it('lists project runs with their links, and Add to Space turns into Open in Space', async () => {
		storage.setItem(PROJECT_RUNS_KEY, JSON.stringify({ 'deploy-bp_9': { project: 'Launch plan', phaseNames: { 'phase-1': 'Ingest' } } }));
		storage.setItem(PROJECT_SOURCES_KEY, JSON.stringify({ 'Launch plan': ['n1', 'n2'] }));
		view = mountOutcomesList(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch }), storage, portalFetch });
		await vi.advanceTimersByTimeAsync(0);
		expect([...container.querySelectorAll('.oc-run strong')].map((n) => n.textContent)).toEqual(['Launch plan']);
		expect(container.querySelector('.oc-link').getAttribute('href')).toBe('https://out.test/report');
		const add = [...container.querySelectorAll('.oc-run-actions button')].find((b) => b.textContent === 'Add to Space');
		add.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(posts[0].url).toBe('/api/outcomes');
		expect(posts[0].body).toMatchObject({ title: 'Launch plan', source_ids: ['n1', 'n2'], steps: [{ title: 'Ingest' }] });
		expect(posts[0].body.report).toMatch(/^# Launch plan/);
		expect(container.querySelector('.oc-open-space').getAttribute('href')).toBe('/node/node_outcome_1');
	});

	it('records a finished blueprint run and adds it to Space by itself', async () => {
		view = mountOutcomesList(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch }), storage, portalFetch });
		await vi.advanceTimersByTimeAsync(0);
		await view.recordRun({ blueprint_id: 'bp_9', project_name: 'Launch plan', execution_phases: [{ phase_index: 1, phase_name: 'Ingest' }], project_scaffold: [{ path: 'README.md' }], sources: [] }, { status: 'COMPLETED', agent_id: 'master-brain' });
		await vi.advanceTimersByTimeAsync(0);
		expect(posts).toHaveLength(1);
		expect(JSON.parse(storage.getItem(PROJECT_RUNS_KEY))['deploy-bp_9']).toMatchObject({ project: 'Launch plan', nodeId: 'node_outcome_1', scaffold: ['README.md'] });
	});
});

describe('project runs: plan, deliverable files and the live preview', () => {
	const planStep = (preview) => ({ step_index: 0, step_id: 'plan', action: 'echo', output: { elarion_plan: { summary: 'Build the kit.', goals: ['Ship a page'], planned_by: 'elarion', preview_page: preview, dag: [{ id: 'build', title: 'Build', depends_on: [] }] } }, tokens: { input: 0, output: 0 } });
	const files = 'Done.\n````file:README.md\n# Kit\n```sh\nnpm start\n```\n````\n````file:preview/index.html\n<!doctype html><title>Kit</title>\n````\n````file:../escape\nno\n````';
	const project = (preview) => ({
		task_id: 'deploy-bp_7', agent_id: 'master-brain', run_id: 'r7', status: 'COMPLETED', total_steps: 3, completed_steps: 3, started_at: 't', finished_at: 't2', total_tokens: { input: 5, output: 5 }, history: [], plan: [],
		results: [planStep(preview), { step_index: 1, step_id: 'step-build', action: 'prompt', output: { response: 'Built.' }, tokens: { input: 1, output: 1 } }, { step_index: 2, step_id: 'deliverables', action: 'prompt', output: { response: files }, tokens: { input: 1, output: 1 } }],
	});

	it('reads the deliverable files safely, keeping fences inside them', () => {
		expect(deliverableFiles(project(false))).toEqual([{ path: 'README.md', content: '# Kit\n```sh\nnpm start\n```' }, { path: 'preview/index.html', content: '<!doctype html><title>Kit</title>' }]);
		expect(safeRelativePath('a/../../b')).toBeNull();
	});

	it('puts the plan, step titles and file contents into the report', () => {
		const md = runReport(project(false), { project: 'Kit' });
		expect(md).toMatch(/## Plan\n\nBuild the kit\.\n\n- Goal: Ship a page\n\n1\. Build/);
		expect(md).toMatch(/## Build\n\nBuilt\./);
		expect(md).toMatch(/## Deliverables\n/);
		expect(md).toMatch(/## Deliverable files\n\n- `README.md`/);
		expect(md).toMatch(/### README.md\n\n````\n# Kit/);
		expect(md).not.toMatch(/## plan/);
	});

	const mountProject = async (preview) => {
		const record = project(preview);
		const storage = memoryStorage();
		const posts = [];
		const container = document.createElement('div');
		document.body.append(container);
		const engineFetch = async (url) => {
			const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
			return new URL(url).pathname === '/api/tasks' ? json({ tasks: [record], counts: {} }) : json(record);
		};
		const portalFetch = async (url, init) => {
			posts.push({ url, body: JSON.parse(init.body) });
			const body = url === '/api/sites' ? { success: true, site: { slug: 'kit', status: 'draft', url: '/s/kit', unpublished_changes: false } } : { success: true, id: 'node_kit' };
			return new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } });
		};
		const view = mountOutcomesList(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engineFetch }), storage, portalFetch });
		await view.recordRun({ blueprint_id: 'bp_7', project_name: 'Kit', execution_phases: [], project_scaffold: [], sources: [] }, { status: 'COMPLETED', agent_id: 'master-brain' });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		return { container, posts, view };
	};

	it('drafts the preview page at /s/ when the blueprint asked for it, and publishes only after approval', async () => {
		const { container, posts, view } = await mountProject(true);
		expect(posts.map((p) => p.url)).toEqual(['/api/sites', '/api/outcomes']);
		expect(posts[0].body).toEqual({ title: 'Kit', html: '<!doctype html><title>Kit</title>' });
		expect(posts[1].body.report).toMatch(/## Live preview\n\n- \/s\/kit \(draft until approved/);
		expect([...container.querySelectorAll('.oc-file')].map((b) => b.textContent)).toEqual(['⤓ README.md', '⤓ preview/index.html']);
		expect(container.querySelector('.oc-preview a').getAttribute('href')).toBe('/s/kit?preview=1');
		const confirm = container.querySelector('.oc-site-confirm');
		expect(confirm.hidden).toBe(true);
		container.querySelector('.oc-site-publish').click();
		expect(confirm.hidden).toBe(false);
		expect(posts.some((p) => p.url.endsWith('/publish'))).toBe(false);
		container.querySelector('.oc-site-approve').click();
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		expect(posts.at(-1)).toEqual({ url: '/api/sites/kit/publish', body: { approve: true } });
		view.destroy();
		container.remove();
	});

	it('writes no page when the blueprint did not ask for a preview', async () => {
		const { container, posts, view } = await mountProject(false);
		expect(posts.map((p) => p.url)).toEqual(['/api/outcomes']);
		expect(container.querySelector('.oc-preview')).toBeNull();
		view.destroy();
		container.remove();
	});
});

describe('missing pieces and the finish line', () => {
	const record = {
		task_id: 'deploy-bp_8', agent_id: 'master-brain', run_id: 'r8', status: 'COMPLETED', total_steps: 4, completed_steps: 4, started_at: 't', finished_at: 't2', total_tokens: { input: 1, output: 1 }, history: [], plan: [],
		results: [
			{ step_index: 0, step_id: 'plan', action: 'echo', output: { elarion_plan: { summary: 'S', goals: ['G'], planned_by: 'elarion', preview_page: false, dag: [], gaps: [{ kind: 'auth', need: 'Wire the API key.', evidence: 'get an API key' }] } } },
			{ step_index: 1, step_id: 'gap-fill', action: 'prompt', output: { response: 'Filled.' } },
			{ step_index: 2, step_id: 'finish-line', action: 'prompt', output: { response: 'Done.', finish_check: { placeholders_before: 2, placeholders_after: 0, repairs: 1, remaining: [] } } },
		],
	};

	it('names the new steps, and the report lists the gaps and the finish line', () => {
		expect(finishCheckOf(record)).toMatchObject({ placeholders_after: 0, repairs: 1 });
		const md = runReport(record, { project: 'Weather' });
		expect(md).toMatch(/## Missing pieces found\n\n- auth: Wire the API key\. \("get an API key"\)/);
		expect(md).toMatch(/## Finish line\n\n- Placeholders left: 0 \(fixed 2 in 1 pass\)/);
		expect(md).toMatch(/## Missing pieces filled\n\nFilled\./);
		expect(md).toMatch(/## Finish line & polish\n\nDone\./);
	});

	it('shows the finish-line badge on the run', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
		const view = mountOutcomesList(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async (url) => (new URL(url).pathname === '/api/tasks' ? json({ tasks: [record], counts: {} }) : json(record)) }), storage: memoryStorage(), portalFetch: async () => json({ sites: [] }) });
		for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
		expect(container.querySelector('.oc-finish').textContent).toBe('✓ Finish line: no TODOs or placeholders left (Elarion fixed 2)');
		expect(container.querySelector('.oc-gaps li').textContent).toBe('auth: Wire the API key.');
		view.destroy();
		container.remove();
	});
});

describe('sandbox build on a run', () => {
	const record = {
		task_id: 'deploy-bp_9b', agent_id: 'master-brain', run_id: 'r9b', status: 'COMPLETED', total_steps: 2, completed_steps: 2, started_at: 't', finished_at: 't2', total_tokens: { input: 1, output: 1 }, history: [], plan: [],
		results: [{ step_index: 1, step_id: 'build', action: 'build', output: {
			response: '', build: { status: 'passed', kind: 'node', rounds: [{ ok: false }, { ok: true }] },
			staging: { url: 'https://abc.aether-x.pages.dev', alias: 'https://staging.aether-x.pages.dev', project: 'aether-x', routes: [] },
			viability: { score: 88, viable: true, verdict: 'Ready to launch', checks: [{ name: 'Build', ok: true, detail: 'npm install and build passed.' }], settings_needed: ['API_KEY'] },
		} }],
	};
	it('shows the build, viability and staging link, and the report lists them', async () => {
		expect(buildOf(record).viability.score).toBe(88);
		const md = runReport(record, { project: 'X' });
		expect(md).toMatch(/## Sandbox build\n\n- Build: passed, 2 rounds\n- Staging: https:\/\/abc\.aether-x\.pages\.dev\n- Viability: 88\/100 \(Ready to launch\)\n  - Build: npm install and build passed\./);
		const container = document.createElement('div');
		document.body.append(container);
		const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
		const view = mountOutcomesList(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async (url) => (new URL(url).pathname === '/api/tasks' ? json({ tasks: [record], counts: {} }) : json(record)) }), storage: memoryStorage(), portalFetch: async () => json({}) });
		for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
		expect(container.querySelector('.oc-build-line').textContent).toBe('✓ Sandbox build passed · Viability 88/100 · Ready to launch');
		expect(container.querySelector('.oc-build a').getAttribute('href')).toBe('https://abc.aether-x.pages.dev');
		expect(container.querySelector('.oc-build p.mc-muted').textContent).toBe('Set before going live: API_KEY');
		view.destroy();
		container.remove();
	});
});
