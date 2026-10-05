// Decision center: banner on every view, numbered choice popups, and the skill ingestion flow.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { mountDecisionCenter, skillCommandSource, snapshot, taskEvents } from '../../public/js/engine/decision-center.js';

const settle = async (n = 10) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const modal = () => document.querySelector('.dc-modal');
const optionLabels = () => [...document.querySelectorAll('.dc-option-label')].map((n) => n.textContent);

let center;
let slot;
afterEach(() => {
	center && center.destroy();
	slot && slot.remove();
	document.querySelectorAll('.dc-scrim').forEach((n) => n.remove());
	center = slot = null;
});

const task = (over) => ({ task_id: 'deploy-bp_1', agent_id: 'master-brain', run_id: 'r1', status: 'RUNNING', completed_steps: 1, total_steps: 4, started_at: 't', finished_at: null, ...over });

describe('helpers', () => {
	it('reads skill commands', () => {
		expect(skillCommandSource('add repo https://github.com/a/b')).toBe('https://github.com/a/b');
		expect(skillCommandSource('Add Skill  Always sign requests')).toBe('Always sign requests');
		expect(skillCommandSource('learn https://docs.test')).toBe('https://docs.test');
		expect(skillCommandSource('add a card about repos')).toBeNull();
		expect(skillCommandSource('what is a repo?')).toBeNull();
	});

	it('pops up only for changes seen while the page is open', () => {
		const running = task();
		expect(taskEvents(null, [task({ status: 'COMPLETED' })])).toEqual([]);
		const prev = snapshot([running]);
		expect(taskEvents(prev, [task({ status: 'COMPLETED' })]).map((e) => e.type)).toEqual(['completed']);
		expect(taskEvents(prev, [task({ status: 'FAILED' })]).map((e) => e.type)).toEqual(['failed']);
		expect(taskEvents(prev, [task({ awaiting: { step_index: 2, question: 'Ship?', options: ['Yes', 'No'] } })]).map((e) => e.type)).toEqual(['choice']);
		expect(taskEvents(snapshot([task({ awaiting: { step_index: 2 } })]), [task({ awaiting: { step_index: 2 } })])).toEqual([]);
		// A new run that started and finished between two polls still counts; other tasks are ignored.
		expect(taskEvents(snapshot([task({ status: 'COMPLETED', run_id: 'r0' })]), [task({ status: 'COMPLETED', run_id: 'r2' })]).map((e) => e.type)).toEqual(['completed']);
		expect(taskEvents(snapshot([task({ task_id: 'chat-1' })]), [task({ task_id: 'chat-1', status: 'COMPLETED' })])).toEqual([]);
	});
});

