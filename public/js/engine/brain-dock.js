// Elarion dock for Mission Control: typed chat (POST /api/master-brain/chat) and the voice dock
// (ws /api/voice/stream) sharing one engine session, so typed and spoken turns are one conversation.
// mission-control.js mounts it into the workspace's Elarion panel; it is always open there.
//
// Voice input: when the engine reports STT (ready.stt), the mic streams webm-opus audio to it. Until an engine
// STT provider exists (engine Step 2.4a), the browser's SpeechRecognition transcribes and the text is sent as a
// client transcript. Voice replies play the engine's TTS audio when it has some, else the browser speaks them.
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';

export const BRAIN_AGENT_ID = 'master-brain';
export const SESSION_STORAGE_KEY = 'aether.engine.sessionId';
export const SPEAK_STORAGE_KEY = 'aether.brain.speakReplies';

// Elarion avatar modes and the status line shown beside it.
export const MODE_TEXT = {
  idle: 'Ready',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  halted: 'Halted by circuit breaker',
  offline: 'Engine offline',
};

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export function createSessionId() {
  const random = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return 'portal-' + random;
}

function browserStorage() {
  return {
    get(key) {
      try {
        return globalThis.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        globalThis.localStorage.setItem(key, value);
      } catch {
        // Storage blocked: the session id just won't survive a reload.
      }
    },
  };
}

