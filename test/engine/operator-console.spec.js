// Operator Console against the real client bundle, with a simulated engine: activity log and choice chips.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { mountOperatorConsole, outputSnippet, recordLines } from '../../public/js/engine/operator-console.js';

const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const waitingRecord = () => ({
	task_id: 'deploy-1',
	agent_id: 'shipper',
	run_id: 'run-1',
	status: 'RUNNING',
	total_steps: 2,
	completed_steps: 0,
	results: [],
	history: [
		{ at: iso(0), event: 'STARTED', detail: '2 step(s)' },
		{ at: iso(10), event: 'STEP_STARTED', step_index: 0, step_id: 'ask' },
	],
	started_at: iso(0),
	finished_at: null,
	awaiting: { step_index: 0, step_id: 'ask', question: 'Which deploy target?', options: ['Staging', 'Production', 'Skip'], asked_at: iso(20), expires_at: iso(1_800_020) },
	choices: [],
});

function createEngine() {
	const engine = {
		records: new Map(),
		posts: [],
		failChoice: null,
		add(record) {
			engine.records.set(record.agent_id + '/' + record.task_id, record);
		},
		async fetch(url, init = {}) {
			const { pathname } = new URL(url);
			const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
			if (pathname === '/api/tasks') {
				const tasks = [...engine.records.values()].map((r) => ({
					task_id: r.task_id, agent_id: r.agent_id, run_id: r.run_id, status: r.status, total_steps: r.total_steps,
					completed_steps: r.completed_steps, current_step: null, interrupted_step_index: null, total_tokens: { input: 0, output: 0 },
					started_at: r.started_at, finished_at: r.finished_at, ...(r.awaiting ? { awaiting: r.awaiting } : {}),
				}));
				return reply(200, { tasks, counts: {} });
			}
			const choice = /^\/api\/agents\/([^/]+)\/tasks\/([^/]+)\/choice$/.exec(pathname);
			if (choice && init.method === 'POST') {
				const body = JSON.parse(init.body);
				engine.posts.push({ agent: decodeURIComponent(choice[1]), task: decodeURIComponent(choice[2]), option: body.option });
				if (engine.failChoice) return reply(engine.failChoice, { error: 'This task is not waiting for a choice.' });
				const record = engine.records.get(decodeURIComponent(choice[1]) + '/' + decodeURIComponent(choice[2]));
				const made = { step_id: 'ask', question: record.awaiting.question, option: body.option, choice: record.awaiting.options[body.option - 1], at: iso(5000) };
				record.choices.push(made);
				record.results.push({ step_index: 0, step_id: 'ask', action: 'choice', status: 'COMPLETED', output: { option: body.option, choice: made.choice }, tokens: { input: 0, output: 0 }, cost_usd: null, started_at: iso(10), duration_ms: 4990 });
				record.history.push({ at: iso(5000), event: 'STEP_COMPLETED', step_index: 0, step_id: 'ask' });
				record.awaiting = null;
				return reply(200, { ok: true, task_id: record.task_id, agent_id: record.agent_id, option: body.option });
			}
			const match = /^\/api\/agents\/([^/]+)\/tasks\/([^/]+)$/.exec(pathname);
			if (match) {
				const record = engine.records.get(decodeURIComponent(match[1]) + '/' + decodeURIComponent(match[2]));
				return record ? reply(200, record) : reply(404, { error: 'No task run found.' });
			}
			return reply(404, { error: 'not found' });
		},
	};
	return engine;
}

let engine, consoleView, container, statusEl, waiting;

function mount() {
	container = document.createElement('div');
	statusEl = document.createElement('span');
	document.body.append(container, statusEl);
	const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch });
	consoleView = mountOperatorConsole(container, { api, statusEl, now: () => T0 + 60_000, onWaitingChange: (n) => { waiting = n; } });
	return consoleView;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const logTexts = () => [...container.querySelectorAll('.oc-line .oc-text')].map((n) => n.textContent);
const chips = () => [...container.querySelectorAll('.oc-chip')];

beforeEach(() => {
	vi.useFakeTimers();
	engine = createEngine();
	waiting = null;
});

afterEach(() => {
	consoleView && consoleView.destroy();
	container && container.remove();
	statusEl && statusEl.remove();
	consoleView = null;
	vi.useRealTimers();
});

