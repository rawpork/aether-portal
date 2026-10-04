// Agent dialogue: run records as agent conversations, with choice chips in the thread.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { AGENT_COLOURS, buildThread, mountAgentDialogue, splitHandOff } from '../../public/js/engine/agent-dialogue.js';

const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const reply = (i, id, response) => ({ step_index: i, step_id: id, action: 'prompt', status: 'COMPLETED', output: { response }, tokens: { input: 100, output: 20 }, cost_usd: null, started_at: iso(i), duration_ms: 10 });

// A Studio workflow run: Builder answered, the approval checkpoint is waiting, Deployer is next.
const workflowRecord = () => ({
	task_id: 'workflow-wf_1234abcd-v2',
	agent_id: 'workflow:wf_1234abcd',
	run_id: 'run-wf',
	status: 'RUNNING',
	total_steps: 3,
	completed_steps: 1,
	plan: [
		{ step_id: 'build', action: 'prompt', summary: 'Workflow goal: ship it' },
		{ step_id: 'gate', action: 'choice', summary: 'Approve deploy' },
		{ step_id: 'ship', action: 'prompt', summary: 'Deploy' },
	],
	results: [reply(0, 'build', 'Built the bundle.\nHand-off: deploy build 42 to staging')],
	history: [],
	started_at: iso(0),
	finished_at: null,
	awaiting: { step_index: 1, step_id: 'gate', question: 'Approve deploy: Builder finished.', options: ['Approve and continue', 'Stop the run here'], asked_at: iso(5), expires_at: iso(9e6) },
	choices: [],
});
const labels = new Map([['build', { label: 'Builder', kind: 'agent' }], ['gate', { label: 'Approve deploy', kind: 'human' }], ['ship', { label: 'Deployer', kind: 'agent' }]]);

describe('splitHandOff', () => {
	it('pulls the hand-off line out of a reply', () => {
		expect(splitHandOff('Did the work.\n\n**Hand-off:** Next, review it.')).toEqual({ body: 'Did the work.', handOff: 'Next, review it.' });
		expect(splitHandOff('Handoff: only this')).toEqual({ body: '', handOff: 'only this' });
		expect(splitHandOff('No hand-off here.')).toEqual({ body: 'No hand-off here.', handOff: '' });
	});
});

describe('buildThread', () => {
	it('shows agent turns, the waiting checkpoint as chips, and who is next', () => {
		const thread = buildThread(workflowRecord(), labels);
		expect(thread.map((t) => t.kind)).toEqual(['agent', 'choice', 'pending']);
		expect(thread[0]).toMatchObject({ name: 'Builder', colour: AGENT_COLOURS[0], body: 'Built the bundle.', handOff: 'deploy build 42 to staging', brief: 'Workflow goal: ship it' });
		expect(thread[1]).toMatchObject({ title: 'Approve deploy', waiting: true, options: ['Approve and continue', 'Stop the run here'] });
		expect(thread[2]).toMatchObject({ title: 'Deployer' });
	});

	it('gives each agent its own colour and records answers and the outcome', () => {
		const record = workflowRecord();
		record.awaiting = null;
		record.status = 'COMPLETED';
		record.completed_steps = 3;
		record.choices = [{ step_id: 'gate', question: 'Approve deploy: Builder finished.', option: 1, choice: 'Approve and continue', at: iso(6) }];
		record.results.push({ ...reply(1, 'gate', ''), action: 'choice', output: { option: 1, choice: 'Approve and continue' } }, reply(2, 'ship', 'Deployed.'));
		const thread = buildThread(record, labels);
		expect(thread.map((t) => t.kind)).toEqual(['agent', 'choice', 'agent', 'system']);
		expect(thread[2]).toMatchObject({ name: 'Deployer', colour: AGENT_COLOURS[1] });
		expect(thread[1]).toMatchObject({ waiting: false, chosen: { option: 1, choice: 'Approve and continue' }, stopped: false });
		expect(thread[3]).toMatchObject({ text: 'Run complete.', tone: 'ok' });
	});

	it('shows a typing turn while a step runs, and says where the operator stopped', () => {
		const running = workflowRecord();
		running.awaiting = null;
		running.completed_steps = 2;
		running.choices = [{ step_id: 'gate', question: 'q', option: 1, choice: 'Approve and continue', at: iso(6) }];
		expect(buildThread(running, labels).map((t) => t.kind)).toEqual(['agent', 'choice', 'typing']);

		const stopped = workflowRecord();
		stopped.awaiting = null;
		stopped.status = 'COMPLETED';
		stopped.completed_steps = 2;
		stopped.choices = [{ step_id: 'gate', question: 'q', option: 2, choice: 'Stop the run here', at: iso(6) }];
		stopped.stopped = { step_index: 1, step_id: 'gate', option: 2, choice: 'Stop the run here' };
		const thread = buildThread(stopped, labels);
		expect(thread.at(-1).text).toBe('You stopped the run at Approve deploy.');
		expect(thread[1].stopped).toBe(true);
	});
});

