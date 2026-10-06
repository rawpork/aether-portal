// Create / Templates: the template cards, the project brief asked before a run, and the spec it compiles.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { validateCompileRequest } from '../../public/js/engine/blueprint-spec.js';
import { mentionsWebsite } from '../../public/js/engine/blueprints.js';
import { AUTH_TYPES, BRIEF_SOURCE_URL, CATEGORIES, DATABASES, POPULAR_IDS, TEMPLATES, USAGE_KEY, briefSummary, briefToSpec, loadUsage, mountTemplates, normalizeDomain, popularTemplates, templateDefaults } from '../../public/js/engine/templates.js';

const settle = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let cleanup = [];
afterEach(() => {
	cleanup.forEach((fn) => fn());
	cleanup = [];
	document.body.replaceChildren();
});

describe('brief helpers', () => {
	it('normalizes a domain answer, and rejects what is not one', () => {
		expect(normalizeDomain(' https://WWW.Example.com/pricing?x=1 ')).toBe('www.example.com');
		expect(normalizeDomain('shop.example.co.uk.')).toBe('shop.example.co.uk');
		expect(normalizeDomain('localhost')).toBe('');
		expect(normalizeDomain('not a domain')).toBe('');
		expect(normalizeDomain('')).toBe('');
	});

	it('every template has a category, real links and defaults from the answer lists', () => {
		expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
		for (const t of TEMPLATES) {
			expect(CATEGORIES.map((c) => c.id)).toContain(t.category);
			expect(t.links.length).toBeGreaterThan(0);
			expect(t.links.every((l) => /^https:\/\//.test(l.url))).toBe(true);
			const defaults = templateDefaults(t);
			expect(AUTH_TYPES.map((a) => a.id)).toContain(defaults.auth);
			expect(DATABASES.map((d) => d.id)).toContain(defaults.database);
			expect(defaults.hosting).toMatch(/^cloudflare_/);
		}
		expect(TEMPLATES.filter((t) => t.skill).map((t) => t.name).sort()).toEqual(['3D Print & CAD Production Studio', 'AI Skill & Task Sandbox', 'Equipment & Asset Rental Portal', 'Resale & Listing Automation Suite']);
	});

	it('defaults come from the category, and a template overrides only what it sets', () => {
		const byId = (id) => TEMPLATES.find((t) => t.id === id);
		expect(templateDefaults(byId('equipment-rental'))).toEqual({ auth: 'magic_link', database: 'supabase_postgres', hosting: 'cloudflare_pages' });
		expect(templateDefaults(byId('resale-listing'))).toEqual({ auth: 'oauth', database: 'supabase_postgres', hosting: 'cloudflare_pages' });
		expect(templateDefaults(byId('skill-sandbox'))).toEqual({ auth: 'api_keys', database: 'cloudflare_d1', hosting: 'cloudflare_workers' });
		expect(templateDefaults(byId('api-webhooks')).database).toBe('cloudflare_kv');
		expect(briefToSpec(byId('equipment-rental'), { auth: 'magic_link' }).interviewResponses).toEqual({ database: 'supabase_postgres', hosting: 'cloudflare_pages', unresolvedConnectors: [] });
	});

	it('the shelf shows the recommended starters until others are used more', () => {
		expect(popularTemplates().map((t) => t.id)).toEqual(POPULAR_IDS);
		expect(popularTemplates({ 'print-cad-studio': 2, 'landing-waitlist': 1 }).map((t) => t.id)).toEqual(['print-cad-studio', 'landing-waitlist', 'saas-auditor']);
		expect(loadUsage({ getItem: () => '{bad' })).toEqual({});
		expect(loadUsage({ getItem: () => { throw new Error('blocked'); } })).toEqual({});
	});

	it('turns a template and its brief into a valid compile request', () => {
		const template = TEMPLATES.find((t) => t.id === 'saas-auditor');
		const brief = { projectName: ' Miserly ', domain: 'https://miserly.io/', auth: 'oauth', database: 'supabase_postgres', notes: 'Annual plans\n only.' };
		const spec = briefToSpec(template, brief);
		expect(validateCompileRequest(spec).errors).toEqual([]);
		expect(spec.projectName).toBe('Miserly');
		expect(spec.interviewResponses).toEqual({ database: 'supabase_postgres', hosting: 'cloudflare_workers', unresolvedConnectors: [] });
		const source = spec.links.at(-1);
		expect(source.url).toBe(BRIEF_SOURCE_URL);
		expect(source.rawSnippet).toBe(briefSummary(template, brief));
		expect(source.rawSnippet).toContain('Target domain: miserly.io (custom domain on Cloudflare after staging).');
		expect(source.rawSnippet).toContain('Sign-in: Google / GitHub sign-in.');
		expect(source.rawSnippet).toContain('Database: Supabase Postgres.');
		expect(source.rawSnippet).toContain('Also: Annual plans only.');
		// A website template pre-ticks "Deliver a live website" once compiled (scraped_summary is the snippet).
		expect(mentionsWebsite({ project_name: 'x', sources: [{ scraped_summary: source.rawSnippet }] })).toBe(true);
		expect(briefSummary(template, { auth: 'none', database: 'none' })).toContain('Target domain: none yet; launch on free staging first.');
	});
});

describe('Create / Templates view', () => {
	const mount = (overrides = {}) => {
		const calls = [];
		const compiled = [];
		const engine = async (url, init = {}) => {
			const { pathname } = new URL(url);
			const body = init.body ? JSON.parse(init.body) : null;
			calls.push({ pathname, body });
			if (overrides.compile) return overrides.compile(body);
			return json({ success: true, blueprint_id: 'bp_123', blueprint: { blueprint_id: 'bp_123', project_name: body.projectName }, logged: true }, 201);
		};
		const container = document.createElement('div');
		document.body.append(container);
		const saved = { ...(overrides.saved || {}) };
		const storage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; } };
		const view = mountTemplates(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine }), onCompiled: (...args) => compiled.push(args), onBlank: () => compiled.push(['blank']), storage });
		cleanup.push(() => view.destroy());
		return { container, view, calls, compiled, saved };
	};
	const brief = () => document.querySelector('.tp-brief');

	it('shows the Popular & Recommended shelf, then the other templates in collapsible categories', () => {
		const { container } = mount();
		const shelf = container.querySelector('.tp-shelf');
		expect(shelf.querySelector('.tp-section-title').textContent).toBe('🌟 Popular & Recommended');
		expect([...shelf.querySelectorAll('.tp-card')].map((c) => c.dataset.template)).toEqual(POPULAR_IDS);
		const groups = [...container.querySelectorAll('.tp-group')];
		expect(groups.map((g) => g.querySelector('summary span').textContent)).toEqual(['E-Commerce & Fleet Management', 'AI Skills & Workflow Automation', '3D & Hardware Pipelines', 'SaaS & Web Applications']);
		expect(groups.every((g) => g.open)).toBe(true);
		const inGroup = (i) => [...groups[i].querySelectorAll('.tp-card')].map((c) => c.dataset.template);
		expect(inGroup(0)).toEqual(['equipment-rental', 'resale-listing']);
		expect(inGroup(1)).toEqual(['api-webhooks', 'skill-sandbox']);
		expect(inGroup(2)).toEqual(['print-cad-studio']);
		expect(inGroup(3)).toEqual(['team-dashboard']);
		expect(groups[1].querySelector('.tp-count').textContent).toBe('2');
		// Every template appears exactly once; skill blueprints are marked.
		expect([...container.querySelectorAll('.tp-card')].map((c) => c.dataset.template).sort()).toEqual([...TEMPLATES.map((t) => t.id), 'blank'].sort());
		expect(container.querySelector('[data-template="skill-sandbox"] .tp-skill').textContent).toBe('Skill blueprint');
		expect(container.querySelector('[data-template="team-dashboard"] .tp-skill')).toBeNull();
	});

	it('a category template opens the brief with its category defaults and notes hint', () => {
		const { container } = mount();
		container.querySelector('[data-template="equipment-rental"]').click();
		expect(brief().querySelector('.dc-title').textContent).toBe('Project brief · Equipment & Asset Rental Portal');
		expect(brief().querySelector('.tp-brief-category').textContent).toMatch(/^E-Commerce & Fleet Management · /);
		expect(brief().querySelector('input[name="auth"]:checked').value).toBe('magic_link');
		expect(brief().querySelector('input[name="database"]:checked').value).toBe('supabase_postgres');
		expect(brief().querySelector('textarea[name="notes"]').getAttribute('placeholder')).toMatch(/rent/);
		brief().querySelector('.tp-cancel').click();
		container.querySelector('[data-template="print-cad-studio"]').click();
		expect(brief().querySelector('input[name="database"]:checked').value).toBe('cloudflare_d1');
		expect(brief().querySelector('textarea[name="notes"]').getAttribute('placeholder')).toMatch(/Printers and materials/);
	});

	it('the shelf follows what this browser uses, and open sections stay open', async () => {
		const { container, saved } = mount({ saved: { [USAGE_KEY]: JSON.stringify({ 'print-cad-studio': 2 }) } });
		expect([...container.querySelectorAll('.tp-shelf .tp-card')].map((c) => c.dataset.template)).toEqual(['print-cad-studio', 'saas-auditor', 'landing-waitlist']);
		// Its category is empty now, so it is not shown.
		expect(container.querySelector('.tp-group[data-category="hardware"]')).toBeNull();
		const ai = container.querySelector('.tp-group[data-category="ai"]');
		ai.open = false;
		ai.dispatchEvent(new Event('toggle'));
		container.querySelector('[data-template="team-dashboard"]').click();
		brief().querySelector('.tp-submit').click();
		await settle();
		expect(JSON.parse(saved[USAGE_KEY])).toEqual({ 'print-cad-studio': 2, 'team-dashboard': 1 });
		expect([...container.querySelectorAll('.tp-shelf .tp-card')].map((c) => c.dataset.template)).toEqual(['print-cad-studio', 'team-dashboard', 'saas-auditor']);
		expect(container.querySelector('.tp-group[data-category="ai"]').open).toBe(false);
		expect(container.querySelector('.tp-group[data-category="saas"] [data-template="landing-waitlist"]')).not.toBeNull();
	});

	it('a template opens the brief with its defaults', () => {
		const { container } = mount();
		container.querySelector('[data-template="team-dashboard"]').click();
		expect(brief().getAttribute('role')).toBe('dialog');
		expect(brief().querySelector('.dc-title').textContent).toBe('Project brief · Team dashboard');
		expect([...brief().querySelectorAll('legend, .tp-q-title')].map((n) => n.textContent)).toEqual(['Project name', '1. Which domain will it live on?', '2. How do people sign in?', '3. Where is the data kept?', '4. Anything Elarion must know? (optional)']);
		expect(brief().querySelector('input[name="auth"]:checked').value).toBe('oauth');
		expect(brief().querySelector('input[name="database"]:checked').value).toBe('supabase_postgres');
		expect(document.activeElement).toBe(brief().querySelector('input[name="domain"]'));
	});

	it('compiles the answered brief and hands the blueprint on', async () => {
		const { container, calls, compiled } = mount();
		container.querySelector('[data-template="saas-auditor"]').click();
		brief().querySelector('input[name="domain"]').value = 'miserly.io';
		brief().querySelector('input[name="auth"][value="magic_link"]').checked = true;
		brief().querySelector('input[name="database"][value="cloudflare_d1"]').checked = true;
		brief().querySelector('.tp-submit').click();
		await settle();
		const request = calls.find((c) => c.pathname === '/api/blueprint/compile').body;
		expect(request.interviewResponses.database).toBe('cloudflare_d1');
		expect(request.links.at(-1).rawSnippet).toContain('Target domain: miserly.io');
		expect(request.links.at(-1).rawSnippet).toContain('Sign-in: Email magic link.');
		expect(brief()).toBeNull();
		expect(compiled[0][0]).toBe('bp_123');
		expect(compiled[0][2].template.id).toBe('saas-auditor');
		expect(container.querySelector('.tp-status').textContent).toBe('Created bp_123 from SaaS cost auditor.');
	});

	it('will not send a domain that is not one, and keeps the brief open on an engine error', async () => {
		const { container, calls } = mount({ compile: () => json({ error: 'Engine says no.' }, 500) });
		container.querySelector('[data-template="landing-waitlist"]').click();
		const domain = brief().querySelector('input[name="domain"]');
		domain.value = 'my site';
		domain.dispatchEvent(new Event('input'));
		expect(brief().querySelector('#tp-domain-note').dataset.ok).toBe('no');
		brief().querySelector('.tp-submit').click();
		await settle();
		expect(calls).toHaveLength(0);
		domain.value = '';
		brief().querySelector('.tp-submit').click();
		await settle();
		expect(calls).toHaveLength(1);
		expect(brief().querySelector('.tp-error').textContent).toMatch(/Could not create the project: .*Engine says no/);
		expect(brief().querySelector('.tp-submit').disabled).toBe(false);
	});

	it('Cancel and Escape close the brief; Start from scratch goes to the editor', () => {
		const { container, compiled } = mount();
		const card = container.querySelector('[data-template="api-webhooks"]');
		card.click();
		brief().querySelector('.tp-cancel').click();
		expect(brief()).toBeNull();
		expect(document.activeElement).toBe(card);
		card.click();
		brief().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(brief()).toBeNull();
		container.querySelector('[data-template="blank"]').click();
		expect(compiled).toEqual([['blank']]);
	});
});
