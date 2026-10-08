// Decision center: banner on every view, numbered choice popups, and the skill ingestion flow.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { bannerVisibleOn, mountDecisionCenter, skillCommandSource, snapshot, taskEvents } from '../../public/js/engine/decision-center.js';

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

describe('where the banner belongs', () => {
	const go = { kind: 'go', title: 'Start your first project', action: { label: 'Open Projects', view: 'blueprints' } };
	const live = { kind: 'live', title: 'A run is in progress', action: { label: 'Watch', view: 'activity' } };
	const keyWarn = { kind: 'warn', title: 'Add an AI model key', action: { label: 'Open Settings', view: 'connect' } };
	const alertOp = { kind: 'alert', title: 'Elarion is waiting', action: { label: 'Answer now', view: 'operator' } };

	it('always shows on the overview, when there is something to say', () => {
		for (const action of [go, live, keyWarn, alertOp]) expect(bannerVisibleOn(action, 'overview')).toBe(true);
		expect(bannerVisibleOn(null, 'overview')).toBe(false);
	});

	it('keeps suggestions and progress notes to the overview', () => {
		for (const view of ['studio', 'elaron', 'create', 'blueprints', 'roadmap', 'operator', 'monitor', 'connect']) {
			expect(bannerVisibleOn(go, view), 'go on ' + view).toBe(false);
			expect(bannerVisibleOn(live, view), 'live on ' + view).toBe(false);
		}
	});

	it('shows urgent blockers elsewhere, but not on the page they point to', () => {
		expect(bannerVisibleOn(keyWarn, 'blueprints')).toBe(true);
		expect(bannerVisibleOn(keyWarn, 'studio')).toBe(true);
		expect(bannerVisibleOn(keyWarn, 'connect')).toBe(false);
		expect(bannerVisibleOn(alertOp, 'monitor')).toBe(true);
		expect(bannerVisibleOn(alertOp, 'operator')).toBe(false);
		expect(bannerVisibleOn({ kind: 'warn', title: 'No button' }, 'studio')).toBe(false);
	});
});

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

	it('asks for the key, not a first project, while the engine has no key, and follows the view', async () => {
		let summary = { elarion_ready: false, miserly_key_status: 'missing', miserly_key_detail: 'No key' };
		slot = document.createElement('section');
		document.body.append(slot);
		const navigated = [];
		const engine = async (url) => (new URL(url).pathname === '/api/tasks' ? json({ tasks: [], counts: {} }) : json({ ok: true }));
		center = mountDecisionCenter(document, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine }), slot, pollMs: 100000, getSetup: () => summary, onNavigate: (v) => navigated.push(v), storage: { getItem: () => null, setItem() {} } });
		await settle();
		expect(slot.hidden).toBe(false);
		expect(slot.querySelector('.wf-next-title').textContent).toBe('Add an AI model key');
		expect(slot.textContent).not.toContain('Start your first project');
		slot.querySelector('.wf-next-go').click();
		expect(navigated).toEqual(['connect']);

		// On Settings the banner steps aside (the form is right there); on Projects the blocker still shows.
		center.setView('connect');
		expect(slot.hidden).toBe(true);
		center.setView('blueprints');
		expect(slot.hidden).toBe(false);
		expect(slot.querySelector('.wf-next-title').textContent).toBe('Add an AI model key');

		// Once the key is verified the banner turns into the first-project suggestion, which only belongs on the overview.
		summary = { elarion_ready: true, miserly_key_status: 'verified', miserly_key_detail: 'ok' };
		center.refreshBanner();
		expect(slot.hidden).toBe(true);
		center.setView('overview');
		expect(slot.hidden).toBe(false);
		expect(slot.querySelector('.wf-next-title').textContent).toBe('Start your first project');
	});

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
		expect(modal().querySelector('.dc-body').textContent).toContain('Deploy project');
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
		expect(modal().querySelector('.dc-body').textContent).toBe('Deploy project: HTTP 503: overloaded');
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

	it('+ Skill asks for a link or text, then learns from it', async () => {
		const { calls } = setup({ '/api/skills/ingest': () => json({ error: 'Only public http(s) addresses can be learned from.' }, 400) });
		await settle();
		const done = center.askSource();
		await settle();
		expect(modal().querySelector('.dc-title').textContent).toBe('Learn a skill');
		const field = modal().querySelector('textarea');
		expect(document.activeElement).toBe(field);
		// Typing a digit in the box types it; it does not pick an option.
		field.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
		expect(modal().querySelector('.dc-title').textContent).toBe('Learn a skill');
		field.value = 'http://localhost:3333';
		document.querySelector('.dc-option[data-option="1"]').click();
		await settle();
		expect(calls.find((c) => c.pathname === '/api/skills/ingest').body).toEqual({ source: 'http://localhost:3333' });
		expect(modal().querySelector('.dc-title').textContent).toBe('Could not learn from that');
		expect(modal().querySelector('.dc-body').textContent).toMatch(/Only public/);
		key('1');
		expect(await done).toBeNull();
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

describe('launch choice after a viable build', () => {
	const viableRecord = {
		results: [{ step_id: 'build', output: {
			build: { status: 'passed' },
			staging: { url: 'https://abc.aether-demo-019.pages.dev', alias: 'https://staging.aether-demo-019.pages.dev', project: 'aether-demo-019' },
			viability: { score: 91, viable: true, verdict: 'Ready to launch', checks: [], settings_needed: ['WEATHER_KEY'] },
		} }],
	};
	const mountWith = (record) => {
		const opened = [];
		const saved = new Map();
		const store = { getItem: (k) => (saved.has(k) ? saved.get(k) : null), setItem: (k, v) => saved.set(k, v) };
		let tasks = [task()];
		const engine = async (url) => {
			const { pathname } = new URL(url);
			if (pathname === '/api/tasks') return json({ tasks, counts: {} });
			if (pathname === '/api/engine/config') return json({ launch_links: [{ id: 'vercel', label: 'Vercel', url: 'https://vercel.com/new?ref=k', affiliate: true, what: 'Front ends' }, { id: 'netlify', label: 'Netlify', url: 'https://app.netlify.com/start', affiliate: false, what: 'Static' }] });
			if (pathname.startsWith('/api/agents/')) return json(record);
			return json({});
		};
		slot = document.createElement('section');
		document.body.append(slot);
		const realOpen = window.open;
		window.open = (url) => { opened.push(url); return null; };
		center = mountDecisionCenter(document, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine }), slot, pollMs: 100000, onNavigate: () => {}, storage: store });
		return {
			opened,
			saved,
			finish: async () => { tasks = [task({ status: 'COMPLETED', completed_steps: 4 })]; await center.poll(); await settle(); },
			restore: () => { window.open = realOpen; },
		};
	};

	it('asks where to launch, with the score, staging link and settings to set', async () => {
		const m = mountWith(viableRecord);
		await settle();
		await m.finish();
		expect(modal().querySelector('.dc-title').textContent).toBe('Where would you like to launch this live?');
		expect(modal().textContent).toContain('scored 91/100 (Ready to launch)');
		expect(modal().querySelector('a').getAttribute('href')).toBe('https://abc.aether-demo-019.pages.dev');
		expect(modal().querySelector('.dc-warn').textContent).toMatch(/set WEATHER_KEY/);
		expect(optionLabels()).toEqual(['Keep on Free Staging', 'Attach Custom Domain on Cloudflare (Free)', 'Deploy to Recommended Host', 'Decide later']);
		key('1');
		await settle();
		expect(modal().querySelector('.dc-title').textContent).toBe('Staying on free staging');
		key('1');
		await settle();
		expect(m.opened).toEqual(['https://abc.aether-demo-019.pages.dev']);
		expect(JSON.parse(m.saved.get('aether.projectRuns'))['deploy-bp_1'].launch).toBe('staging');
		m.restore();
	});

	it('custom domain explains the GoDaddy step and opens the Pages project in the dashboard', async () => {
		const m = mountWith(viableRecord);
		await settle();
		await m.finish();
		key('2');
		await settle();
		expect(modal().querySelector('.dc-title').textContent).toBe('Attach your own domain (free)');
		expect(modal().querySelector('.dc-steps').textContent).toMatch(/nameservers at GoDaddy/);
		key('1');
		await settle();
		expect(m.opened).toEqual(['https://dash.cloudflare.com/?to=/:account/pages/view/aether-demo-019/domains']);
		m.restore();
	});

	it('recommended hosts come from the engine, and affiliate links say so', async () => {
		const m = mountWith(viableRecord);
		await settle();
		await m.finish();
		key('3');
		await settle();
		expect(optionLabels()).toEqual(['Vercel (affiliate link)', 'Netlify', 'Back']);
		expect(modal().querySelector('.dc-body').textContent).toMatch(/referral fee at no cost to you/);
		key('1');
		await settle();
		expect(m.opened).toEqual(['https://vercel.com/new?ref=k']);
		expect(JSON.parse(m.saved.get('aether.projectRuns'))['deploy-bp_1'].launch).toBe('vercel');
		m.restore();
	});

	it('a run that did not score as viable gets the plain finished popup', async () => {
		const m = mountWith({ results: [{ step_id: 'build', output: { build: { status: 'failed' }, viability: { score: 20, viable: false, verdict: 'Not ready', checks: [], settings_needed: [] } } }] });
		await settle();
		await m.finish();
		expect(modal().querySelector('.dc-title').textContent).toBe('Project finished');
		m.restore();
	});
});
