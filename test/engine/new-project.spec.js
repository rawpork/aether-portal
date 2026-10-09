// The unified New project dialog: the pure spec builders each tab feeds, and the dialog's tabs and review step.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_CATEGORIES, ROADMAP_TAGS, ROADMAP_TEMPLATES, roadmapById, roadmapToSpec, roadmapsIn } from '../../public/js/engine/roadmap-templates.js';
import { TABS, cardsToSpec, goalToSpec, linksToSpec, mountNewProject, nameFromGoal, parseLinks } from '../../public/js/engine/new-project.js';

describe('new project spec builders', () => {
	it('offers five ways in, in order', () => {
		expect(TABS.map((t) => t.label)).toEqual(['Pick Template', 'Roadmap Templates', 'Select Space Cards', 'Describe Goal', 'Paste Links']);
	});

	it('turns a described goal into a spec with the goal as its one source', () => {
		const spec = goalToSpec({ goal: 'Build a landing page for my bakery with a waitlist form' });
		expect(spec.projectName).toBe(nameFromGoal('Build a landing page for my bakery with a waitlist form'));
		expect(spec.links).toHaveLength(1);
		expect(spec.links[0].rawSnippet).toContain('landing page for my bakery');
		expect(goalToSpec({ name: 'Bakery', goal: 'x'.repeat(30) }).projectName).toBe('Bakery');
	});

	it('reads pasted links, dropping duplicates and anything that is not http(s)', () => {
		const { links, invalid } = parseLinks('https://a.test/x, https://a.test/x\nftp://b.test  nonsense https://www.c.test');
		expect(links.map((l) => l.title)).toEqual(['a.test', 'c.test']);
		expect(invalid).toEqual(['ftp://b.test', 'nonsense']);
		expect(linksToSpec({ links }).projectName).toBe('Project from a.test');
	});

	it('packages Space cards: link cards as their link, notes as their /node page', () => {
		const spec = cardsToSpec([{ id: 'n1', title: 'A link', url: 'https://x.test' }, { id: 'n 2', title: 'A note', description: 'hello' }], { origin: 'https://p.test' });
		expect(spec.links.map((l) => l.url)).toEqual(['https://x.test', 'https://p.test/node/n%202']);
		expect(spec.projectName).toBe('A link');
		expect(cardsToSpec(Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: 't' + i }))).links).toHaveLength(13);
	});
});

