// Quick-choice chips, the Claude ⇄ Gemini console and the Roadmap dashboard.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { choiceReply, decisionOptions, parseNumberedOptions, parseYesNo, renderChoiceChips } from '../../public/js/engine/choice-chips.js';
import { COPY_KEY, MAX_AUTO_HOPS, backgroundItems, codeBlocks, fallbackNote, loadCopySettings, mountDualAgents, pastePayload, providerOf, wrapRelay } from '../../public/js/engine/dual-agents.js';
import { ago, mountRoadmap, summarize } from '../../public/js/engine/roadmap.js';

const settle = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let cleanup = [];
afterEach(() => {
	cleanup.forEach((fn) => fn());
	cleanup = [];
});
const host = () => {
	const container = document.createElement('div');
	document.body.append(container);
	cleanup.push(() => container.remove());
	return container;
};

describe('parseNumberedOptions', () => {
	it('turns numbered options in a question into chips', () => {
		expect(parseNumberedOptions('Which database should we use?\n1. **Cloudflare D1** (edge SQLite)\n2. Supabase Postgres\n3) `Neon`')).toEqual([
			{ n: 1, label: 'Cloudflare D1 (edge SQLite)' },
			{ n: 2, label: 'Supabase Postgres' },
			{ n: 3, label: 'Neon' },
		]);
		expect(parseNumberedOptions('Options:\n[1] Ship now\n[2] Wait\n\nWhich do you prefer?').map(choiceReply)).toEqual(['1. Ship now', '2. Wait']);
		expect(parseNumberedOptions('Pick one:\n- 1. Red\n  (warm)\n- 2. Blue')).toEqual([{ n: 1, label: 'Red' }, { n: 2, label: 'Blue' }]);
	});

	it('ignores plain numbered steps, single options and broken numbering', () => {
		expect(parseNumberedOptions('Here is the plan.\n1. Install\n2. Configure\n3. Deploy')).toEqual([]);
		expect(parseNumberedOptions('Which one?\n1. Only option')).toEqual([]);
		expect(parseNumberedOptions('Which one?\n1. A\n3. C')).toEqual([]);
	});

	it('uses the last option list in the reply', () => {
		const text = 'Steps:\n1. a\n2. b\n\nNow, which hosting?\n1. Workers\n2. Pages';
		expect(parseNumberedOptions(text).map((o) => o.label)).toEqual(['Workers', 'Pages']);
	});
});

describe('decision gates', () => {
	it('a closing yes/no question becomes Yes / No chips that send the plain word', () => {
		expect(parseYesNo('Plan is ready.\nShould I add Stripe billing now?').map(choiceReply)).toEqual(['Yes', 'No']);
		expect(parseYesNo('Done. **Do you want** me to deploy it?')).toHaveLength(2);
		expect(parseYesNo('What should we call it?')).toEqual([]);
		expect(parseYesNo('Should I deploy?\nI will wait.')).toEqual([]);
	});

	it('numbered options win over yes/no; a reply that asks nothing has no gate', () => {
		expect(decisionOptions('Which one should I use?\n1. D1\n2. KV').map((o) => o.label)).toEqual(['D1', 'KV']);
		expect(decisionOptions('Shall we go with D1?').map((o) => o.label)).toEqual(['Yes', 'No']);
		expect(decisionOptions('Here is the schema.')).toEqual([]);
	});
});

describe('renderChoiceChips', () => {
	it('sends one choice, then disables the row; number keys pick too', () => {
		const picks = [];
		const row = renderChoiceChips(document, [{ n: 1, label: 'A' }, { n: 2, label: 'B' }], (o) => picks.push(o.n));
		expect([...row.querySelectorAll('.qc-chip')].map((c) => c.textContent)).toEqual(['1. A', '2. B']);
		row.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
		row.querySelector('[data-option="1"]').click();
		expect(picks).toEqual([2]);
		expect(row.querySelector('[data-option="2"]').classList.contains('chosen')).toBe(true);
		expect([...row.querySelectorAll('.qc-chip')].every((c) => c.disabled)).toBe(true);
	});
});

