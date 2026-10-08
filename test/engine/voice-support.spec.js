// What each voice failure says, the speech unlock, and how the command bar and alerts use them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_LISTEN_TEXT, NO_SPEAK_TEXT, describeMicError, describeRecognitionError, primeSpeech } from '../../public/js/engine/voice-support.js';
import { createVoiceInput, mountCommandBar } from '../../public/js/engine/command-bar.js';
import { mountRealtimeAlerts } from '../../public/js/engine/realtime-alerts.js';

describe('describeRecognitionError', () => {
	it('tells the person what to do for each failure', () => {
		expect(describeRecognitionError('not-allowed')).toMatch(/blocked\. Allow the microphone for this site in your browser or phone settings/);
		expect(describeRecognitionError('service-not-allowed')).toBe(describeRecognitionError('not-allowed'));
		expect(describeRecognitionError('audio-capture')).toMatch(/No microphone was found, or another app is using it/);
		expect(describeRecognitionError('network')).toMatch(/Check your connection/);
		expect(describeRecognitionError('language-not-supported')).toMatch(/language/);
		expect(describeRecognitionError('no-speech')).toMatch(/did not hear anything/);
	});

	it('stays quiet only for a stop on purpose, and names an unknown code rather than hiding it', () => {
		expect(describeRecognitionError('aborted')).toBeNull();
		expect(describeRecognitionError('surprise')).toBe('Speech recognition failed (surprise). Type instead.');
		expect(describeRecognitionError(undefined)).toBe('Speech recognition failed. Type instead.');
	});
});

describe('describeMicError', () => {
	it('maps the getUserMedia error names', () => {
		for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) expect(describeMicError({ name })).toMatch(/blocked\. Allow it for this site/);
		expect(describeMicError({ name: 'NotFoundError' })).toBe('No microphone was found.');
		expect(describeMicError({ name: 'NotReadableError' })).toBe('The microphone is being used by another app.');
		expect(describeMicError({ name: 'NotSupportedError' })).toMatch(/cannot record audio in the format the engine needs/);
		expect(describeMicError({ name: 'Weird', message: 'boom' })).toBe('Could not start the microphone: boom');
		expect(describeMicError(undefined)).toBe('Could not start the microphone.');
	});
});

describe('primeSpeech', () => {
	class Utterance {
		constructor(text) {
			this.text = text;
		}
	}

	it('speaks one silent, marked utterance', () => {
		const spoken = [];
		expect(primeSpeech({ speak: (u) => spoken.push(u) }, Utterance)).toBe(true);
		expect(spoken).toHaveLength(1);
		expect(spoken[0]).toMatchObject({ text: ' ', volume: 0, isPrime: true });
	});

	it('does nothing without a synthesizer, and survives one that throws', () => {
		expect(primeSpeech(null, Utterance)).toBe(false);
		expect(primeSpeech({ speak() {} }, null)).toBe(false);
		expect(primeSpeech({ speak() { throw new Error('no voices'); } }, Utterance)).toBe(false);
	});
});