function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Plays an engine `audio` frame; resolves when playback ends (or fails).
export function playEngineAudio(frame) {
  const bytes = base64ToBytes(frame.data);
  if (frame.format === 'pcm16') {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return Promise.resolve();
    const ctx = new Context();
    const samples = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    const buffer = ctx.createBuffer(1, samples.length, frame.sample_rate || 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    return new Promise((resolve) => {
      source.onended = () => {
        ctx.close();
        resolve();
      };
      source.start();
    });
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/webm' }));
  const audio = new Audio(url);
  return new Promise((resolve) => {
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

export function mountBrainDock(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || getEngineApi();
  const agentId = options.agentId || BRAIN_AGENT_ID;
  const storage = options.storage || browserStorage();
  const Recognition = 'Recognition' in options ? options.Recognition : win.SpeechRecognition || win.webkitSpeechRecognition || null;
  const synth = 'synth' in options ? options.synth : win.speechSynthesis || null;
  const Utterance = options.Utterance || win.SpeechSynthesisUtterance || null;
  const MediaRecorderImpl = 'MediaRecorder' in options ? options.MediaRecorder : win.MediaRecorder || null;
  const getUserMedia =
    'getUserMedia' in options
      ? options.getUserMedia
      : win.navigator && win.navigator.mediaDevices && win.navigator.mediaDevices.getUserMedia
        ? (constraints) => win.navigator.mediaDevices.getUserMedia(constraints)
        : null;
  const playAudio = options.playAudio || playEngineAudio;

  let sessionId = storage.get(SESSION_STORAGE_KEY) || createSessionId();
  storage.set(SESSION_STORAGE_KEY, sessionId);
  let speakReplies = storage.get(SPEAK_STORAGE_KEY) !== 'false';

  const view = { mode: 'idle', busy: false, halted: false };
  // Voice session: the open stream, its ready frame, and whichever capture is running.
  const voice = { stream: null, ready: null, recognition: null, recorder: null, media: null, closing: false };

  // --- dock panel
  const avatar = el(doc, 'div', { class: 'elaron', 'data-mode': 'idle', 'aria-hidden': 'true' }, [
    el(doc, 'span', { class: 'elaron-ring' }),
    el(doc, 'span', { class: 'elaron-core' }),
  ]);
  const status = el(doc, 'span', { class: 'brain-status', 'aria-live': 'polite', text: MODE_TEXT.idle });
  const newButton = el(doc, 'button', { type: 'button', class: 'brain-icon-btn brain-new', title: 'Start a new session', text: 'New' });
  const log = el(doc, 'ol', { class: 'brain-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const empty = el(doc, 'li', { class: 'brain-empty', text: 'Ask the Master Brain about blueprints, agents, budgets or breaker state. Type, or tap the mic to talk to Elarion.' });
  log.append(empty);
  const interim = el(doc, 'p', { class: 'brain-interim', hidden: true });
  const input = el(doc, 'textarea', { class: 'brain-input', rows: '1', placeholder: 'Message the Master Brain', 'aria-label': 'Message', maxlength: '32000' });
  const micButton = el(doc, 'button', { type: 'button', class: 'brain-icon-btn brain-mic', 'aria-pressed': 'false', 'aria-label': 'Talk', title: 'Talk to Elarion', text: '🎙' });
  const speakButton = el(doc, 'button', { type: 'button', class: 'brain-icon-btn brain-speak', 'aria-label': 'Speak voice replies' });
  const sendButton = el(doc, 'button', { type: 'submit', class: 'brain-send', text: 'Send' });
  const form = el(doc, 'form', { class: 'brain-form', autocomplete: 'off' }, [input, micButton, speakButton, sendButton]);
  const hint = el(doc, 'p', { class: 'brain-hint' });
  const panel = el(doc, 'div', { class: 'brain-dock' }, [
    el(doc, 'header', { class: 'brain-head' }, [
      avatar,
      el(doc, 'div', { class: 'brain-title' }, [el(doc, 'h2', { text: 'Elarion · Master Brain' }), status]),
      newButton,
    ]),
    log,
    interim,
    form,
    hint,
  ]);
  container.replaceChildren(panel);

  // --- rendering
  function setMode(mode) {
    view.mode = view.halted && mode !== 'halted' && mode !== 'offline' ? 'halted' : mode;
    render();
  }

  function render() {
    avatar.dataset.mode = view.mode;
    status.textContent = MODE_TEXT[view.mode];
    const listening = Boolean(voice.recognition || voice.recorder);
    micButton.setAttribute('aria-pressed', String(listening));
    micButton.disabled = view.halted || (view.busy && !listening);
    micButton.title = listening ? 'Stop and send' : 'Talk to Elarion';
    sendButton.disabled = view.busy || view.halted;
    input.disabled = view.halted;
    newButton.disabled = view.busy;
    speakButton.setAttribute('aria-pressed', String(speakReplies));
    speakButton.textContent = speakReplies ? '🔊' : '🔈';
    speakButton.title = speakReplies ? 'Voice replies are spoken (click to mute)' : 'Voice replies are muted (click to speak them)';
    hint.textContent = hintText();
  }

  function hintText() {
    if (view.halted) return 'The agent is halted. Reset it from the top bar to continue.';
    if (voice.ready) return voice.ready.stt ? 'Voice: the engine transcribes your audio.' : Recognition ? 'Voice: your browser transcribes speech, then the text goes to the engine.' : '';
    if (!Recognition && !(MediaRecorderImpl && getUserMedia)) return 'Voice needs a browser with speech recognition (Chrome or Edge).';
    return 'Enter sends · Shift+Enter for a new line';
  }

  function addMessage(kind, text, meta = {}) {
    empty.remove();
    const item = el(doc, 'li', { class: 'brain-msg brain-' + kind });
    item.append(el(doc, 'p', { class: 'brain-text', text }));
    const details = [];
    if (meta.via === 'voice') details.push('voice');
    if (meta.tokens) details.push(meta.tokens.input.toLocaleString() + ' in / ' + meta.tokens.output.toLocaleString() + ' out');
    if (details.length) item.append(el(doc, 'span', { class: 'brain-meta', text: details.join(' · ') }));
    log.append(item);
    log.scrollTop = log.scrollHeight;
    return item;
  }

  function describeError(error) {
    if (!error) return 'Unknown error.';
    if (error.isHalted || error.halted) return null;
    if (error.isUnreachable) return 'Can’t reach the Aether Engine at ' + api.baseUrl + '. Is it running?';
    if (error.isUnauthorized) return describeAuthError(error);
    if (error.status === 409) return 'Still answering the previous message.';
    if (error.status === 503) return 'The Master Brain isn’t configured on the engine (MISERLY_CLIENT_KEY).';
    if (error.status === 422) return 'The model declined that request.';
    if (error.status === 429) return 'Miserly.io rate or budget limit reached. Try again later.';
    return error.message || 'The engine returned an error.';
  }

  function handleError(error) {
    if (error && (error.isHalted || error.halted)) {
      markHalted(error.body && error.body.reason);
      return;
    }
    addMessage('error', describeError(error));
    setMode(error && error.isUnreachable ? 'offline' : 'idle');
  }

  function markHalted(reason) {
    if (!view.halted) addMessage('system', 'Halted by the circuit breaker' + (reason ? ': ' + reason : '') + '. Reset the agent from the top bar to continue.');
    view.halted = true;
    stopCapture(false);
    stopSpeaking();
    view.busy = false;
    setMode('halted');
  }

  const unsubscribe = onEngineState((detail) => {
    if (detail.agentId !== agentId) return;
    if (detail.state === 'HALTED') {
      markHalted(detail.reason);
    } else if (view.halted) {
      view.halted = false;
      addMessage('system', 'Agent reset. The Master Brain is active again.');
      setMode('idle');
    }
  });

  // --- typed chat
  async function sendTyped(text) {
    view.busy = true;
    addMessage('user', text);
    setMode('thinking');
    try {
      const reply = await api.sendMasterBrainChat(text, sessionId, { agentId });
      addMessage('assistant', reply.response, { tokens: reply.tokens });
      setMode('idle');
    } catch (error) {
      handleError(error);
    } finally {
      view.busy = false;
      render();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || view.busy || view.halted) return;
    input.value = '';
    sendTyped(text);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new win.Event('submit', { cancelable: true }));
    }
  });

  // --- voice stream
  function onVoiceFrame(frame) {
    switch (frame.type) {
      case 'transcript':
        interim.hidden = true;
        addMessage('user', frame.text, { via: 'voice' });
        return;
      case 'response':
        view.busy = false;
        addMessage('assistant', frame.text, { tokens: frame.tokens, via: 'voice' });
        if (!speakReplies) return setMode('idle');
        // The engine's own TTS audio follows in an `audio` frame; otherwise the browser speaks it.
        if (voice.ready && voice.ready.tts) return setMode('thinking');
        return speakText(frame.text);
      case 'audio':
        if (!speakReplies) return;
        setMode('speaking');
        playAudio(frame).then(() => {
          if (view.mode === 'speaking') setMode('idle');
        });
        return;
      case 'error':
        if (frame.code === 'AGENT_HALTED') return markHalted(frame.reason);
        view.busy = false;
        interim.hidden = true;
        addMessage('error', frame.code === 'STT_UNAVAILABLE' ? 'The engine has no speech-to-text yet. Type instead.' : frame.message);
        setMode('idle');
        return;
    }
  }

  function onVoiceClose(info) {
    const intentional = voice.closing;
    voice.stream = null;
    voice.ready = null;
    voice.closing = false;
    stopCapture(false);
    if (info.halted) return markHalted();
    if (!intentional && view.busy) {
      view.busy = false;
      addMessage('error', 'The voice stream closed before the reply arrived.');
    }
    if (view.mode !== 'speaking') setMode('idle');
  }

  async function ensureVoice() {
    if (voice.stream && voice.stream.isOpen && voice.ready) return voice.stream;
    setMode('connecting');
    // HTTP pre-check: a browser WebSocket can't report why a handshake failed, but this call can (401, offline, HALTED).
    const state = await api.getAgentState(agentId);
    if (state.state === 'HALTED') {
      markHalted(state.reason);
      return null;
    }
    const stream = api.openVoiceStream({ sessionId, agentId, format: 'webm-opus' }, { onFrame: onVoiceFrame, onClose: onVoiceClose });
    voice.stream = stream;
    voice.ready = await stream.ready;
    return stream;
  }

  function closeVoice() {
    if (voice.stream) {
      voice.closing = true;
      voice.stream.close();
    }
  }

  // --- speech capture
  async function startListening() {
    let stream;
    try {
      stream = await ensureVoice();
    } catch (error) {
      return handleError(error);
    }
    if (!stream) return;
    stopSpeaking();

    if (voice.ready.stt && MediaRecorderImpl && getUserMedia) return startRecording(stream);
    if (Recognition) return startRecognition(stream);
    addMessage('error', 'Voice input needs speech recognition: this browser has none and the engine has no speech-to-text yet. Type instead.');
    setMode('idle');
  }

  async function startRecording(stream) {
    let media;
    try {
      media = await getUserMedia({ audio: true });
    } catch {
      addMessage('error', 'Microphone access was blocked.');
      return setMode('idle');
    }
    const recorder = new MediaRecorderImpl(media, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0 && stream.isOpen) stream.sendAudio(event.data);
    };
    recorder.onstop = () => {
      media.getTracks().forEach((track) => track.stop());
      // Each recording is one utterance; the final chunk arrives before onstop.
      if (voice.recorder === recorder) {
        voice.recorder = null;
        voice.media = null;
        if (stream.isOpen && !view.halted) {
          view.busy = true;
          stream.endUtterance();
          setMode('thinking');
        }
      }
    };
    voice.recorder = recorder;
    voice.media = media;
    recorder.start(250);
    setMode('listening');
  }

  function startRecognition(stream) {
    const recognition = new Recognition();
    recognition.lang = (win.navigator && win.navigator.language) || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = (event) => {
      let live = '';
      finalText = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else live += result[0].transcript;
      }
      interim.textContent = (finalText + live).trim();
      interim.hidden = !interim.textContent;
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') addMessage('error', 'Microphone or speech recognition access was blocked.');
      else if (event.error !== 'no-speech' && event.error !== 'aborted') addMessage('error', 'Speech recognition failed: ' + event.error + '.');
    };
    recognition.onend = () => {
      if (voice.recognition !== recognition) return;
      voice.recognition = null;
      const text = finalText.trim();
      if (text && stream.isOpen && !view.halted) {
        view.busy = true;
        stream.sendText(text);
        setMode('thinking');
      } else {
        interim.hidden = true;
        setMode(view.halted ? 'halted' : 'idle');
      }
    };
    voice.recognition = recognition;
    recognition.start();
    setMode('listening');
  }

  // send=true lets the capture finish normally (recording -> end_utterance, recognition -> final text);
  // send=false abandons it.
  function stopCapture(send) {
    if (voice.recognition) {
      const recognition = voice.recognition;
      if (send) recognition.stop();
      else {
        voice.recognition = null;
        recognition.abort();
      }
    }
    if (voice.recorder) {
      const recorder = voice.recorder;
      if (!send) {
        voice.recorder = null;
        if (voice.stream && voice.stream.isOpen) voice.stream.cancel();
        if (voice.media) voice.media.getTracks().forEach((track) => track.stop());
        voice.media = null;
      }
      if (recorder.state !== 'inactive') recorder.stop();
    }
    interim.hidden = true;
  }

  function speakText(text) {
    if (!synth || !Utterance || !text.trim()) return setMode('idle');
    const utterance = new Utterance(text);
    utterance.onend = utterance.onerror = () => {
      if (view.mode === 'speaking') setMode('idle');
    };
    synth.cancel();
    setMode('speaking');
    synth.speak(utterance);
  }

  function stopSpeaking() {
    if (synth && view.mode === 'speaking') synth.cancel();
  }

  micButton.addEventListener('click', () => {
    if (voice.recognition || voice.recorder) {
      stopCapture(true);
      render();
    } else if (!view.busy && !view.halted) {
      startListening();
    }
  });

  speakButton.addEventListener('click', () => {
    speakReplies = !speakReplies;
    storage.set(SPEAK_STORAGE_KEY, String(speakReplies));
    if (!speakReplies) {
      stopSpeaking();
      if (view.mode === 'speaking') setMode('idle');
    }
    render();
  });

  // --- session and visibility
  newButton.addEventListener('click', () => {
    if (view.busy) return;
    stopCapture(false);
    stopSpeaking();
    closeVoice();
    sessionId = createSessionId();
    storage.set(SESSION_STORAGE_KEY, sessionId);
    log.replaceChildren(empty);
    addMessage('system', 'New session started.');
    setMode(view.halted ? 'halted' : 'idle');
  });

  // Leaving the page (or switching away on a phone) ends listening and the voice stream; the next mic tap reconnects.
  function onPageHide() {
    stopCapture(false);
    stopSpeaking();
    closeVoice();
  }
  win.addEventListener('pagehide', onPageHide);

  render();

  return {
    getMode: () => view.mode,
    getSessionId: () => sessionId,
    elements: { panel, avatar, status, log, input, form, micButton, speakButton, sendButton, newButton, interim, hint },
    destroy() {
      onPageHide();
      win.removeEventListener('pagehide', onPageHide);
      unsubscribe();
      container.replaceChildren();
    },
  };
}