describe('dual-agent helpers', () => {
	it('pastes code blocks when there are any, else the whole text', () => {
		const text = 'Here:\n```ts\nconst a = 1;\n```\nand\n```sql\nSELECT 1;\n```';
		expect(codeBlocks(text)).toEqual(['```ts\nconst a = 1;\n```', '```sql\nSELECT 1;\n```']);
		expect(pastePayload(text)).toBe('```ts\nconst a = 1;\n```\n\n```sql\nSELECT 1;\n```');
		expect(pastePayload('  just words ')).toBe('just words');
	});

	it('routes models to feeds and collects background step outputs', () => {
		expect(providerOf('claude-opus-5-5', 'direct-anthropic')).toBe('claude');
		expect(providerOf('gemini-2.5-flash', 'direct-gemini')).toBe('gemini');
		expect(providerOf('miserly-free-sandbox', 'sandbox')).toBeNull();
		const items = backgroundItems([{ task_id: 't', run_id: 'r', results: [
			{ step_index: 1, step_id: 's2', started_at: '2', output: { response: 'B', model: 'gemini-2.5-flash' } },
			{ step_index: 0, step_id: 's1', started_at: '1', output: { response: 'A', model: 'claude-opus-5-5' } },
			{ step_index: 2, step_id: 'echo', output: { elarion_plan: {} } },
		] }]);
		expect(items.map((i) => [i.key, i.agent, i.title])).toEqual([['r:0', 'claude', 't · s1'], ['r:1', 'gemini', 't · s2']]);
	});
});

describe('inter-agent copy settings', () => {
	it('wraps what is passed on in the prefix and suffix', () => {
		expect(wrapRelay(' code ', { pre: 'Review:', post: ' Code only. ' })).toBe('Review:\n\ncode\n\nCode only.');
		expect(wrapRelay('code', { pre: '  ', post: '' })).toBe('code');
	});

	it('loads saved settings, falling back to Manual Copy', () => {
		const store = (value) => ({ getItem: () => value });
		expect(loadCopySettings(store(JSON.stringify({ mode: 'auto', pre: 'A', post: 'B' })))).toEqual({ mode: 'auto', pre: 'A', post: 'B' });
		expect(loadCopySettings(store('{bad'))).toEqual({ mode: 'manual', pre: '', post: '' });
		expect(loadCopySettings({ getItem: () => { throw new Error('blocked'); } })).toEqual({ mode: 'manual', pre: '', post: '' });
		expect(loadCopySettings(null)).toEqual({ mode: 'manual', pre: '', post: '' });
	});
});

describe('fallback notes', () => {
	it('explains in plain words why Claude stood in', () => {
		expect(fallbackNote('direct-anthropic (fallback: Google Gemini API (direct) returned an error (HTTP 503): This model is currently experiencing high demand.)', 'Gemini').text).toBe('Gemini was unavailable (it is overloaded right now), so Claude answered this one instead.');
		expect(fallbackNote('direct-anthropic (fallback: Google Gemini API (direct) returned an error (HTTP 429): You exceeded your current quota)', 'Gemini').reason).toMatch(/quota is used up/);
		expect(fallbackNote('direct-gemini', 'Gemini')).toBeNull();
		const [item] = backgroundItems([{ task_id: 't', run_id: 'r', results: [{ step_index: 0, step_id: 's', output: { response: 'x', model: 'claude-sonnet-5-5', tier: 'direct-anthropic (fallback: Google Gemini API (direct) returned an error (HTTP 503))' } }] }]);
		expect(item.agent).toBe('gemini');
	});
});