describe('the command bar mic', () => {
	const build = () => {
		const form = document.createElement('form');
		const input = document.createElement('input');
		input.placeholder = 'Ask Elarion…';
		const mic = document.createElement('button');
		mic.type = 'button';
		form.append(input, mic);
		document.body.append(form);
		return { form, input, mic };
	};
	const recognitionWindow = ({ throwOnStart = null } = {}) => {
		const made = [];
		class Recognition {
			constructor() {
				made.push(this);
			}
			start() {
				if (throwOnStart) throw Object.assign(new Error('refused'), { name: throwOnStart });
			}
			stop() {
				this.onend && this.onend();
			}
		}
		return { win: { SpeechRecognition: Recognition, navigator: { language: 'en-US' }, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }, made };
	};
	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
	});

	it('reports a recognition failure to onError, and the mic un-presses', () => {
		const { win, made } = recognitionWindow();
		const errors = [];
		const states = [];
		const voice = createVoiceInput({ win, onError: (code) => errors.push(code), onState: (s) => states.push(s) });
		voice.start();
		made[0].onerror({ error: 'not-allowed' });
		expect(errors).toEqual(['not-allowed']);
		expect(states).toEqual([true, false]);
	});

	it('reports a start that throws, by what it was', () => {
		const errors = [];
		const denied = createVoiceInput({ win: recognitionWindow({ throwOnStart: 'NotAllowedError' }).win, onError: (c) => errors.push(c) });
		expect(denied.start()).toBe(false);
		const other = createVoiceInput({ win: recognitionWindow({ throwOnStart: 'InvalidStateError' }).win, onError: (c) => errors.push(c) });
		expect(other.start()).toBe(false);
		expect(errors).toEqual(['not-allowed', 'start-failed']);
	});

	it('shows the problem in the placeholder, announces it, and puts the placeholder back', () => {
		vi.useFakeTimers();
		const { win, made } = recognitionWindow();
		const { form, input, mic } = build();
		const said = [];
		mountCommandBar(form, { input, mic, win, onSubmit() {}, say: (t) => said.push(t) });
		mic.click();
		made[0].onerror({ error: 'not-allowed' });
		expect(input.placeholder).toMatch(/^The microphone or speech recognition is blocked/);
		expect(said).toEqual([input.placeholder]);
		expect(mic.dataset.error).toBe('true');
		expect(mic.getAttribute('aria-pressed')).toBe('false');
		vi.advanceTimersByTime(8000);
		expect(input.placeholder).toBe('Ask Elarion…');
		expect(mic.dataset.error).toBeUndefined();
	});

	it('clears an old problem when the mic is tapped again, and stays quiet for an abort', () => {
		const { win, made } = recognitionWindow();
		const { form, input, mic } = build();
		const said = [];
		mountCommandBar(form, { input, mic, win, onSubmit() {}, say: (t) => said.push(t) });
		mic.click();
		made[0].onerror({ error: 'network' });
		expect(input.placeholder).toMatch(/could not reach its service/);
		mic.click();
		expect(input.placeholder).toBe('Ask Elarion…');
		made[1].onerror({ error: 'aborted' });
		expect(said).toHaveLength(1);
		expect(input.placeholder).toBe('Ask Elarion…');
	});

	it('explains why the mic is disabled where speech recognition is missing', () => {
		const { form, input, mic } = build();
		mountCommandBar(form, { input, mic, win: {}, onSubmit() {}, say() {} });
		expect(mic.disabled).toBe(true);
		expect(mic.title).toBe(NO_LISTEN_TEXT);
		expect(NO_SPEAK_TEXT).toMatch(/cannot speak/);
	});
});

describe('spoken alerts and the iPhone speech unlock', () => {
	class Utterance {
		constructor(text) {
			this.text = text;
		}
	}
	const make = (storageValue = null) => {
		const win = new EventTarget();
		const spoken = [];
		const alerts = mountRealtimeAlerts(win, { announce() {}, synth: { speak: (u) => spoken.push(u) }, Utterance, storage: { getItem: () => storageValue }, now: () => Date.parse('2026-10-08T12:00:00.000Z') });
		return { win, spoken, alerts };
	};

	it('speaks one silent utterance on the first tap or key press, and only once', () => {
		const { win, spoken } = make();
		expect(spoken).toEqual([]);
		win.dispatchEvent(new Event('pointerdown'));
		win.dispatchEvent(new Event('keydown'));
		win.dispatchEvent(new Event('pointerdown'));
		expect(spoken).toHaveLength(1);
		expect(spoken[0]).toMatchObject({ isPrime: true, volume: 0 });
	});

	it('does not unlock when voice replies are muted, or after it is stopped', () => {
		const muted = make('false');
		muted.win.dispatchEvent(new Event('pointerdown'));
		expect(muted.spoken).toEqual([]);
		const stopped = make();
		stopped.alerts.stop();
		stopped.win.dispatchEvent(new Event('pointerdown'));
		expect(stopped.spoken).toEqual([]);
	});
});
