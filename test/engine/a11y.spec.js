// public/js/a11y.js (focus trap, live announcer) and where Mission Control uses them: the phone drawer and the stop dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, focusableWithin, trapFocus } from '../../public/js/a11y.js';
import { setupMenuTray } from '../../public/js/engine/mission-control.js';

const tab = (shiftKey = false) => {
	const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
	document.activeElement.dispatchEvent(event);
	return event;
};

afterEach(() => {
	document.body.replaceChildren();
	document.body.className = '';
	delete document.body.dataset.rail;
});

describe('trapFocus', () => {
	let opener, first, middle, last, outside;

	beforeEach(() => {
		document.body.innerHTML = '<button id="opener">open</button><div id="panel"><button id="first">a</button><input id="middle"><button id="last">z</button>'
			+ '<button id="off" disabled>x</button><button id="skip" tabindex="-1">y</button><div hidden><button id="gone">g</button></div></div><button id="outside">out</button>';
		[opener, first, middle, last, outside] = ['opener', 'first', 'middle', 'last', 'outside'].map((id) => document.getElementById(id));
	});

	it('lists only the controls Tab can reach', () => {
		expect(focusableWithin(document.getElementById('panel')).map((e) => e.id)).toEqual(['first', 'middle', 'last']);
	});

	it('wraps Tab from the last control to the first, and Shift+Tab from the first to the last', () => {
		opener.focus();
		const trap = trapFocus(document.getElementById('panel'));
		last.focus();
		expect(tab().defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		expect(tab(true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
		middle.focus();
		expect(tab().defaultPrevented).toBe(false);
		trap.release({ restore: false });
	});

	it('pulls focus back in when it is somewhere outside the panel', () => {
		const trap = trapFocus(document.getElementById('panel'));
		outside.focus();
		expect(tab().defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		trap.release({ restore: false });
	});

	it('gives focus back to what opened the panel, or leaves it where it is, and stops trapping once released', () => {
		opener.focus();
		const trap = trapFocus(document.getElementById('panel'));
		first.focus();
		trap.release();
		expect(document.activeElement).toBe(opener);
		last.focus();
		expect(tab().defaultPrevented).toBe(false);

		opener.focus();
		const again = trapFocus(document.getElementById('panel'), { returnTo: outside });
		again.release();
		expect(document.activeElement).toBe(outside);
		const quiet = trapFocus(document.getElementById('panel'));
		first.focus();
		quiet.release({ restore: false });
		expect(document.activeElement).toBe(first);
	});
});

describe('announce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		document.getElementById('aether-live')?.remove();
	});
	afterEach(() => vi.useRealTimers());

	it('speaks in one polite status region, and only the last of a quick run of changes', async () => {
		announce('Time range: Today, 2 cards');
		announce('Time range: This week, 31 cards');
		const region = document.getElementById('aether-live');
		expect(region.getAttribute('role')).toBe('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(region.textContent).toBe('');
		await vi.advanceTimersByTimeAsync(250);
		expect(region.textContent).toBe('Time range: This week, 31 cards');
		expect(document.querySelectorAll('#aether-live')).toHaveLength(1);
	});

	it('says the same words again when they are repeated, and ignores empty text', async () => {
		announce('Board view');
		await vi.advanceTimersByTimeAsync(250);
		announce('Board view');
		const region = document.getElementById('aether-live');
		expect(region.textContent).toBe('');
		await vi.advanceTimersByTimeAsync(250);
		expect(region.textContent).toBe('Board view');
		announce('');
		await vi.advanceTimersByTimeAsync(250);
		expect(region.textContent).toBe('Board view');
	});
});

describe('Mission Control phone drawer', () => {
	const page = () => {
		document.body.innerHTML = '<button id="mc-menu-toggle" aria-expanded="false"></button><button id="mc-scrim" hidden></button>'
			+ '<aside id="mc-rail"><button class="rail-item" id="a"></button><button class="rail-item" id="b"></button></aside><button id="behind">behind</button>';
	};
	const win = (phone) => ({ matchMedia: (q) => ({ matches: phone && q === '(max-width: 680px)', addEventListener: vi.fn() }) });
	const storage = { getItem: () => null, setItem() {} };

	it('is unreachable while closed on a phone, reachable and trapped while open, and unreachable again after', () => {
		page();
		setupMenuTray(document, { win: win(true), storage });
		const rail = document.getElementById('mc-rail');
		const toggle = document.getElementById('mc-menu-toggle');
		expect(rail.hasAttribute('inert')).toBe(true);
		toggle.click();
		expect(rail.hasAttribute('inert')).toBe(false);
		expect(document.activeElement.id).toBe('a');
		// Tab from the last item goes back to the first, not on to the page behind the scrim.
		document.getElementById('b').focus();
		expect(tab().defaultPrevented).toBe(true);
		expect(document.activeElement.id).toBe('a');
		toggle.click();
		expect(rail.hasAttribute('inert')).toBe(true);
		expect(document.activeElement).toBe(toggle);
		// The trap is gone: Tab from the toggle is not intercepted.
		expect(tab().defaultPrevented).toBe(false);
	});

	it('never makes the desktop rail inert', () => {
		page();
		setupMenuTray(document, { win: win(false), storage });
		expect(document.getElementById('mc-rail').hasAttribute('inert')).toBe(false);
		document.getElementById('mc-menu-toggle').click();
		expect(document.getElementById('mc-rail').hasAttribute('inert')).toBe(false);
	});
});
