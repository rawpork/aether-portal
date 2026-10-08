// Elarion dock for Mission Control: typed chat (POST /api/master-brain/chat) and the voice dock
// (ws /api/voice/stream) sharing one engine session, so typed and spoken turns are one conversation.
// mission-control.js mounts it into the workspace's Elarion panel; it is always open there.
//
// Voice input: when the engine reports STT (ready.stt), the mic streams webm-opus audio to it. Until an engine
// STT provider exists (engine Step 2.4a), the browser's SpeechRecognition transcribes and the text is sent as a
// client transcript. Voice replies play the engine's TTS audio when it has some, else the browser speaks them.
import { createConversationStore, replayContext } from './conversation-store.js';
import { choiceReply, parseNumberedOptions, renderChoiceChips } from './choice-chips.js';
import { getEngineApi, onEngineState } from '../engine-api.bundle.js';
import { describeAuthError } from './connection.js';
import { NO_LISTEN_TEXT, NO_SPEAK_TEXT, describeMicError, describeRecognitionError, primeSpeech } from './voice-support.js';

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
  // Saved conversations (conversation-store.js). A thread is "main", or "project:<id>" when the chosen scope is a project; the
  // engine session follows the thread so each project keeps its own line of talk.
  const history = options.history || null;
  const threadSessions = {};
  let loadedThread = null;
  let replay = null;
  // What this browser can do. A button for something it cannot do is disabled and says why, instead of failing when tapped.
  const canListen = Boolean(Recognition) || Boolean(MediaRecorderImpl && getUserMedia);
  const canSpeak = Boolean(synth && Utterance);
  // iPhone Safari speaks only after something has spoken from a tap: do it once, from the tap that asked for voice.
  let primed = false;
  const prime = () => {
    if (primed || !speakReplies || !canSpeak) return;
    primed = primeSpeech(synth, Utterance);
  };

  const view = { mode: 'idle', busy: false, halted: false };
  // What the conversation is about, as chips: "Asking about: Marketing". scopes: [{ id, label, context }]; scope: the chosen id, or
  // null for everything. The chosen scope's context travels with each typed message (the engine reads it as data), and its label
  // is shown on that message in the thread.
  let scopes = [];
  let scope = null;
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
  const empty = el(doc, 'li', { class: 'brain-empty', text: 'Ask Elarion about blueprints, agents, budgets or breaker state. Type, or tap the mic to talk to Elarion.' });
  log.append(empty);
  const interim = el(doc, 'p', { class: 'brain-interim', hidden: true });
  const input = el(doc, 'textarea', { class: 'brain-input', rows: '1', placeholder: 'Ask Elarion…', 'aria-label': 'Message', maxlength: '32000' });
  const micButton = el(doc, 'button', { type: 'button', class: 'brain-icon-btn brain-mic', 'aria-pressed': 'false', 'aria-label': 'Talk', title: 'Talk to Elarion', text: '🎙' });
  const speakButton = el(doc, 'button', { type: 'button', class: 'brain-icon-btn brain-speak', 'aria-label': 'Speak voice replies' });
  const sendButton = el(doc, 'button', { type: 'submit', class: 'brain-send', text: 'Send' });
  const form = el(doc, 'form', { class: 'brain-form', autocomplete: 'off' }, [input, micButton, speakButton, sendButton]);
  const hint = el(doc, 'p', { class: 'brain-hint' });
  const scopeBar = el(doc, 'div', { class: 'brain-scope', role: 'group', 'aria-label': 'What you are asking about', hidden: true });
  const panel = el(doc, 'div', { class: 'brain-dock' }, [
    el(doc, 'header', { class: 'brain-head' }, [
      avatar,
      el(doc, 'div', { class: 'brain-title' }, [el(doc, 'h2', { text: 'Elarion' }), status]),
      newButton,
    ]),
    scopeBar,
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
    micButton.disabled = !canListen || view.halted || (view.busy && !listening);
    micButton.title = !canListen ? NO_LISTEN_TEXT : listening ? 'Stop and send' : 'Talk to Elarion';
    sendButton.disabled = view.busy || view.halted;
    input.disabled = view.halted;
    newButton.disabled = view.busy;
    const speaking = speakReplies && canSpeak;
    speakButton.disabled = !canSpeak;
    speakButton.setAttribute('aria-pressed', String(speaking));
    speakButton.textContent = speaking ? '🔊' : '🔈';
    speakButton.title = !canSpeak ? NO_SPEAK_TEXT : speakReplies ? 'Voice replies are spoken (click to mute)' : 'Voice replies are muted (click to speak them)';
    hint.textContent = hintText();
  }

  // The bar of chips under the header: "Asking about:" and one chip per scope, plus "Everything". Hidden when there is nothing to choose.
  function renderScopes() {
    scopeBar.replaceChildren();
    scopeBar.hidden = scopes.length === 0;
    if (!scopes.length) return;
    scopeBar.append(el(doc, 'span', { class: 'brain-scope-label', text: 'Asking about:' }));
    const chip = (id, label) => {
      const on = scope === id;
      const button = el(doc, 'button', { type: 'button', class: 'brain-chip', 'aria-pressed': String(on), 'data-scope': id === null ? '' : id, text: label });
      button.addEventListener('click', () => setScope(id));
      return button;
    };
    for (const s of scopes) scopeBar.append(chip(s.id, s.label));
    scopeBar.append(chip(null, 'Everything'));
  }

  function hintText() {
    if (view.halted) return 'The agent is halted. Reset it from the top bar to continue.';
    if (voice.ready) return voice.ready.stt ? 'Voice: the engine transcribes your audio.' : Recognition ? 'Voice: your browser transcribes speech, then the text goes to the engine.' : '';
    if (!canListen) return NO_LISTEN_TEXT;
    return 'Enter sends · Shift+Enter for a new line';
  }

  const chosenScope = () => scopes.find((s) => s.id === scope) || null;
  const thread = () => {
    const chosen = chosenScope();
    return chosen && chosen.thread ? chosen.thread : 'main';
  };
  const activeSession = () => (thread() === 'main' ? sessionId : threadSessions[thread()] || (threadSessions[thread()] = 'thread-' + thread()));
  const saveMessage = (role, text) => {
    if (!history) return;
    const chosen = chosenScope();
    history.save(thread(), [{ role, content: text }], { title: chosen && chosen.thread ? chosen.label : 'Elarion conversation', project_id: chosen && chosen.project_id });
  };
  // Shows the saved messages of the current thread (the screen follows the scope: project talk is kept apart from the main thread).
  async function loadThread() {
    if (!history) return;
    const wanted = thread();
    loadedThread = wanted;
    const saved = await history.load(wanted);
    if (thread() !== wanted || view.busy) return;
    const messages = saved && Array.isArray(saved.messages) ? saved.messages : [];
    log.replaceChildren(empty);
    for (const m of messages) addMessage(m.role === 'user' ? 'user' : 'assistant', m.content, { persist: false });
    replay = messages.length ? replayContext(messages) : null;
  }

  function addMessage(kind, text, meta = {}) {
    empty.remove();
    if (meta.persist !== false && (kind === 'user' || kind === 'assistant')) saveMessage(kind, text);
    const item = el(doc, 'li', { class: 'brain-msg brain-' + kind });
    item.append(el(doc, 'p', { class: 'brain-text', text }));
    const details = [];
    if (meta.via === 'voice') details.push('voice');
    if (meta.tokens) details.push(meta.tokens.input.toLocaleString() + ' in / ' + meta.tokens.output.toLocaleString() + ' out');
    if (details.length) item.append(el(doc, 'span', { class: 'brain-meta', text: details.join(' · ') }));
    // Numbered options in a question become quick-reply chips that send the choice.
    const options = kind === 'assistant' ? parseNumberedOptions(text) : [];
    if (options.length) {
      item.append(renderChoiceChips(doc, options, (option) => {
        if (view.busy || view.halted) return;
        sendTyped(choiceReply(option));
      }));
    }
    // The scope this message was asked under, so the thread still says what each question was about.
    if (kind === 'user' && meta.scope) item.append(el(doc, 'span', { class: 'brain-scope-tag', text: 'Asking about: ' + meta.scope }));
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
    if (error.status === 503) return 'Elarion isn’t configured on the engine (MISERLY_CLIENT_KEY).';
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
      addMessage('system', 'Agent reset. Elarion is active again.');
      setMode('idle');
    }
  });

  // --- typed chat
  async function sendTyped(text) {
    view.busy = true;
    const chosen = scopes.find((s) => s.id === scope) || null;
    addMessage('user', text, { scope: chosen ? chosen.label : null });
    setMode('thinking');
    try {
      const context = { ...(chosen && chosen.context ? { asking_about: chosen.label, ...chosen.context } : {}), ...(replay ? { earlier_conversation: replay } : {}) };
      replay = null;
      const reply = await api.sendMasterBrainChat(text, activeSession(), { agentId, ...(Object.keys(context).length ? { context } : {}) });
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

  // quiet: the mic is already listening, so the connection is made without changing what the dock shows.
  async function ensureVoice(quiet = false) {
    if (voice.stream && voice.stream.isOpen && voice.ready) return voice.stream;
    if (!quiet) setMode('connecting');
    // HTTP pre-check: a browser WebSocket can't report why a handshake failed, but this call can (401, offline, HALTED).
    const state = await api.getAgentState(agentId);
    if (state.state === 'HALTED') {
      markHalted(state.reason);
      return null;
    }
    const stream = api.openVoiceStream({ sessionId: activeSession(), agentId, format: 'webm-opus' }, { onFrame: onVoiceFrame, onClose: onVoiceClose });
    voice.stream = stream;
    voice.ready = await stream.ready;
    // The hint depends on what the engine says it can do, so it is redrawn now that it has said.
    render();
    return stream;
  }

  function closeVoice() {
    if (voice.stream) {
      voice.closing = true;
      voice.stream.close();
    }
  }

  // --- speech capture
  // The browser lets a page start speech recognition (and ask for the microphone) only while the tap that wanted it is fresh, and
  // iPhone Safari is strict about it. So when the browser has speech recognition and the engine is not known to transcribe,
  // recognition starts right here, in the tap, and the connection to the engine is made alongside it and used when the words
  // are ready. (The engine has no speech-to-text provider yet, so this is the usual case.)
  async function startListening() {
    stopSpeaking();
    prime();
    const engineTranscribes = voice.ready && voice.ready.stt && MediaRecorderImpl && getUserMedia;
    if (Recognition && !engineTranscribes) return startRecognition();

    let stream;
    try {
      stream = await ensureVoice();
    } catch (error) {
      return handleError(error);
    }
    if (!stream) return;

    if (voice.ready.stt && MediaRecorderImpl && getUserMedia) return startRecording(stream);
    if (Recognition) return startRecognition(stream);
    addMessage('error', 'Voice input needs speech recognition: this browser has none and the engine has no speech-to-text yet. Type instead.');
    setMode('idle');
  }

  async function startRecording(stream) {
    let media;
    try {
      media = await getUserMedia({ audio: true });
    } catch (error) {
      addMessage('error', describeMicError(error));
      return setMode('idle');
    }
    let recorder;
    try {
      // The engine decodes webm/opus. Safari records another format, so say so rather than send audio the engine cannot read.
      const mimeType = 'audio/webm;codecs=opus';
      if (typeof MediaRecorderImpl.isTypeSupported === 'function' && !MediaRecorderImpl.isTypeSupported(mimeType)) {
        throw Object.assign(new Error('unsupported type'), { name: 'NotSupportedError' });
      }
      recorder = new MediaRecorderImpl(media, { mimeType });
    } catch (error) {
      media.getTracks().forEach((track) => track.stop());
      addMessage('error', describeMicError(error.name === 'NotSupportedError' ? error : { name: 'NotSupportedError' }));
      return setMode('idle');
    }
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
    try {
      recorder.start(250);
    } catch (error) {
      voice.recorder = null;
      voice.media = null;
      media.getTracks().forEach((track) => track.stop());
      addMessage('error', describeMicError(error));
      return setMode('idle');
    }
    setMode('listening');
  }

  // openStream: a stream that is already open (the engine said it transcribes but this path is the fallback). Without one the
  // connection is made alongside the recognition.
  function startRecognition(openStream = null) {
    let recognition;
    try {
      recognition = new Recognition();
    } catch (error) {
      addMessage('error', describeRecognitionError('start-failed'));
      return setMode('idle');
    }
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
      const text = describeRecognitionError(event && event.error);
      // Hearing nothing is not a failure, so it is a quiet note in the log rather than a red error.
      if (text) addMessage(event && event.error === 'no-speech' ? 'system' : 'error', text);
    };

    voice.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      voice.recognition = null;
      addMessage('error', describeRecognitionError(error && error.name === 'NotAllowedError' ? 'not-allowed' : 'start-failed'));
      return setMode('idle');
    }
    setMode('listening');

    // The connection, made while the person speaks. A failure is reported once, here.
    const connecting = openStream
      ? Promise.resolve(openStream)
      : ensureVoice(true).catch((error) => {
          stopCapture(false);
          handleError(error);
          return null;
        });

    const deliver = (text, stream) => {
      if (stream && stream.isOpen && !view.halted) {
        stream.sendText(text);
        return;
      }
      // No usable connection: either it failed (already reported) or it closed under us.
      view.busy = false;
      if (stream && !view.halted) addMessage('error', 'The voice stream closed before your words were sent. Try again.');
      if (view.halted) setMode('halted');
      else if (view.mode !== 'offline') setMode('idle');
      else render();
    };

    recognition.onend = () => {
      if (voice.recognition !== recognition) return;
      voice.recognition = null;
      const text = finalText.trim();
      if (!text || view.halted) {
        interim.hidden = true;
        setMode(view.halted ? 'halted' : 'idle');
        return;
      }
      view.busy = true;
      setMode('thinking');
      // Already connected (the next utterance): send now. Otherwise as soon as the connection is up.
      if (voice.stream && voice.stream.isOpen && voice.ready) deliver(text, voice.stream);
      else connecting.then((stream) => deliver(text, stream));
    };
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
    if (!canSpeak || !text.trim()) return setMode('idle');
    const utterance = new Utterance(text);
    utterance.onend = () => {
      if (view.mode === 'speaking') setMode('idle');
    };
    utterance.onerror = (event) => {
      if (view.mode === 'speaking') setMode('idle');
      // The browser refused to speak (iPhone Safari until something has spoken from a tap): say how to allow it.
      if (event && event.error === 'not-allowed') {
        primed = false;
        addMessage('system', 'Your browser would not speak that reply. Tap the speaker button once, then try again.');
      }
    };
    try {
      synth.cancel();
      setMode('speaking');
      synth.speak(utterance);
    } catch {
      setMode('idle');
      addMessage('system', 'Could not speak that reply.');
    }
  }

  function stopSpeaking() {
    if (synth && view.mode === 'speaking') synth.cancel();
  }

  micButton.addEventListener('click', () => {
    if (voice.recognition || voice.recorder) {
      stopCapture(true);
      render();
    } else if (!canListen) {
      addMessage('error', NO_LISTEN_TEXT);
    } else if (!view.busy && !view.halted) {
      // An error that escapes (a connection or browser failure) is shown, never swallowed.
      startListening().catch(handleError);
    }
  });

  speakButton.addEventListener('click', () => {
    if (!canSpeak) {
      addMessage('system', NO_SPEAK_TEXT);
      return;
    }
    speakReplies = !speakReplies;
    storage.set(SPEAK_STORAGE_KEY, String(speakReplies));
    if (speakReplies) {
      // From this tap, so replies that arrive later can be heard on iPhone.
      prime();
    } else {
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
    if (thread() === 'main') {
      sessionId = createSessionId();
      storage.set(SESSION_STORAGE_KEY, sessionId);
    } else {
      threadSessions[thread()] = 'thread-' + thread() + '-' + Date.now().toString(36);
    }
    // A new session starts the conversation over: the saved thread goes too, so a reload does not bring the old one back.
    if (history) history.clear(thread());
    replay = null;
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

  // The scopes on offer (the page being looked at, the project open) and the one chosen. A chosen scope that is no longer on offer
  // falls back to "Everything" rather than naming something that is gone.
  function setScopes(list, selectedId = scope) {
    scopes = Array.isArray(list) ? list.filter((s) => s && s.id && s.label) : [];
    scope = scopes.some((s) => s.id === selectedId) ? selectedId : null;
    renderScopes();
    if (history && thread() !== loadedThread) loadThread();
  }

  function setScope(id) {
    scope = id !== null && scopes.some((s) => s.id === id) ? id : null;
    renderScopes();
    if (history && thread() !== loadedThread) loadThread();
  }

  render();
  loadThread();

  return {
    setScopes,
    setScope,
    getScope: () => scope,
    // Sends a typed turn as if entered in the dock (Mission Control's command bar). False while busy or halted.
    send(text) {
      const value = String(text || '').trim();
      if (!value || view.busy || view.halted) return false;
      sendTyped(value);
      return true;
    },
    getMode: () => view.mode,
    getSessionId: () => sessionId,
    getThread: thread,
    loadThread,
    elements: { panel, avatar, status, log, input, form, micButton, speakButton, sendButton, newButton, interim, hint, scopeBar },
    destroy() {
      onPageHide();
      win.removeEventListener('pagehide', onPageHide);
      unsubscribe();
      container.replaceChildren();
    },
  };
}
