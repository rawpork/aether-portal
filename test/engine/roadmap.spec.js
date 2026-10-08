// Roadmap view: goals written in markdown become named, safe links instead of raw "[label](path)" text.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LINK_BASE, mountRoadmap, parseMarkdownLinks, plainText, resolveLink } from '../../public/js/engine/roadmap.js';

const SPEC = 'Step 4.1: 2D Visual Node Canvas ([spec 01](specs/ui/01-node-canvas.md))';

describe('parseMarkdownLinks', () => {
	it('splits text into plain pieces and links, in order', () => {
		expect(parseMarkdownLinks(SPEC)).toEqual([
			{ text: 'Step 4.1: 2D Visual Node Canvas (' },
			{ text: 'spec 01', href: 'specs/ui/01-node-canvas.md' },
			{ text: ')' },
		]);
		expect(parseMarkdownLinks('a [one](x.md) b [two](https://e.test/y) c').map((p) => p.text)).toEqual(['a ', 'one', ' b ', 'two', ' c']);
	});

	it('leaves text without links, and malformed links, exactly as written', () => {
		expect(parseMarkdownLinks('Plain goal')).toEqual([{ text: 'Plain goal' }]);
		expect(parseMarkdownLinks('Broken [label](with space) here')).toEqual([{ text: 'Broken [label](with space) here' }]);
		expect(parseMarkdownLinks('')).toEqual([]);
		expect(parseMarkdownLinks(null)).toEqual([]);
	});

	it('gives the readable sentence without the link syntax, for labels', () => {
		expect(plainText(SPEC)).toBe('Step 4.1: 2D Visual Node Canvas (spec 01)');
	});
});

describe('resolveLink', () => {
	it('opens web addresses as they are and repo paths under the base, and nothing else', () => {
		expect(resolveLink('https://example.test/a')).toBe('https://example.test/a');
		expect(resolveLink('specs/ui/01-node-canvas.md')).toBe(DEFAULT_LINK_BASE + 'specs/ui/01-node-canvas.md');
		expect(resolveLink('./README.md', 'https://repo.test/blob/main/')).toBe('https://repo.test/blob/main/README.md');
		expect(resolveLink('javascript:alert(1)')).toBe(null);
		expect(resolveLink('mailto:a@b.test')).toBe(null);
		expect(resolveLink('//evil.test/x')).toBe(null);
		expect(resolveLink('/etc/passwd')).toBe(null);
		expect(resolveLink('specs/a.md', '')).toBe(null);
	});
});

describe('roadmap cards', () => {
	let roadmap;
	let host;
	afterEach(() => {
		roadmap && roadmap.destroy && roadmap.destroy();
		host && host.remove();
	});

	const report = {
		roadmap: {
			file: 'ROADMAP.md',
			phases: [{ title: 'Phase 4', done: 1, total: 3, goals: [
				{ text: SPEC, done: false, children: { done: 2, total: 3 } },
				{ text: 'Read the [docs](https://docs.test/start) first', done: false, children: { done: 0, total: 0 } },
				{ text: 'Mail [me](mailto:a@b.test) or [script](javascript:void)', done: true, completed_on: '2026-10-03', children: { done: 0, total: 0 } },
			] }],
		},
		sessions: [],
		memory: [],
	};

	async function mount(options = {}) {
		host = document.createElement('div');
		document.body.append(host);
		roadmap = mountRoadmap(host, { api: { getRoadmap: async () => report }, ...options });
		await roadmap.refresh();
	}

	it('shows each markdown link as a named link that opens safely in a new tab, with no raw syntax on screen', async () => {
		await mount();
		const links = [...host.querySelectorAll('.rm-goals a.rm-link')];
		expect(links.map((a) => a.textContent)).toEqual(['spec 01', 'docs']);
		const spec = links[0];
		expect(spec.getAttribute('href')).toBe(DEFAULT_LINK_BASE + 'specs/ui/01-node-canvas.md');
		expect(spec.getAttribute('target')).toBe('_blank');
		expect(spec.getAttribute('rel')).toBe('noopener noreferrer');
		expect(spec.getAttribute('aria-label')).toBe('spec 01, file specs/ui/01-node-canvas.md (opens in a new tab)');
		expect(links[1].getAttribute('aria-label')).toBe('docs (opens in a new tab)');
		expect(host.textContent).not.toMatch(/\]\(|\[spec|specs\/ui\/01-node-canvas\.md\)\)/);
		expect(host.querySelector('.rm-goal-text').textContent).toBe('Step 4.1: 2D Visual Node Canvas (spec 01)');
	});

	it('names the sub-step progress bar in plain words and keeps unsafe targets as plain labels', async () => {
		await mount();
		expect(host.querySelector('.rm-goal [role="progressbar"]').getAttribute('aria-label')).toBe('Step 4.1: 2D Visual Node Canvas (spec 01) sub-steps');
		const phaseGoals = host.querySelector('.rm-phase-goals').textContent;
		expect(phaseGoals).toContain('Mail me or script · 2026-10-03');
		expect(host.querySelector('.rm-phase-goals a[href^="mailto"]')).toBe(null);
		expect(host.querySelector('.rm-phase-goals a[href^="javascript"]')).toBe(null);
	});

	it('shows file links as plain labels when no link base is set', async () => {
		await mount({ linkBase: '' });
		expect([...host.querySelectorAll('.rm-goals a.rm-link')].map((a) => a.textContent)).toEqual(['docs']);
		expect(host.querySelector('.rm-goal-text').textContent).toContain('spec 01');
	});
});
