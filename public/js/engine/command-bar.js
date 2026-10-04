// Command bar: a text-first input along the bottom of the screen with a [Microphone] button that types by voice.
// Mission Control sends what is typed to Elarion; the main portal has its own copy of the voice hook (its page script
// is not a module). Voice uses the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition); where the
// browser has none the mic is disabled with a note. Speech only fills the input; nothing is sent until Send or Enter.

// A voice-input hook. onText(text, final) gets interim and final transcripts; onState(listening) follows the mic.
export function createVoiceInput({ win = globalThis, lang, onText = () => {}, onState = () => {} } = {}) {
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
    recognition.onerror = () => set(false);
    try {
      recognition.start();
      set(true);
      return true;
    } catch {
      set(false);
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
export function mountCommandBar(form, { input, mic, onSubmit, win = globalThis } = {}) {
  let before = '';
  const voice = createVoiceInput({
    win,
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
    mic.title = 'Voice input is not available in this browser';
  }
  mic.addEventListener('click', () => {
    before = input.value.trim();
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