describe('New project dialog', () => {
	let project;
	afterEach(() => {
		if (project) project.destroy();
		project = null;
		document.body.replaceChildren();
	});
	const type = (field, value) => {
		const node = document.querySelector('[data-field="' + field + '"]');
		node.value = value;
		node.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
	// The guided steps (template, roadmap, goal): inputs -> About the project -> Elarion's questions -> review.
	const clickNext = async () => { document.querySelector('.np-next').click(); await flush(); };
	const guide = async () => { await clickNext(); await clickNext(); await clickNext(); };
	const BP = { blueprint_id: 'bp_1', project_name: 'Bakery', execution_phases: [{ phase_id: 'p1', phase_name: 'Plan', agent_persona: 'Researcher', description: 'Read', task_steps: ['a'] }] };
	const makeApi = () => ({
		compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })),
		baseUrl: 'http://localhost:3333',
		analyzeIntake: vi.fn(async () => ({ target: null, summary: 'No page to check: Elarion plans from your goal and your answers.', questions: [{ id: 'criteria', question: 'How should the result be judged?', why: 'It becomes the pass mark.', kind: 'choice', options: ['Sign-ups or sales', 'Speed and accessibility'] }] })),
		getEngineConfig: vi.fn(async () => ({ api_key_configured: true, key_verified: true, direct_mode: true })),
	});

	it('opens on Pick Template, switches tabs, and does not compile Describe Goal until it has a real goal', async () => {
		const api = makeApi();
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}') });
		project.open();
		const tabs = [...document.querySelectorAll('.np-modal [role="tab"]')];
		expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
		tabs[3].click();
		expect(document.querySelector('[data-np-panel="goal"]').hidden).toBe(false);
		expect(document.querySelector('[data-np-panel="template"]').hidden).toBe(true);
		document.querySelector('.np-next').click();
		await flush();
		expect(api.compileBlueprint).not.toHaveBeenCalled();
		expect(document.querySelector('.np-error').hidden).toBe(false);
	});

	it('reviews a described goal, and a free account is sent to the upgrade instead of running', async () => {
		const api = makeApi();
		const onUpgrade = vi.fn();
		const onRun = vi.fn();
		project = mountNewProject(document, { api, pro: () => false, portalFetch: async () => new Response('{}'), onUpgrade, onRun });
		project.open('goal');
		type('goal', 'Research the best bakery waitlist tools and summarise them');
		await guide();
		expect(api.compileBlueprint).toHaveBeenCalledTimes(1);
		expect(document.querySelector('.np-project').textContent).toBe('Bakery');
		expect(document.querySelector('.np-plan li').textContent).toContain('Plan');
		const approve = document.querySelector('.np-next');
		expect(approve.textContent).toBe('Approve & Run (Pro)');
		approve.click();
		await flush();
		expect(onUpgrade).toHaveBeenCalledTimes(1);
		expect(onRun).not.toHaveBeenCalled();
	});

	it('a Pro account approves and runs, and the dialog closes', async () => {
		const api = makeApi();
		const onRun = vi.fn(async () => {});
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}'), onRun });
		project.open('links');
		type('links', 'https://a.test/page');
		document.querySelector('.np-next').click();
		await flush();
		const approve = document.querySelector('.np-next');
		expect(approve.textContent).toBe('Approve & Run');
		expect(approve.disabled).toBe(false);
		approve.click();
		await flush();
		expect(onRun).toHaveBeenCalledTimes(1);
		expect(onRun.mock.calls[0][0]).toEqual(BP);
		expect(document.querySelector('.np-modal')).toBeNull();
	});
});