describe('agent dialogue view', () => {
	let container, view, engine;

	function createEngine(record) {
		return {
			posts: [],
			async fetch(url, init = {}) {
				const { pathname } = new URL(url);
				const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
				if (pathname === '/api/tasks') {
					return json(200, { tasks: [{ task_id: record.task_id, agent_id: record.agent_id, run_id: record.run_id, status: record.status, total_steps: 3, completed_steps: record.completed_steps, current_step: null, interrupted_step_index: null, total_tokens: { input: 0, output: 0 }, started_at: record.started_at, finished_at: null, ...(record.awaiting ? { awaiting: record.awaiting } : {}) }], counts: {} });
				}
				if (pathname === '/api/workflows/wf_1234abcd') return json(200, { workflow_id: 'wf_1234abcd', nodes: [...labels].map(([id, v]) => ({ id, ...v })), cables: [] });
				if (pathname.endsWith('/choice') && init.method === 'POST') {
					this.posts.push(JSON.parse(init.body).option);
					record.awaiting = null;
					record.choices.push({ step_id: 'gate', question: 'q', option: 1, choice: 'Approve and continue', at: iso(7) });
					record.completed_steps = 2;
					return json(200, { ok: true });
				}
				if (pathname.startsWith('/api/agents/')) return json(200, record);
				return json(404, { error: 'not found' });
			},
		};
	}

	beforeEach(() => {
		vi.useFakeTimers();
		container = document.createElement('div');
		document.body.append(container);
	});
	afterEach(() => {
		view && view.destroy();
		container.remove();
		vi.useRealTimers();
	});

	it('renders the thread with badges and answers a checkpoint from its chips', async () => {
		engine = createEngine(workflowRecord());
		const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch.bind(engine) });
		view = mountAgentDialogue(container, { api });
		await vi.advanceTimersByTimeAsync(0);
		expect([...container.querySelectorAll('.ad-name')].map((n) => n.textContent)).toEqual(['Builder']);
		expect(container.querySelector('.ad-badge').textContent).toBe('BU');
		expect(container.querySelector('.ad-handoff').textContent).toBe('Proposed hand-offdeploy build 42 to staging');
		expect(view.elements.status.textContent).toBe('Waiting for you');
		const chips = [...container.querySelectorAll('.ad-choice .oc-chip')];
		expect(chips.map((c) => c.textContent)).toEqual(['[1] Approve and continue', '[2] Stop the run here']);
		chips[0].click();
		await vi.advanceTimersByTimeAsync(0);
		expect(engine.posts).toEqual([1]);
		expect(container.querySelector('.ad-chosen').textContent).toBe('You chose [1] Approve and continue');
		expect(container.querySelector('.ad-typing .ad-name').textContent).toBe('Deployer');
	});
});
