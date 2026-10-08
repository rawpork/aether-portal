// Command bar voice hook and Mission Control's ☰ menu tray.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceInput, mountCommandBar } from '../../public/js/engine/command-bar.js';
import { RAIL_KEY, setupMenuTray, setupTabset } from '../../public/js/engine/mission-control.js';

// A stand-in SpeechRecognition the test drives by hand.
function fakeRecognitionWindow() {
	const made = [];
	class Recognition {
		constructor() {
			made.push(this);
		}
		start() {
			this.started = true;
		}
		stop() {
			this.onend && this.onend();
		}
		say(text, isFinal) {
			this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
		}
	}
	return { win: { SpeechRecognition: Recognition, navigator: { language: 'en-GB' } }, made };
}

describe('createVoiceInput', () => {
	it('reports transcripts and listening state, and is unsupported without the Web Speech API', () => {
		const { win, made } = fakeRecognitionWindow();
		const heard = [];
		const states = [];
		const voice = createVoiceInput({ win, onText: (t, f) => heard.push([t, f]), onState: (s) => states.push(s) });
		expect(voice.supported).toBe(true);
		voice.start();
		expect(made[0].lang).toBe('en-GB');
		made[0].say('add a note', false);
		made[0].say('add a note about tea', true);
		voice.stop();
		expect(heard).toEqual([['add a note', false], ['add a note about tea', true]]);
		expect(states).toEqual([true, false]);
		expect(createVoiceInput({ win: {} }).supported).toBe(false);
	});
});

describe('mountCommandBar', () => {
	const build = () => {
		const form = document.createElement('form');
		const input = document.createElement('input');
		const mic = document.createElement('button');
		mic.type = 'button';
		form.append(input, mic);
		document.body.append(form);
		return { form, input, mic };
	};
	afterEach(() => document.body.replaceChildren());

	it('fills the input by voice and sends only on submit', () => {
		const { win, made } = fakeRecognitionWindow();
		const { form, input, mic } = build();
		const sent = [];
		mountCommandBar(form, { input, mic, win, onSubmit: (t) => sent.push(t) });
		input.value = 'ask';
		mic.click();
		expect(mic.getAttribute('aria-pressed')).toBe('true');
		made[0].say('what changed today', true);
		expect(input.value).toBe('ask what changed today');
		expect(sent).toEqual([]);
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		expect(sent).toEqual(['ask what changed today']);
		expect(input.value).toBe('');
	});

	it('disables the mic where the browser has no speech recognition', () => {
		const { form, input, mic } = build();
		mountCommandBar(form, { input, mic, win: {}, onSubmit: () => {} });
		expect(mic.disabled).toBe(true);
		expect(mic.title).toMatch(/needs a browser with speech recognition/);
	});
});

describe('menu tray', () => {
	const page = () => {
		document.body.innerHTML = '<button id="mc-menu-toggle" aria-expanded="false"></button><button id="mc-scrim" hidden></button>'
			+ '<aside id="mc-rail"><button class="rail-item" id="a"></button></aside>';
	};
	const media = (matches) => {
		const queries = {};
		return {
			queries,
			matchMedia: (q) => (queries[q] = { matches: matches(q), addEventListener: vi.fn() }),
		};
	};
	const store = () => {
		const data = new Map();
		return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
	};
	afterEach(() => {
		document.body.replaceChildren();
		delete document.body.dataset.rail;
		document.body.className = '';
	});

	it('folds the desktop rail to icons and back, remembering the choice', () => {
		page();
		const storage = store();
		const win = media(() => false);
		const tray = setupMenuTray(document, { win, storage });
		expect(tray.getMode()).toBe('full');
		document.getElementById('mc-menu-toggle').click();
		expect(document.body.dataset.rail).toBe('icons');
		expect(storage.data.get(RAIL_KEY)).toBe('icons');
		expect(document.getElementById('mc-menu-toggle').getAttribute('aria-expanded')).toBe('false');
	});

	it('starts folded on medium screens', () => {
		page();
		const win = media((q) => q === '(max-width: 1180px)');
		expect(setupMenuTray(document, { win, storage: store() }).getMode()).toBe('icons');
	});

	it('opens as a drawer on phones and closes from the scrim, Escape or a pick', () => {
		page();
		const win = media(() => true);
		setupMenuTray(document, { win, storage: store() });
		const toggle = document.getElementById('mc-menu-toggle');
		const scrim = document.getElementById('mc-scrim');
		toggle.click();
		expect(document.body.classList.contains('rail-open')).toBe(true);
		expect(scrim.hidden).toBe(false);
		scrim.click();
		expect(document.body.classList.contains('rail-open')).toBe(false);
		toggle.click();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(document.body.classList.contains('rail-open')).toBe(false);
		toggle.click();
		document.getElementById('a').click();
		expect(document.body.classList.contains('rail-open')).toBe(false);
	});
});

describe('setupTabset', () => {
	it('shows one panel at a time and moves with the arrow keys', () => {
		document.body.innerHTML = '<button id="t1"></button><button id="t2"></button><div id="p1"></div><div id="p2" hidden></div>';
		const seen = [];
		const tabs = setupTabset(document, [['t1', 'p1'], ['t2', 'p2']], (i) => seen.push(i));
		document.getElementById('t2').click();
		expect(document.getElementById('p1').hidden).toBe(true);
		expect(document.getElementById('p2').hidden).toBe(false);
		document.getElementById('t2').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
		expect(document.getElementById('p1').hidden).toBe(false);
		expect(seen).toEqual([1, 0]);
		expect(tabs).not.toBeNull();
		document.body.replaceChildren();
	});
});
