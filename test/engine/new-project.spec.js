// The unified New project dialog: the pure spec builders each tab feeds, and the dialog's tabs and review step.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_TAGS, ROADMAP_TEMPLATES, roadmapById, roadmapToSpec } from '../../public/js/engine/roadmap-templates.js';
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
	const BP = { blueprint_id: 'bp_1', project_name: 'Bakery', execution_phases: [{ phase_id: 'p1', phase_name: 'Plan', agent_persona: 'Researcher', description: 'Read', task_steps: ['a'] }] };
	const makeApi = () => ({
		compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })),
		baseUrl: 'http://localhost:3333',
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
		document.querySelector('.np-next').click();
		await flush();
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

	it('launches a roadmap, and reports it to the index tagged template, ingest and roadmap', async () => {
		const api = { baseUrl: 'http://localhost:3333', compileBlueprint: vi.fn(async () => ({ blueprint_id: 'bp_1', blueprint: BP })), getEngineConfig: vi.fn(async () => ({ api_key_configured: true, key_verified: true })) };
		const onCompiled = vi.fn();
		project = mountNewProject(document, { api, pro: () => true, portalFetch: async () => new Response('{}'), onCompiled });
		project.open('roadmap');
		expect(document.querySelectorAll('[data-np-panel="roadmap"] .np-card').length).toBe(ROADMAP_TEMPLATES.length);
		document.querySelector('[data-np-panel="roadmap"] input[value="launch-30"]').click();
		document.querySelector('.np-next').click();
		await flush();
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
