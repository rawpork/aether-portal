import { afterEach, expect, it } from 'vitest';
import { setupElarionDrawer } from '../../public/js/engine/elarion-drawer.js';

afterEach(() => document.body.replaceChildren());

function page() {
	document.body.innerHTML = '<button id="opener">Ask</button><button id="mc-drawer-scrim" hidden></button><aside id="mc-drawer"><button id="mc-drawer-close">x</button><textarea id="box"></textarea></aside>';
	return setupElarionDrawer(document, { focusTarget: () => document.getElementById('box') });
}

it('starts closed and unreachable, opens with focus in the message box, and closes on Escape or the close button', () => {
	const drawer = page();
	const el = document.getElementById('mc-drawer');
	expect(drawer.isOpen()).toBe(false);
	expect(el.hasAttribute('inert')).toBe(true);
	expect(el.getAttribute('aria-hidden')).toBe('true');
	document.getElementById('opener').focus();
	drawer.open();
	expect(drawer.isOpen()).toBe(true);
	expect(el.hasAttribute('inert')).toBe(false);
	expect(document.body.classList.contains('drawer-open')).toBe(true);
	expect(document.activeElement).toBe(document.getElementById('box'));
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	expect(drawer.isOpen()).toBe(false);
	expect(document.body.classList.contains('drawer-open')).toBe(false);
	expect(document.activeElement).toBe(document.getElementById('opener'));
	drawer.open();
	document.getElementById('mc-drawer-close').click();
	expect(drawer.isOpen()).toBe(false);
});

it('tells the caller it is closing before focus returns to the opener', () => {
	document.body.innerHTML = '<button id="opener"></button><aside id="mc-drawer"><textarea id="box"></textarea></aside>';
	const order = [];
	const opener = document.getElementById('opener');
	opener.addEventListener('focus', () => order.push('focus'));
	const drawer = setupElarionDrawer(document, { focusTarget: () => document.getElementById('box'), onClosing: () => order.push('closing'), onClose: () => order.push('closed') });
	opener.focus();
	order.length = 0;
	drawer.open();
	drawer.close();
	expect(order).toEqual(['closing', 'focus', 'closed']);
});