describe('Claude ⇄ Gemini console', () => {
	const mount = (overrides = {}) => {
		const calls = [];
		const engine = async (url, init = {}) => {
			const { pathname } = new URL(url);
			const body = init.body ? JSON.parse(init.body) : null;
			calls.push({ pathname, body });
			if (pathname === '/api/master-brain/chat') {
				if (overrides.chat) return overrides.chat(body);
				const claude = body.purpose === 'plan';
				return json({ session_id: body.session_id, response: claude ? 'Design:\n```js\nexport const x = 1;\n```\nWhich next?\n1. Build it\n2. Review it' : 'Extracted 3 facts.', tokens: { input: 10, output: 5 }, model: claude ? 'claude-opus-5-5' : 'gemini-2.5-flash', tier: claude ? 'direct-anthropic' : 'direct-gemini', status: 'ACTIVE' });
			}
			if (pathname === '/api/tasks') return json({ tasks: [{ task_id: 'deploy-1', agent_id: 'master-brain' }], counts: {} });
			return json({ task_id: 'deploy-1', run_id: 'r1', results: [{ step_index: 0, step_id: 'step-read', started_at: '1', output: { response: 'Read the docs.', model: 'gemini-2.5-flash' } }] });
		};
		const container = host();
		const saved = {};
		const storage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; } };
		const view = mountDualAgents(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine }), pollMs: 100000, storage });
		cleanup.push(() => view.destroy());
		return { container, view, calls, saved };
	};
	const pane = (container, id) => container.querySelector('.da-pane[data-agent="' + id + '"]');

	it('sends each pane with its own purpose and shows the model that answered', async () => {
		const { container, view, calls } = mount();
		await view.send('claude', 'Plan the API');
		await view.send('gemini', 'Read this page');
		const chats = calls.filter((c) => c.pathname === '/api/master-brain/chat').map((c) => [c.body.purpose, c.body.message]);
		expect(chats).toEqual([['plan', 'Plan the API'], ['step', 'Read this page']]);
		expect(calls[0].body.session_id).not.toBe(calls[1].body.session_id);
		expect(pane(container, 'claude').querySelector('.da-model').textContent).toBe('claude-opus-5-5');
		expect(pane(container, 'claude').querySelector('.da-code code').textContent).toBe('export const x = 1;');
		expect(pane(container, 'gemini').querySelector('.da-agent').textContent).toContain('Extracted 3 facts.');
	});

	it('Paste to Gemini puts Claude’s code into Gemini’s input', async () => {
		const { container, view } = mount();
		await view.send('claude', 'Plan the API');
		const gemini = pane(container, 'gemini').querySelector('.da-input');
		gemini.value = 'Check this:';
		pane(container, 'claude').querySelector('.da-paste').click();
		expect(pane(container, 'claude').querySelector('.da-paste').textContent).toBe('Paste to Gemini →');
		expect(gemini.value).toBe('Check this:\n\n```js\nexport const x = 1;\n```');
		expect(container.querySelector('.da-status').textContent).toMatch(/Pasted into Gemini/);
	});

	it('numbered options become chips that send the choice to the same agent', async () => {
		const { container, view, calls } = mount();
		await view.send('claude', 'Plan the API');
		const chips = [...pane(container, 'claude').querySelectorAll('.qc-chip')];
		expect(chips.map((c) => c.textContent)).toEqual(['1. Build it', '2. Review it']);
		chips[1].click();
		await settle();
		expect(calls.filter((c) => c.pathname === '/api/master-brain/chat').at(-1).body).toMatchObject({ purpose: 'plan', message: '2. Review it' });
	});

	it('Manual Copy is the default; the toggle and the wrappers are saved', () => {
		const { container, view, saved } = mount();
		const buttons = [...container.querySelectorAll('.da-seg-btn')];
		expect(buttons.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Manual Copy', 'true'], ['Auto-Send', 'false']]);
		buttons[1].click();
		expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
		expect(container.querySelector('.da-relay-hint').textContent).toMatch(/pausing at questions/);
		view.elements.pre.value = 'Review this:';
		view.elements.pre.dispatchEvent(new Event('input'));
		expect(JSON.parse(saved[COPY_KEY])).toEqual({ mode: 'auto', pre: 'Review this:', post: '' });
	});

	it('Paste wraps the payload in the prefix and suffix', async () => {
		const { container, view } = mount({ chat: () => json({ session_id: 's', response: 'Use D1.', tokens: { input: 1, output: 1 }, model: 'claude-opus-5-5', status: 'ACTIVE' }) });
		view.elements.pre.value = 'Check:';
		view.elements.pre.dispatchEvent(new Event('input'));
		view.elements.post.value = 'Be brief.';
		view.elements.post.dispatchEvent(new Event('input'));
		await view.send('claude', 'Plan');
		pane(container, 'claude').querySelector('.da-paste').click();
		expect(pane(container, 'gemini').querySelector('.da-input').value).toBe('Check:\n\nUse D1.\n\nBe brief.');
	});

	it('Auto-Send hands each reply to the other agent and stops at a question until you answer', async () => {
		let n = 0;
		const replies = ['Plan: a D1 table.', 'Read it. Should I add an index?', 'Index added.', 'Looks good. Shall I ship it?'];
		const { container, view, calls } = mount({ chat: (body) => json({ session_id: body.session_id, response: replies[n++] || 'ok', tokens: { input: 1, output: 1 }, model: body.purpose === 'plan' ? 'claude-opus-5-5' : 'gemini-2.5-flash', status: 'ACTIVE' }) });
		view.setMode('auto');
		view.elements.pre.value = 'From Claude:';
		view.elements.pre.dispatchEvent(new Event('input'));
		await view.send('claude', 'Design storage');
		const sent = () => calls.filter((c) => c.pathname === '/api/master-brain/chat').map((c) => [c.body.purpose, c.body.message]);
		expect(sent()).toEqual([['plan', 'Design storage'], ['step', 'From Claude:\n\nPlan: a D1 table.']]);
		expect(container.querySelector('.da-status').textContent).toBe('Auto-Send is waiting: Gemini asked a question. Pick an answer under its reply.');
		const chips = [...pane(container, 'gemini').querySelectorAll('.da-gate .qc-chip')];
		expect(chips.map((c) => c.textContent)).toEqual(['1. Yes', '2. No']);
		chips[0].click();
		await settle();
		expect(sent().slice(2)).toEqual([['step', 'Yes'], ['plan', 'From Claude:\n\nIndex added.']]);
	});

	it('Auto-Send pauses after the hand-off limit', async () => {
		const { container, view, calls } = mount({ chat: (body) => json({ session_id: body.session_id, response: 'Next part.', tokens: { input: 1, output: 1 }, model: 'claude-opus-5-5', status: 'ACTIVE' }) });
		view.setMode('auto');
		await view.send('claude', 'Go');
		expect(calls.filter((c) => c.pathname === '/api/master-brain/chat')).toHaveLength(1 + MAX_AUTO_HOPS);
		expect(container.querySelector('.da-status').textContent).toBe('Auto-Send paused after ' + MAX_AUTO_HOPS + ' hand-offs. Send a message to continue.');
		view.setMode('manual');
		await view.send('claude', 'Again');
		expect(calls.filter((c) => c.pathname === '/api/master-brain/chat')).toHaveLength(2 + MAX_AUTO_HOPS);
	});

	it('says when Claude stood in for an overloaded Gemini', async () => {
		const { container, view } = mount({ chat: () => json({ session_id: 's', response: 'Done.', tokens: { input: 1, output: 1 }, model: 'claude-sonnet-5-5', tier: 'direct-anthropic (fallback: Google Gemini API (direct) returned an error (HTTP 503): high demand)', status: 'ACTIVE' }) });
		await view.send('gemini', 'Summarise this');
		expect(pane(container, 'gemini').querySelector('.da-fallback').textContent).toBe('Gemini was unavailable (it is overloaded right now), so Claude answered this one instead.');
		expect(pane(container, 'gemini').querySelector('.da-model').textContent).toBe('claude-sonnet-5-5 (standing in)');
	});

	it('flags a reply routed to the other provider, and shows errors in the pane', async () => {
		const { container, view } = mount({ chat: (body) => (body.purpose === 'step' ? json({ session_id: 's', response: 'ok', tokens: { input: 1, output: 1 }, model: 'claude-opus-5-5', status: 'ACTIVE' }) : json({ error: 'boom' }, 500)) });
		await view.send('gemini', 'hi');
		expect(pane(container, 'gemini').querySelector('.da-model').dataset.mismatch).toBe('true');
		await view.send('claude', 'hi');
		expect(pane(container, 'claude').querySelector('.da-error').textContent).toMatch(/boom/);
	});

	it('adds background step outputs to the feed of the model that ran them, once', async () => {
		const { container, view } = mount();
		await view.refresh();
		await view.refresh();
		const runs = pane(container, 'gemini').querySelectorAll('.da-run');
		expect(runs).toHaveLength(1);
		expect(runs[0].querySelector('summary').textContent).toBe('Background · deploy-1 · step-read');
		expect(pane(container, 'gemini').querySelector('.da-paste').textContent).toBe('← Paste to Claude');
		expect(pane(container, 'claude').querySelector('.da-run')).toBeNull();
	});
});