describe('recordLines and outputSnippet', () => {
	it('turns a run into ordered log lines, with its question and answers', () => {
		const record = waitingRecord();
		record.choices = [{ step_id: 'ask', question: 'Which deploy target?', option: 2, choice: 'Production', at: iso(30) }];
		expect(recordLines(record).map((l) => l.kind + ': ' + l.text)).toEqual([
			'start: shipper / deploy-1 started · 2 step(s)',
			'step: shipper / deploy-1 · step 1 (ask) running',
			'ask: shipper / deploy-1 asks: Which deploy target?',
			'answer: You chose [2] Production for shipper / deploy-1',
		]);
	});

	it('summarises step outputs in one line', () => {
		expect(outputSnippet({ response: '  Plan:\n  ship it  ' })).toBe('Plan: ship it');
		expect(outputSnippet({ option: 1, choice: 'Staging' })).toBe('chose [1] Staging');
		expect(outputSnippet({ ok: true })).toBe('{"ok":true}');
		expect(outputSnippet(null)).toBe('');
		expect(outputSnippet({ response: 'x'.repeat(400) }).length).toBe(160);
	});
});

describe('operator console', () => {
	it('shows empty states with no runs', async () => {
		mount();
		await flush();
		expect(consoleView.elements.logEmpty.hidden).toBe(false);
		expect(consoleView.elements.promptsEmpty.hidden).toBe(false);
		expect(waiting).toBe(0);
		expect(statusEl.textContent).toBe('Up to date');
	});

	it('renders a waiting question as numbered chips and logs the run', async () => {
		engine.add(waitingRecord());
		mount();
		await flush();
		expect(container.querySelector('.oc-prompt-question').textContent).toBe('Which deploy target?');
		expect(chips().map((c) => c.textContent)).toEqual(['[1] Staging', '[2] Production', '[3] Skip']);
		expect(waiting).toBe(1);
		expect(consoleView.elements.promptCount.textContent).toBe('1');
		expect(logTexts()).toContain('shipper / deploy-1 asks: Which deploy target?');
		expect(statusEl.textContent).toBe('Live');
	});

	it('sends the tapped option to the engine and logs the answer', async () => {
		engine.add(waitingRecord());
		mount();
		await flush();
		chips()[1].click();
		expect(chips().every((c) => c.disabled)).toBe(true);
		await flush();
		expect(engine.posts).toEqual([{ agent: 'shipper', task: 'deploy-1', option: 2 }]);
		await vi.advanceTimersByTimeAsync(700);
		expect(container.querySelectorAll('.oc-prompt').length).toBe(0);
		expect(waiting).toBe(0);
		expect(logTexts()).toContain('You chose [2] Production for shipper / deploy-1');
		expect(logTexts()).toContain('shipper / deploy-1 · step 1 (ask) done: chose [2] Production');
	});

	it('answers with a number key while the pane has focus', async () => {
		engine.add(waitingRecord());
		mount();
		await flush();
		consoleView.elements.prompts.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
		await flush();
		expect(engine.posts.map((p) => p.option)).toEqual([3]);
	});

	it('keeps the chips and says why when the engine refuses the answer', async () => {
		engine.add(waitingRecord());
		engine.failChoice = 409;
		mount();
		await flush();
		chips()[0].click();
		await flush();
		expect(chips().every((c) => !c.disabled)).toBe(true);
		expect(container.querySelector('.oc-prompt-message').textContent).toBe('Could not send the choice: This task is not waiting for a choice.');
	});

	it('appends only new lines on later polls', async () => {
		const record = waitingRecord();
		engine.add(record);
		mount();
		await flush();
		const before = logTexts().length;
		await vi.advanceTimersByTimeAsync(2100);
		expect(logTexts().length).toBe(before);
		record.history.push({ at: iso(40), event: 'HALTED', step_index: 0, step_id: 'ask', detail: 'Operator manual trip' });
		record.status = 'HALTED';
		record.finished_at = iso(40);
		record.awaiting = null;
		await vi.advanceTimersByTimeAsync(2100);
		expect(logTexts().at(-1)).toBe('shipper / deploy-1 halted at step 1 (ask): Operator manual trip');
		expect(container.querySelectorAll('.oc-prompt').length).toBe(0);
	});
});