describe('mountDecisionCenter', () => {
	const setup = (handlers = {}) => {
		const calls = [];
		let tasks = handlers.tasks || [];
		const engine = async (url, init = {}) => {
			const { pathname } = new URL(url);
			const body = init.body ? JSON.parse(init.body) : null;
			calls.push({ pathname, body });
			if (pathname === '/api/tasks') return json({ tasks: typeof tasks === 'function' ? tasks() : tasks, counts: {} });
			if (handlers[pathname]) return handlers[pathname](body);
			return json({ ok: true });
		};
		slot = document.createElement('section');
		document.body.append(slot);
		const navigated = [];
		center = mountDecisionCenter(document, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine }), slot, pollMs: 100000, onNavigate: (v) => navigated.push(v), storage: { getItem: () => null } });
		return { calls, navigated, setTasks: (t) => { tasks = t; } };
	};

	it('shows the Do this next banner and its button navigates', async () => {
		const { navigated } = setup({ tasks: [] });
		await settle();
		expect(slot.hidden).toBe(false);
		expect(slot.querySelector('.wf-next-title').textContent).toBe('Start your first project');
		slot.querySelector('.wf-next-go').click();
		expect(navigated).toEqual(['blueprints']);
	});

	it('asks Elarion’s question as numbered choices and answers it on the engine with a number key', async () => {
		const { calls, setTasks } = setup({ tasks: [task()] });
		await settle();
		setTasks([task({ awaiting: { step_index: 1, question: 'Which hosting?', options: ['Workers', 'Pages'] } })]);
		await center.poll();
		await settle();
		expect(modal().querySelector('.dc-title').textContent).toBe('Elarion needs your decision');
		expect(optionLabels()).toEqual(['Workers', 'Pages', 'Decide later']);
		expect(modal().getAttribute('aria-modal')).toBe('true');
		key('2');
		await settle();
		expect(calls.at(-1)).toEqual({ pathname: '/api/agents/master-brain/tasks/deploy-bp_1/choice', body: { option: 2 } });
		expect(modal()).toBeNull();
	});

	it('offers next steps when a run finishes, and Esc closes', async () => {
		const { navigated, setTasks } = setup({ tasks: [task()] });
		await settle();
		setTasks([task({ status: 'COMPLETED', completed_steps: 4 })]);
		await center.poll();
		await settle();
		expect(modal().querySelector('.dc-title').textContent).toBe('Project finished');
		expect(optionLabels()).toEqual(['See deliverables', 'Watch what each step wrote', 'Start another project', 'Stay here']);
		document.querySelector('.dc-option[data-option="1"]').click();
		await settle();
		expect(navigated).toEqual(['blueprints']);

		setTasks([task({ run_id: 'r2' })]);
		await center.poll();
		setTasks([task({ run_id: 'r2', status: 'FAILED' })]);
		await center.poll();
		await settle();
		expect(modal().querySelector('.dc-body').textContent).toContain('deploy-bp_1');
		key('Escape');
		expect(modal()).toBeNull();
	});

	it('a failed run names the reason from the engine', async () => {
		const { setTasks } = setup({ tasks: [task()], '/api/agents/master-brain/tasks/deploy-bp_1': () => json({ failure: { step_index: 2, error: 'HTTP 503: overloaded' } }) });
		await settle();
		setTasks([task({ status: 'FAILED' })]);
		await center.poll();
		await settle();
		expect(modal().querySelector('.dc-title').textContent).toBe('A project run failed');
		expect(modal().querySelector('.dc-body').textContent).toBe('deploy-bp_1: HTTP 503: overloaded');
	});

	it('learn: reads the source, shows the SKILL.md draft, edits it and saves it', async () => {
		const draft = { slug: 'widget-client', name: 'widget-client', description: 'Use the widget client.', markdown: '---\nname: widget-client\n---\n# widget-client', source: { kind: 'github', url: 'https://github.com/acme/widgets', title: 'acme/widgets' } };
		const { calls } = setup({
			'/api/skills/ingest': (body) => json({ draft: { ...draft, source: { ...draft.source, url: body.source } }, exists: false }),
			'/api/skills/save': () => json({ saved: true, slug: 'widget-client', file: 'skills/widget-client/SKILL.md' }),
		});
		await settle();
		const done = center.learn('https://github.com/acme/widgets');
		expect(document.querySelector('.dc-modal[aria-busy="true"]')).not.toBeNull();
		await settle();
		expect(calls.find((c) => c.pathname === '/api/skills/ingest').body).toEqual({ source: 'https://github.com/acme/widgets' });
		expect(modal().querySelector('.dc-title').textContent).toBe('New skill: widget-client');
		expect(modal().querySelector('.dc-preview').textContent).toBe(draft.markdown);
		expect(optionLabels()).toEqual(['Save skill', 'Edit first', 'Discard']);

		key('2');
		await settle();
		const area = modal().querySelector('textarea');
		expect(area.value).toBe(draft.markdown);
		area.value = draft.markdown + '\nEdited.';
		document.querySelector('.dc-option[data-option="1"]').click();
		await settle();
		expect(modal().querySelector('.dc-preview').textContent).toMatch(/Edited\.$/);
		key('1');
		await settle();
		expect(calls.find((c) => c.pathname === '/api/skills/save').body).toEqual({ slug: 'widget-client', markdown: draft.markdown + '\nEdited.', replace: false });
		expect(modal().querySelector('.dc-title').textContent).toBe('Skill saved');
		expect(modal().querySelector('.dc-body').textContent).toMatch(/Aether_Engine\/skills\/widget-client\/SKILL\.md/);
		key('1');
		expect(await done).toMatchObject({ saved: true });
	});

	it('learn: an existing skill is offered as a replacement, and errors are explained', async () => {
		const { calls } = setup({
			'/api/skills/ingest': () => json({ draft: { slug: 'docs', name: 'docs', description: 'd', markdown: 'm', source: { kind: 'text', url: null, title: 't' } }, exists: true }),
			'/api/skills/save': () => json({ error: 'A skill named docs already exists.' }, 409),
		});
		await settle();
		const done = center.learn('Always sign requests with HMAC.');
		await settle();
		expect(optionLabels()[0]).toBe('Replace the saved skill');
		expect(modal().querySelector('.dc-warn').textContent).toMatch(/already exists/);
		key('1');
		await settle();
		expect(calls.find((c) => c.pathname === '/api/skills/save').body.replace).toBe(true);
		expect(modal().querySelector('.dc-title').textContent).toBe('Could not save the skill');
		key('2');
		expect(await done).toBeNull();
	});
});
