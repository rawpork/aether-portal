import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// public/js/shell-keys.js: Alt+S goes to Space, Alt+M to Mission Control, never while typing or on the current surface.
describe('shell keyboard shortcuts', () => {
	let assign;

	beforeEach(async () => {
		vi.resetModules();
		assign = vi.fn();
		Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
		document.body.innerHTML = '<input id="field"><button id="btn">x</button>';
		document.body.dataset.shellSurface = 'mission-control';
		await import('../../public/js/shell-keys.js');
	});

	afterEach(() => {
		document.body.innerHTML = '';
	});

	const press = (target, init) => {
		const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, altKey: true, ...init });
		target.dispatchEvent(event);
		return event;
	};

	it('Alt+S from Mission Control goes to Space', () => {
		const event = press(document.getElementById('btn'), { code: 'KeyS' });
		expect(assign).toHaveBeenCalledWith('/');
		expect(event.defaultPrevented).toBe(true);
	});

	it('Alt+M does nothing on Mission Control itself, and goes there from Space', () => {
		press(document.getElementById('btn'), { code: 'KeyM' });
		expect(assign).not.toHaveBeenCalled();
		document.body.dataset.shellSurface = 'space';
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
