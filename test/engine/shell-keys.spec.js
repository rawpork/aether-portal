// public/js/shell-keys.js and shell-surfaces.js: the shared switch, Alt+S / Alt+M, and the "Now in ..." arrival announcement.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACES, renderSurfaceSwitch } from '../../public/js/shell-surfaces.js';
import { announceArrival } from '../../public/js/shell-keys.js';

const assign = vi.fn();

beforeAll(() => {
	Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
});

const mountPage = (surface) => {
	document.body.innerHTML = renderSurfaceSwitch(surface) + '<input id="field"><button id="btn">x</button>';
	document.body.dataset.shellSurface = surface;
};

beforeEach(() => {
	assign.mockClear();
	sessionStorage.clear();
	vi.useFakeTimers();
	mountPage('mission-control');
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
	delete document.body.dataset.shellSurface;
});

const press = (target, init) => {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, altKey: true, ...init });
	target.dispatchEvent(event);
	return event;
};

describe('the shared switch', () => {
	it('lists both surfaces in the same order on both pages and marks only the current one', () => {
		for (const current of SURFACES.map((s) => s.id)) {
			mountPage(current);
			const items = [...document.querySelectorAll('.shell-switch .shell-item')];
			expect(items.map((a) => a.dataset.surface)).toEqual(['space', 'mission-control']);
			expect(items.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.dataset.surface)).toEqual([current]);
			expect(document.querySelector('nav.shell-switch').getAttribute('aria-label')).toBe('Aether');
		}
	});

	it('gives each item a name that contains its visible label, a shortcut and a tooltip that says so', () => {
		mountPage('space');
		const space = document.querySelector('[data-surface="space"]');
		const mission = document.querySelector('[data-surface="mission-control"]');
		expect(space.getAttribute('aria-label')).toBe('Space');
		expect(space.textContent).toBe('Space');
		expect(space.getAttribute('aria-keyshortcuts')).toBe('Alt+S');
		expect(space.getAttribute('href')).toBe('/');
		expect(mission.getAttribute('aria-label')).toBe('Mission Control');
		expect(mission.getAttribute('aria-keyshortcuts')).toBe('Alt+M');
		expect(mission.getAttribute('href')).toBe('/mission-control');
		expect(mission.title).toContain('(Alt+M)');
		expect(document.querySelectorAll('.shell-item svg[aria-hidden="true"]')).toHaveLength(2);
	});
});

describe('shell keyboard shortcuts', () => {
	it('Alt+S from Mission Control goes to Space', () => {
		const event = press(document.getElementById('btn'), { code: 'KeyS' });
		expect(assign).toHaveBeenCalledWith('/');
		expect(event.defaultPrevented).toBe(true);
	});

	it('Alt+M does nothing on Mission Control itself, and goes there from Space; Alt+S does nothing on Space', () => {
		press(document.getElementById('btn'), { code: 'KeyM' });
		expect(assign).not.toHaveBeenCalled();
		mountPage('space');
		press(document.getElementById('btn'), { code: 'KeyS' });
		expect(assign).not.toHaveBeenCalled();
		press(document.getElementById('btn'), { code: 'KeyM' });
		expect(assign).toHaveBeenCalledWith('/mission-control');
	});

	it('stays quiet while typing, with extra modifiers, and on key repeat', () => {
		press(document.getElementById('field'), { code: 'KeyS' });
		press(document.getElementById('btn'), { code: 'KeyS', ctrlKey: true });
		press(document.getElementById('btn'), { code: 'KeyS', shiftKey: true });
		press(document.getElementById('btn'), { code: 'KeyS', repeat: true });
		press(document.getElementById('btn'), { code: 'KeyS', altKey: false });
		expect(assign).not.toHaveBeenCalled();
	});
});

describe('arrival announcement', () => {
	it('a shortcut remembers where it is going, and the next page says Now in <surface> once', async () => {
		press(document.getElementById('btn'), { code: 'KeyS' });
		expect(sessionStorage.getItem('aether.shell.arrived')).toBe('space');

		// The next page loads on Space.
		mountPage('space');
		announceArrival();
		await vi.advanceTimersByTimeAsync(100);
		const region = document.getElementById('shell-live');
		expect(region.getAttribute('role')).toBe('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(region.textContent).toBe('Now in Space');
		expect(sessionStorage.getItem('aether.shell.arrived')).toBe(null);

		// A reload says nothing.
		region.remove();
		announceArrival();
		await vi.advanceTimersByTimeAsync(100);
		expect(document.getElementById('shell-live')).toBe(null);
	});

	it('clicking the other surface in the switch is announced the same way, in the other direction', async () => {
		mountPage('space');
		document.querySelector('[data-surface="mission-control"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(sessionStorage.getItem('aether.shell.arrived')).toBe('mission-control');
		mountPage('mission-control');
		announceArrival();
		await vi.advanceTimersByTimeAsync(100);
		expect(document.getElementById('shell-live').textContent).toBe('Now in Mission Control');
	});

	it('clicking the current surface announces nothing, and a move that did not land is not announced', async () => {
		document.querySelector('[data-surface="mission-control"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(sessionStorage.getItem('aether.shell.arrived')).toBe(null);
		sessionStorage.setItem('aether.shell.arrived', 'space');
		announceArrival();
		await vi.advanceTimersByTimeAsync(100);
		expect(document.getElementById('shell-live')).toBe(null);
	});
});