describe('Roadmap Templates tab', () => {
	let project;
	afterEach(() => { if (project) project.destroy(); project = null; document.body.replaceChildren(); });
	const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
	const clickNext = async () => { document.querySelector('.np-next').click(); await flush(); };
	const guide = async () => { await clickNext(); await clickNext(); await clickNext(); };
	const BP = { blueprint_id: 'bp_1', project_name: '30-day product launch', execution_phases: [{ phase_id: 'p1', phase_name: 'Position', agent_persona: 'Researcher', description: 'Define', task_steps: ['a'] }] };

	it('lists the ready-made roadmaps, and builds a spec whose one source is the roadmap written out', () => {
		expect(ROADMAP_TEMPLATES.length).toBeGreaterThanOrEqual(5);
		const template = roadmapById('launch-30');
		const spec = roadmapToSpec(template, { notes: 'for my bakery' });
		expect(spec.projectName).toBe('30-day product launch');
		expect(spec.links).toHaveLength(1);
		expect(spec.links[0].rawSnippet).toContain('Week 1: Position');
		expect(spec.links[0].rawSnippet).toContain('for my bakery');
		expect(roadmapToSpec(template, { name: 'Bakery launch' }).projectName).toBe('Bakery launch');
		expect(ROADMAP_TAGS).toEqual(['template', 'ingest', 'roadmap']);
	});

	it('sorts the roadmaps into category tabs, and the 1-day audit and affiliate campaign are there', () => {
		expect(ROADMAP_CATEGORIES.map((c) => c.id)).toEqual(['all', 'rapid', 'affiliate', 'marketing', 'seo', 'app', 'ops']);
		expect(roadmapsIn('all')).toHaveLength(ROADMAP_TEMPLATES.length);
		expect(roadmapsIn('rapid').map((t) => t.id)).toEqual(['local-audit-1d', 'affiliate-brainiac-1d', 'sales-crm-1d', 'finance-ledger-1d', 'onboarding-sop-1d']);
		expect(roadmapsIn('ops').map((t) => t.id)).toEqual(['sales-crm-1d', 'finance-ledger-1d', 'onboarding-sop-1d']);
		expect(roadmapsIn('affiliate').map((t) => t.id)).toContain('affiliate-brainiac-1d');
		for (const c of ROADMAP_CATEGORIES.slice(1)) expect(roadmapsIn(c.id).length).toBeGreaterThan(0);
		for (const t of ROADMAP_TEMPLATES) expect(t.categories.length).toBeGreaterThan(0);
		expect(roadmapToSpec(roadmapById('local-audit-1d')).links[0].rawSnippet).toContain('audit report');
	});

	it('the wizard filters the roadmap cards by category tab', () => {
		const api = { baseUrl: 'http://localhost:3333', getEngineConfig: vi.fn(async () => ({ api_key_configured: true })) };
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}'), onCompiled: vi.fn() });
		project.open('roadmap');
		document.querySelector('[data-np-panel="roadmap"] [data-category="rapid"]').click();
		const ids = [...document.querySelectorAll('[data-np-panel="roadmap"] .np-card input')].map((i) => i.value);
		expect(ids).toEqual(['local-audit-1d', 'affiliate-brainiac-1d', 'sales-crm-1d', 'finance-ledger-1d', 'onboarding-sop-1d']);
		expect(document.querySelector('[data-np-panel="roadmap"] [data-category="rapid"]').getAttribute('aria-pressed')).toBe('true');
		document.querySelector('[data-np-panel="roadmap"] [data-category="all"]').click();
		expect(document.querySelectorAll('[data-np-panel="roadmap"] .np-card').length).toBe(ROADMAP_TEMPLATES.length);
	});

	it('launches a roadmap, and reports it to the index tagged template, ingest and roadmap', async () => {
		const api = { baseUrl: 'http://localhost:3333', analyzeIntake: vi.fn(async () => ({ target: null, summary: '', questions: [] })), compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })), getEngineConfig: vi.fn(async () => ({ api_key_configured: true, key_verified: true })) };
		const onCompiled = vi.fn();
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}'), onCompiled });
		project.open('roadmap');
		expect(document.querySelectorAll('[data-np-panel="roadmap"] .np-card').length).toBe(ROADMAP_TEMPLATES.length);
		document.querySelector('[data-np-panel="roadmap"] input[value="launch-30"]').click();
		await guide();
		expect(api.compileBlueprint).toHaveBeenCalledTimes(1);
		expect(api.compileBlueprint.mock.calls[0][0].links[0].rawSnippet).toContain('Week 4: Learn');
		expect(onCompiled.mock.calls[0][2].tags).toEqual(['ingest', 'template', 'roadmap']);
		expect(document.querySelector('.np-project').textContent).toBe('30-day product launch');
	});

	it('a plain goal is tagged ingest only, a template adds template', async () => {
		const api = { baseUrl: 'http://localhost:3333', compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })), getEngineConfig: vi.fn(async () => ({ api_key_configured: true })) };
		const onCompiled = vi.fn();
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}'), onCompiled });
		project.open('links');
		const links = document.querySelector('[data-field="links"]');
		links.value = 'https://a.test/page';
		links.dispatchEvent(new Event('input', { bubbles: true }));
		document.querySelector('.np-next').click();
		await flush();
		expect(onCompiled.mock.calls[0][2].tags).toEqual(['ingest']);
	});
});

describe('the project map in the review', () => {
	let project;
	afterEach(() => { if (project) project.destroy(); project = null; document.body.replaceChildren(); });
	const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
	const BP = { blueprint_id: 'bp_1', project_name: 'Bakery', execution_phases: [{ phase_id: 'p1', phase_name: 'Plan', agent_persona: 'Researcher', description: 'Read', task_steps: ['a'] }] };
	const startLinks = async (api, extra) => {
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}'), ...extra });
		project.open('links');
		const links = document.querySelector('[data-field="links"]');
		links.value = 'https://a.test/page';
		links.dispatchEvent(new Event('input', { bubbles: true }));
		document.querySelector('.np-next').click();
		await flush();
	};

	it('says the plan is already a map in the Studio and opens it from the review', async () => {
		const api = { baseUrl: 'http://localhost:3333', compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', workflow_id: 'wf_abc12345', blueprint: BP })), getEngineConfig: vi.fn(async () => ({ api_key_configured: true })) };
		const onOpenStudio = vi.fn();
		await startLinks(api, { onOpenStudio });
		expect(document.querySelector('.np-map-row').textContent).toContain('drawn this plan as a map of agents in the Studio');
		document.querySelector('.np-map').click();
		expect(onOpenStudio).toHaveBeenCalledWith('wf_abc12345');
		expect(document.querySelector('.np-modal')).toBeNull();
	});

	it('shows no map line when the engine made none', async () => {
		const api = { baseUrl: 'http://localhost:3333', compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })), getEngineConfig: vi.fn(async () => ({ api_key_configured: true })) };
		await startLinks(api, { onOpenStudio: vi.fn() });
		expect(document.querySelector('.np-map-row')).toBeNull();
	});
});

