// Command bar: a text-first input along the bottom of the screen with a [Microphone] button that types by voice.
// Mission Control sends what is typed to Elarion; the main portal has its own copy of the voice hook (its page script
// is not a module). Voice uses the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition); where the
// browser has none the mic is disabled with a note. Speech only fills the input; nothing is sent until Send or Enter.

import { announce } from '../a11y.js';
import { NO_LISTEN_TEXT, describeRecognitionError } from './voice-support.js';

const NOTE_MS = 8000;

// A voice-input hook. onText(text, final) gets interim and final transcripts; onState(listening) follows the mic; onError(code)
// gets the browser's reason when recognition fails or cannot start ('not-allowed', 'no-speech', 'start-failed', ...).
export function createVoiceInput({ win = globalThis, lang, onText = () => {}, onState = () => {}, onError = () => {} } = {}) {
  const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  const set = (value) => {
    listening = value;
    onState(value);
  };
  function start() {
    if (!Recognition || listening) return false;
    recognition = new Recognition();
    recognition.lang = lang || (win.navigator && win.navigator.language) || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let text = '';
      let final = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
        if (event.results[i].isFinal) final = true;
      }
      onText(text.trim(), final);
    };
    recognition.onend = () => set(false);
    recognition.onerror = (event) => {
      set(false);
      onError((event && event.error) || 'unknown');
    };
    try {
      recognition.start();
      set(true);
      return true;
    } catch (error) {
      set(false);
      onError(error && error.name === 'NotAllowedError' ? 'not-allowed' : 'start-failed');
      return false;
    }
  }
  function stop() {
    if (recognition && listening) recognition.stop();
  }
  return {
    supported: Boolean(Recognition),
    start,
    stop,
    toggle: () => (listening ? stop() : start()),
    isListening: () => listening,
  };
}

// Wires a form (an input, a mic button and a submit button) as a command bar. onSubmit(text) runs on Send / Enter.
export function mountCommandBar(form, { input, mic, onSubmit, win = globalThis, say = announce } = {}) {
  let before = '';
  // A voice problem is shown where the person is looking, in the input's placeholder for a few seconds, and announced for screen
  // readers. It used to vanish: the mic just un-pressed.
  const placeholder = input.placeholder;
  let noteTimer = null;
  const note = (text) => {
    input.placeholder = text;
    mic.dataset.error = 'true';
    say(text);
    win.clearTimeout && win.clearTimeout(noteTimer);
    noteTimer = win.setTimeout ? win.setTimeout(clearNote, NOTE_MS) : null;
  };
  function clearNote() {
    input.placeholder = placeholder;
    delete mic.dataset.error;
  }
  const voice = createVoiceInput({
    win,
    onError: (code) => {
      const text = describeRecognitionError(code);
      if (text) note(text);
    },
    onText: (text) => {
      input.value = (before ? before + ' ' : '') + text;
    },
    onState: (listening) => {
      mic.setAttribute('aria-pressed', String(listening));
      mic.title = listening ? 'Listening… (tap to stop)' : 'Speak (Microphone)';
      if (!listening) input.focus();
    },
  });
  if (!voice.supported) {
    mic.disabled = true;
    mic.title = NO_LISTEN_TEXT;
  }
  mic.addEventListener('click', () => {
    before = input.value.trim();
    clearNote();
    voice.toggle();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    voice.stop();
    input.value = '';
    onSubmit(text);
  });
  return { voice, focus: () => input.focus() };
}
