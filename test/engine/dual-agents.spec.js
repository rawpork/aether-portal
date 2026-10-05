// Quick-choice chips, the Claude ⇄ Gemini console and the Roadmap dashboard.
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { choiceReply, parseNumberedOptions, renderChoiceChips } from '../../public/js/engine/choice-chips.js';
import { backgroundItems, codeBlocks, fallbackNote, mountDualAgents, pastePayload, providerOf } from '../../public/js/engine/dual-agents.js';
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
		const view = mountDualAgents(container, { api: createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine }), pollMs: 100000 });
		cleanup.push(() => view.destroy());
		return { container, view, calls };
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