describe('Guided intake', () => {
	let project;
	afterEach(() => { if (project) project.destroy(); project = null; document.body.replaceChildren(); });
	const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
	const clickNext = async () => { document.querySelector('.np-next').click(); await flush(); };
	const BP = { blueprint_id: 'bp_1', project_name: 'Landing page + waitlist', execution_phases: [{ phase_id: 'p1', phase_name: 'Build the website', agent_persona: 'Developer', description: 'Build', task_steps: ['a'] }] };
	const ANALYSIS = {
		target: { url: 'https://shop.example.com', checked: true, status: 200, score: 62, grade: 'C', findings: [
			{ id: 'title', label: 'Page title', points: 0, max: 10, detail: 'There is no <title>.' },
			{ id: 'h1', label: 'Exactly one H1 heading', points: 10, max: 10, detail: '1 H1 heading found.' },
			{ id: 'canonical', label: 'Canonical link', points: 0, max: 5, detail: 'There is no canonical link.' },
		] },
		summary: 'Checked https://shop.example.com against the on-page benchmark: 62 out of 100 (grade C).',
		questions: [
			{ id: 'region', question: 'Which region or market is this for?', why: 'Language and currency follow it.', kind: 'text' },
			{ id: 'pricing', question: 'Which pricing tiers should it launch with?', why: 'The plan builds exactly these.', kind: 'choice', options: ['Free only', 'Free, Mid and Pro'] },
			{ id: 'bundle', question: 'Which features should come bundled with the paid tier?', why: 'Each one has to be built.', kind: 'text' },
		],
	};
	const makeApi = (analysis = ANALYSIS) => ({
		baseUrl: 'http://localhost:3333',
		analyzeIntake: vi.fn(async () => analysis),
		compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })),
		getEngineConfig: vi.fn(async () => ({ api_key_configured: true, key_verified: true, direct_mode: true })),
	});
	const setField = (selector, value) => { const node = document.querySelector(selector); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };

	it('a template asks for target, region and deliverables, checks the page, asks Elarion\'s questions, then compiles with the answers', async () => {
		const api = makeApi();
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}') });
		project.open('template');
		expect(document.querySelector('.np-next').textContent).toBe('Next');
		await clickNext();
		expect(document.querySelector('.np-title').textContent).toBe('About the project');
		expect([...document.querySelectorAll('[data-deliverable]')].filter((b) => b.checked).map((b) => b.value)).toEqual(['website', 'plan']);
		setField('[data-field="intakeTarget"]', 'shop.example.com');
		setField('[data-field="intakeRegion"]', 'Portugal');
		document.querySelector('[data-deliverable="pricing"]').click();
		await clickNext();
		expect(api.analyzeIntake).toHaveBeenCalledTimes(1);
		const request = api.analyzeIntake.mock.calls[0][0];
		expect(request.url).toBe('https://shop.example.com');
		expect(request.region).toBe('Portugal');
		expect(request.deliverables).toEqual(['A live website', 'Written plan and playbook', 'Pricing and checkout setup']);
		expect(request.template.name).toBeTruthy();
		// The page check and the questions.
		expect(document.querySelector('.np-title').textContent).toBe('Elarion has questions');
		expect(document.querySelector('.np-score-number').textContent).toBe('62/100');
		expect(document.querySelector('.np-score').dataset.grade).toBe('C');
		expect([...document.querySelectorAll('.np-finding strong')].map((n) => n.textContent)).toEqual(['Page title', 'Canonical link']);
		expect(document.querySelectorAll('.np-q').length).toBe(3);
		document.querySelector('[data-answer="pricing"][value="Free, Mid and Pro"]').click();
		setField('[data-answer="bundle"]', 'Automated cron monitoring');
		await clickNext();
		// Compiled with all of it folded into the brief; the website was asked for, so it is ticked on the review.
		expect(api.compileBlueprint).toHaveBeenCalledTimes(1);
		const snippet = api.compileBlueprint.mock.calls[0][0].links.find((l) => l.url === 'aether:brief').rawSnippet;
		expect(snippet).toContain('Guided intake.');
		expect(snippet).toContain('Target: shop.example.com');
		expect(snippet).toContain('Region: Portugal');
		expect(snippet).toContain('Pricing and checkout setup');
		expect(snippet).toContain('Page check: 62/100, grade C');
		expect(snippet).toContain('Which pricing tiers should it launch with? Free, Mid and Pro');
		expect(snippet).toContain('Automated cron monitoring');
		expect(document.querySelector('.np-title').textContent).toBe('Ready to run?');
		expect(document.querySelector('.bp-website-box').checked).toBe(true);
	});

	it('Back walks the steps in reverse and keeps what was typed', async () => {
		project = mountNewProject(document, { api: makeApi(), pro: () => true, portalFetch: async () => new Response('{}') });
		project.open('goal');
		const goal = document.querySelector('[data-field="goal"]');
		goal.value = 'Research the best bakery waitlist tools and summarise them';
		goal.dispatchEvent(new Event('input', { bubbles: true }));
		await clickNext();
		setField('[data-field="intakeRegion"]', 'Spain');
		await clickNext();
		document.querySelector('.np-back').click();
		expect(document.querySelector('.np-title').textContent).toBe('About the project');
		expect(document.querySelector('[data-field="intakeRegion"]').value).toBe('Spain');
		document.querySelector('.np-back').click();
		expect(document.querySelector('.np-title').textContent).toBe('New project');
		expect(document.querySelector('[data-field="goal"]').value).toContain('bakery waitlist');
	});

	it('a business name with no web address is not fetched, and a failed check still lets the plan go on', async () => {
		const api = makeApi();
		api.analyzeIntake = vi.fn(async () => { throw new Error('404'); });
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}') });
		project.open('roadmap');
		await clickNext();
		setField('[data-field="intakeTarget"]', 'Maria\'s bakery');
		await clickNext();
		expect(api.analyzeIntake.mock.calls[0][0].url).toBe('');
		expect(document.querySelector('.np-title').textContent).toBe('Elarion has questions');
		expect(document.querySelectorAll('.np-q').length).toBe(1);
		await clickNext();
		expect(api.compileBlueprint).toHaveBeenCalledTimes(1);
	});

	it('an engine that answers without questions is treated as having no check', async () => {
		const api = makeApi();
		api.analyzeIntake = vi.fn(async () => ({}));
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}') });
		project.open('goal');
		const goal = document.querySelector('[data-field="goal"]');
		goal.value = 'Research the best bakery waitlist tools and summarise them';
		goal.dispatchEvent(new Event('input', { bubbles: true }));
		await clickNext();
		await clickNext();
		expect(document.querySelectorAll('.np-q').length).toBe(1);
	});

	it('needs at least one deliverable, and Paste Links goes straight to the plan without the intake', async () => {
		const api = makeApi();
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}') });
		project.open('template');
		await clickNext();
		for (const box of document.querySelectorAll('[data-deliverable]')) if (box.checked) box.click();
		await clickNext();
		expect(document.querySelector('.np-error').hidden).toBe(false);
		expect(api.analyzeIntake).not.toHaveBeenCalled();
		project.close();
		project.open('links');
		expect(document.querySelector('.np-next').textContent).toBe('Review plan');
		setField('[data-field="links"]', 'https://a.test/page');
		await clickNext();
		expect(api.analyzeIntake).not.toHaveBeenCalled();
		expect(api.compileBlueprint).toHaveBeenCalledTimes(1);
	});
});