describe('Roadmap dashboard', () => {
	const report = {
		roadmap: { file: 'ROADMAP.md', updated_at: '2026-10-05T00:00:00Z', title: 'Aether', phases: [
			{ title: 'Phase 3', level: 2, done: 2, total: 2, goals: [{ text: 'Client', detail: '', done: true, completed_on: '2026-10-01', depth: 0, children: { done: 0, total: 0 } }, { text: 'Breaker', detail: '', done: true, completed_on: null, depth: 0, children: { done: 0, total: 0 } }] },
			{ title: 'Phase 4', level: 2, done: 1, total: 4, goals: [{ text: 'Canvas', detail: '', done: false, completed_on: null, depth: 0, children: { done: 1, total: 2 } }, { text: 'Spacing', detail: '', done: false, completed_on: null, depth: 0, children: { done: 0, total: 0 } }] },
		] },
		roadmap_error: null,
		sessions: [{ id: 's1', project: 'Aether_Portal', title: 'Dual agents', started_at: null, last_active_at: '2026-10-05T00:55:00Z', size_kb: 2048, active: true }],
		memory: [{ title: 'Keep the dial simple', hook: 'no extra rings' }],
	};

	it('summarizes progress and the active goals', () => {
		const sum = summarize(report.roadmap);
		expect(sum).toMatchObject({ done: 3, total: 6, percent: 50, openPhases: 1 });
		expect(sum.active.map((g) => g.phase + ':' + g.text)).toEqual(['Phase 4:Canvas', 'Phase 4:Spacing']);
		expect(ago('2026-10-05T00:55:00Z', Date.parse('2026-10-05T01:00:00Z'))).toBe('5 min ago');
	});

	it('renders the overall bar, active goals, phases, sessions and memory', async () => {
		const container = host();
		const view = mountRoadmap(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async () => json(report) }), now: () => Date.parse('2026-10-05T01:00:00Z') });
		cleanup.push(() => view.destroy());
		await view.refresh();
		expect(container.querySelector('.rm-percent').textContent).toBe('50%');
		expect(container.querySelector('.rm-overall .rm-bar').getAttribute('aria-valuenow')).toBe('50');
		expect([...container.querySelectorAll('.rm-goal-text')].map((n) => n.textContent)).toEqual(['Canvas', 'Spacing']);
		expect(container.querySelector('.rm-goal-phase').textContent).toBe('Phase 4 · 1/2 sub-steps');
		expect([...container.querySelectorAll('.rm-phase-title')].map((n) => n.textContent)).toEqual(['Phase 3', 'Phase 4']);
		expect(container.querySelector('.rm-session-meta').textContent).toBe('active now · Aether_Portal · 5 min ago · 2.0 MB');
		expect(container.querySelector('.rm-memory').textContent).toBe('Keep the dial simple — no extra rings');
	});

	it('explains an engine without the roadmap route', async () => {
		const container = host();
		const view = mountRoadmap(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async () => json({ error: 'not found' }, 404) }) });
		cleanup.push(() => view.destroy());
		await view.refresh();
		expect(container.querySelector('.rm-error').textContent).toMatch(/no roadmap route yet/);
	});
});
