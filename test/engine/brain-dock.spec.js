// Master Brain dock against the real client bundle: HTTP answered by a simulated engine, the voice WebSocket
// by a scripted fake, and the browser speech APIs by fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi, onEngineState } from '../../public/js/engine-api.bundle.js';
import { SESSION_STORAGE_KEY, SPEAK_STORAGE_KEY, mountBrainDock } from '../../public/js/engine/brain-dock.js';

const AGENT = 'master-brain';
const TOKENS = { input: 120, output: 40 };

function createEngine() {
  const engine = {
    state: 'ACTIVE',
    reason: undefined,
    chatStatus: 200,
    offline: false,
    calls: [],
    async fetch(url, init = {}) {
      const path = new URL(url).pathname;
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      engine.calls.push({ method, path, body });
      const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (engine.offline) throw new TypeError('Failed to fetch');
      if (path === '/api/agents/' + AGENT + '/state') return reply(200, { agent_id: AGENT, state: engine.state, reason: engine.reason });
      if (path === '/api/agents/reset') {
        engine.state = 'ACTIVE';
        return reply(200, { status: 'ACTIVE', reset: true, logged: true, timestamp: 't' });
      }
      if (path === '/api/master-brain/chat') {
        if (engine.state === 'HALTED') {
          return reply(423, { error: 'Agent execution is currently HALTED by circuit breaker', agent_id: AGENT, status: 'HALTED', reason: engine.reason });
        }
        if (engine.chatStatus === 401) return reply(401, { error: 'Invalid token signature.' });
        if (engine.chatStatus === 409) return reply(409, { error: 'A message for this session is already being processed.' });
        return reply(200, { session_id: body.session_id, response: 'Reply to: ' + body.message, tokens: TOKENS, status: 'ACTIVE' });
      }
      return reply(404, { error: 'not found' });
    },
  };
  return engine;
}

// Scripted engine voice socket: opens, sends `ready`, and answers text frames like the real engine.
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static readyFrame = { stt: false, tts: false };
  static autoReply = true;
  // true: the socket stays connecting until the test calls open() (a slow link to the engine).
  static hold = false;

  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (!FakeSocket.hold) this.open();
    });
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    this.serverSend({ type: 'ready', session_id: 's', agent_id: AGENT, format: 'webm-opus', sample_rate: null, ...FakeSocket.readyFrame });
  }
  send(data) {
    this.sent.push(data);
    if (typeof data !== 'string' || !FakeSocket.autoReply) return;
    const frame = JSON.parse(data);
    if (frame.type === 'text') this.answer(frame.text, 'client');
    if (frame.type === 'end_utterance') this.answer('transcribed audio', 'stt');
  }
  answer(text, source) {
    queueMicrotask(() => {
      this.serverSend({ type: 'transcript', text, source });
      this.serverSend({ type: 'response', text: 'Voice reply to: ' + text, tokens: TOKENS, status: 'ACTIVE' });
      if (FakeSocket.readyFrame.tts) this.serverSend({ type: 'audio', format: 'webm-opus', sample_rate: null, data: btoa('fake-audio') });
    });
  }
  close(code = 1000, reason = '') {
    this.serverClose(code, reason);
  }
  serverSend(frame) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  }
  serverClose(code, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
}

class FakeRecognition {
  static last = null;
  // An error name: start() throws it, like a browser that refuses to start.
  static throwOnStart = null;
  constructor() {
    this.started = false;
    FakeRecognition.last = this;
  }
  start() {
    if (FakeRecognition.throwOnStart) throw Object.assign(new Error('refused'), { name: FakeRecognition.throwOnStart });
    this.started = true;
  }
  stop() {
    this.onend && this.onend();
  }
  abort() {
    this.aborted = true;
    this.onend && this.onend();
  }
  // Test helper: deliver a recognition result, then end like a browser does after a pause.
  say(text) {
    const result = Object.assign([{ transcript: text }], { isFinal: true });
    this.onresult({ results: [result] });
    this.onend();
  }
}

class FakeRecorder {
  static last = null;
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    FakeRecorder.last = this;
  }
  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable({ data: new Blob(['last-chunk']) });
    this.onstop();
  }
}

// What the dock really said aloud: the silent utterance that unlocks speech on iPhone is not a reply.
const spokenReplies = () => synth.spoken.filter((u) => !u.isPrime);

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let engine, store, synth, dock, slot, played, events, stopEvents;

function mount(extra = {}) {
  const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch, getToken: () => 'header.payload.sig' });
  // Route the dock's voice stream through the fake socket.
  const wrapped = { ...api, openVoiceStream: (options, handlers) => api.openVoiceStream({ ...options, WebSocketImpl: FakeSocket }, handlers) };
  slot = document.createElement('div');
  document.body.append(slot);
  dock = mountBrainDock(slot, {
    api: wrapped,
    storage: { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v) },
    Recognition: FakeRecognition,
    synth,
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    MediaRecorder: FakeRecorder,
    getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
    playAudio: (frame) => {
      played.push(frame);
      return Promise.resolve();
    },
    ...extra,
  });
  return dock;
}

const messages = () => [...dock.elements.log.querySelectorAll('.brain-msg')].map((li) => li.className.replace('brain-msg brain-', '') + ': ' + li.querySelector('.brain-text').textContent);
const type = async (text) => {
  dock.elements.input.value = text;
  dock.elements.form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
};

beforeEach(() => {
  engine = createEngine();
  store = new Map();
  played = [];
  synth = { spoken: [], speak: vi.fn((u) => synth.spoken.push(u)), cancel: vi.fn() };
  FakeSocket.instances = [];
  FakeSocket.readyFrame = { stt: false, tts: false };
  FakeSocket.autoReply = true;
  FakeSocket.hold = false;
  FakeRecognition.throwOnStart = null;
  FakeRecorder.isTypeSupported = undefined;
  events = [];
  stopEvents = onEngineState((d) => events.push(d.state + ':' + d.source));
});

afterEach(() => {
  dock && dock.destroy();
  slot && slot.remove();
  stopEvents();
  dock = slot = null;
});

describe('dock shell', () => {
  it('renders inline into its container, always open, with no toggle or close button', () => {
    const { panel } = mount().elements;
    expect(slot.firstChild).toBe(panel);
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('h2').textContent).toBe('Elarion');
    expect([...panel.querySelectorAll('button')].map((b) => b.className)).toEqual([
      'brain-icon-btn brain-new',
      'brain-icon-btn brain-mic',
      'brain-icon-btn brain-speak',
      'brain-send',
    ]);
  });

  it('keeps one session id across reloads and starts a new one on demand', async () => {
    mount();
    const first = dock.getSessionId();
    expect(first).toMatch(/^portal-/);
    expect(store.get(SESSION_STORAGE_KEY)).toBe(first);
    dock.destroy();
    mount();
    expect(dock.getSessionId()).toBe(first);

    await type('hello');
    dock.elements.newButton.click();
    expect(dock.getSessionId()).not.toBe(first);
    expect(store.get(SESSION_STORAGE_KEY)).toBe(dock.getSessionId());
    expect(messages()).toEqual(['system: New session started.']);
  });
});

describe('typed chat', () => {
  it('sends to /api/master-brain/chat and shows the reply with token usage (200)', async () => {
    mount();
    await type('What is the breaker state?');
    const chat = engine.calls.find((c) => c.path === '/api/master-brain/chat');
    expect(chat.body).toEqual({ session_id: dock.getSessionId(), message: 'What is the breaker state?', agent_id: AGENT });
    expect(messages()).toEqual(['user: What is the breaker state?', 'assistant: Reply to: What is the breaker state?']);
    expect(dock.elements.log.querySelector('.brain-assistant .brain-meta').textContent).toBe('120 in / 40 out');
    expect(dock.getMode()).toBe('idle');
    expect(dock.elements.input.value).toBe('');
  });

  it('shows HALTED on a 423, locks input, and recovers when the agent is reset', async () => {
    engine.state = 'HALTED';
    engine.reason = 'Operator manual trip from Portal UI';
    mount();
    await type('Are you there?');
    expect(dock.getMode()).toBe('halted');
    expect(dock.elements.avatar.dataset.mode).toBe('halted');
    expect(messages().at(-1)).toBe('system: Halted by the circuit breaker: Operator manual trip from Portal UI. Reset the agent from the top bar to continue.');
    expect(dock.elements.sendButton.disabled).toBe(true);
    expect(dock.elements.micButton.disabled).toBe(true);
    expect(events).toContain('HALTED:halted-response');

    // The breaker bar's reset goes through the same client and broadcasts ACTIVE.
    await createEngineApi({ baseUrl: 'http://localhost:3333', fetch: engine.fetch }).resetBreaker(AGENT);
    expect(dock.getMode()).toBe('idle');
    expect(messages().at(-1)).toBe('system: Agent reset. Elarion is active again.');
    expect(dock.elements.sendButton.disabled).toBe(false);
  });

  it('explains auth, busy and offline failures', async () => {
    mount();
    engine.chatStatus = 401;
    await type('a');
    expect(messages().at(-1)).toBe('error: The engine rejected the token (Invalid token signature): the portal and the engine use different secrets. Set the Worker’s ENGINE_JWT_SECRET to the engine’s SUPABASE_JWT_SECRET.');
    engine.chatStatus = 409;
    await type('b');
    expect(messages().at(-1)).toBe('error: Still answering the previous message.');
    engine.offline = true;
    await type('c');
    expect(messages().at(-1)).toMatch(/Can’t reach the Aether Engine at http:\/\/localhost:3333/);
    expect(dock.getMode()).toBe('offline');
  });
});

describe('Elarion voice dock: starting, permissions and failures', () => {
  it('starts recognition inside the tap, before the engine connection is up, and sends the words once it is', async () => {
    FakeSocket.hold = true;
    mount();
    dock.elements.micButton.click();
    // No await: the browser only lets recognition start while the tap is fresh.
    expect(FakeRecognition.last.started).toBe(true);
    expect(dock.getMode()).toBe('listening');
    await flush();
    const socket = FakeSocket.instances[0];
    expect(socket.readyState).toBe(0);
    expect(dock.getMode()).toBe('listening');

    FakeRecognition.last.say('hello there');
    expect(dock.getMode()).toBe('thinking');
    expect(socket.sent).toEqual([]);
    socket.open();
    await flush();
    expect(socket.sent).toEqual(['{"type":"text","text":"hello there"}']);
    expect(messages()).toEqual(['user: hello there', 'assistant: Voice reply to: hello there']);
  });

  it('reports a connection failure while listening, stops listening, and leaves the mic usable', async () => {
    engine.offline = true;
    mount();
    dock.elements.micButton.click();
    expect(FakeRecognition.last.started).toBe(true);
    await flush();
    expect(messages().at(-1)).toMatch(/^error: Can’t reach the Aether Engine/);
    expect(FakeRecognition.last.aborted).toBe(true);
    expect(dock.getMode()).toBe('offline');
    expect(dock.elements.micButton.disabled).toBe(false);
    expect(dock.elements.micButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not stay busy if the connection fails after the words were spoken', async () => {
    FakeSocket.hold = true;
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeRecognition.last.say('anyone there');
    expect(dock.getMode()).toBe('thinking');
    FakeSocket.instances[0].serverClose(1006, 'gone');
    await flush();
    expect(dock.elements.micButton.disabled).toBe(false);
    expect(dock.elements.input.disabled).toBe(false);
    expect(dock.getMode()).not.toBe('thinking');
  });

  it('says so when the browser refuses to start recognition, and when it is blocked', async () => {
    FakeRecognition.throwOnStart = 'NotAllowedError';
    mount();
    dock.elements.micButton.click();
    await flush();
    expect(messages().at(-1)).toMatch(/^error: The microphone or speech recognition is blocked\. Allow the microphone for this site/);
    expect(dock.getMode()).toBe('idle');
    expect(dock.elements.micButton.disabled).toBe(false);
    FakeRecognition.throwOnStart = 'InvalidStateError';
    dock.elements.micButton.click();
    await flush();
    expect(messages().at(-1)).toMatch(/^error: Speech recognition failed \(start-failed\)\. Type instead\./);
  });

  it.each([
    ['not-allowed', 'error', /blocked\. Allow the microphone/],
    ['service-not-allowed', 'error', /blocked\. Allow the microphone/],
    ['audio-capture', 'error', /No microphone was found/],
    ['network', 'error', /could not reach its service/],
    ['language-not-supported', 'error', /does not support your language/],
    ['no-speech', 'system', /I did not hear anything/],
    ['surprise', 'error', /Speech recognition failed \(surprise\)/],
  ])('explains a recognition error: %s', async (code, kind, text) => {
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeRecognition.last.onerror({ error: code });
    FakeRecognition.last.onend();
    expect(messages().at(-1)).toMatch(new RegExp('^' + kind + ': '));
    expect(messages().at(-1)).toMatch(text);
    expect(dock.getMode()).toBe('idle');
    expect(dock.elements.micButton.disabled).toBe(false);
  });

  it('stays quiet when recognition was stopped on purpose (aborted)', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();
    const before = messages().length;
    FakeRecognition.last.onerror({ error: 'aborted' });
    FakeRecognition.last.onend();
    expect(messages()).toHaveLength(before);
  });

  it.each([
    ['NotAllowedError', /^error: Microphone access was blocked\. Allow it for this site/],
    ['NotFoundError', /^error: No microphone was found\./],
    ['NotReadableError', /^error: The microphone is being used by another app\./],
    ['SomethingElse', /^error: Could not start the microphone: refused/],
  ])('explains why the microphone could not open for the engine\'s transcription: %s', async (name, text) => {
    FakeSocket.readyFrame = { stt: true, tts: false };
    mount({ Recognition: null, getUserMedia: async () => { throw Object.assign(new Error('refused'), { name }); } });
    dock.elements.micButton.click();
    await flush();
    expect(messages().at(-1)).toMatch(text);
    expect(dock.getMode()).toBe('idle');
    expect(FakeRecorder.last).toBeNull();
  });

  it('releases the microphone and says so when the browser cannot record the format the engine needs', async () => {
    FakeSocket.readyFrame = { stt: true, tts: false };
    FakeRecorder.isTypeSupported = () => false;
    const stop = vi.fn();
    mount({ Recognition: null, getUserMedia: async () => ({ getTracks: () => [{ stop }] }) });
    dock.elements.micButton.click();
    await flush();
    expect(messages().at(-1)).toMatch(/^error: This browser cannot record audio in the format the engine needs/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dock.getMode()).toBe('idle');
  });

  it('uses engine transcription on the next tap once the engine is known to offer it', async () => {
    FakeSocket.readyFrame = { stt: true, tts: false };
    mount();
    // First tap: the engine is not known yet, so browser recognition starts straight away.
    dock.elements.micButton.click();
    await flush();
    expect(FakeRecognition.last.started).toBe(true);
    FakeRecognition.last.say('first');
    await flush();
    // Second tap: it is known to transcribe, so the microphone is streamed instead.
    dock.elements.micButton.click();
    await flush();
    expect(FakeRecorder.last.state).toBe('recording');
  });
});

describe('Elarion voice dock: browser support and the speaker toggle', () => {
  it('disables the mic, with the reason in plain sight, where nothing can listen', () => {
    mount({ Recognition: null, MediaRecorder: null });
    expect(dock.elements.micButton.disabled).toBe(true);
    expect(dock.elements.micButton.title).toMatch(/needs a browser with speech recognition/);
    expect(dock.elements.hint.textContent).toMatch(/needs a browser with speech recognition/);
    dock.elements.micButton.click();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('disables the speaker button, with the reason, where nothing can speak', () => {
    mount({ synth: null });
    expect(dock.elements.speakButton.disabled).toBe(true);
    expect(dock.elements.speakButton.title).toBe('This browser cannot speak replies.');
    expect(dock.elements.speakButton.getAttribute('aria-pressed')).toBe('false');
    expect(dock.elements.speakButton.textContent).toBe('🔈');
    // A voice reply is not lost: it is still shown as text.
    expect(dock.elements.micButton.disabled).toBe(false);
  });

  it('toggles cleanly: the preference, the icon, the title and aria-pressed always agree', () => {
    mount();
    const b = dock.elements.speakButton;
    const state = () => [store.get(SPEAK_STORAGE_KEY) ?? null, b.getAttribute('aria-pressed'), b.textContent, /muted/.test(b.title) ? 'muted' : 'spoken'];
    expect(state()).toEqual([null, 'true', '🔊', 'spoken']);
    b.click();
    expect(state()).toEqual(['false', 'false', '🔈', 'muted']);
    b.click();
    expect(state()).toEqual(['true', 'true', '🔊', 'spoken']);
  });

  it('unlocks speech once from the tap: a silent utterance on the mic, and none while muted', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]).toMatchObject({ isPrime: true, volume: 0, text: ' ' });
    FakeRecognition.last.say('hi');
    await flush();
    dock.elements.micButton.click();
    await flush();
    // Primed once, then one real reply: no second silent utterance.
    expect(synth.spoken.filter((u) => u.isPrime)).toHaveLength(1);
    expect(spokenReplies()).toHaveLength(1);
  });

  it('turning replies on again primes from that tap, when the mic had not done so', () => {
    store.set(SPEAK_STORAGE_KEY, 'false');
    mount();
    expect(synth.speak).not.toHaveBeenCalled();
    dock.elements.speakButton.click();
    expect(synth.spoken.filter((u) => u.isPrime)).toHaveLength(1);
    dock.elements.speakButton.click();
    dock.elements.speakButton.click();
    expect(synth.spoken.filter((u) => u.isPrime)).toHaveLength(1);
  });

  it('says what to do when the browser refuses to speak a reply', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeRecognition.last.say('speak to me');
    await flush();
    spokenReplies()[0].onerror({ error: 'not-allowed' });
    expect(messages().at(-1)).toBe('system: Your browser would not speak that reply. Tap the speaker button once, then try again.');
    expect(dock.getMode()).toBe('idle');
  });

  it('survives a synthesizer that throws', async () => {
    synth.speak = vi.fn(() => { throw new Error('no voices'); });
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeRecognition.last.say('anything');
    await flush();
    expect(messages().at(-1)).toBe('system: Could not speak that reply.');
    expect(dock.getMode()).toBe('idle');
  });
});

describe('Elarion voice dock', () => {
  it('uses browser speech recognition when the engine has no STT, then speaks the reply', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();

    expect(engine.calls[0].path).toBe('/api/agents/' + AGENT + '/state');
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:3333/api/voice/stream?session_id=' + dock.getSessionId() + '&agent_id=master-brain&format=webm-opus');
    expect(socket.protocols).toEqual(['aether-voice', 'bearer.header.payload.sig']);
    expect(FakeRecognition.last.started).toBe(true);
    expect(dock.getMode()).toBe('listening');
    expect(dock.elements.micButton.getAttribute('aria-pressed')).toBe('true');
    expect(dock.elements.hint.textContent).toMatch(/your browser transcribes/);

    FakeRecognition.last.say('give me a status report');
    expect(socket.sent).toEqual(['{"type":"text","text":"give me a status report"}']);
    expect(dock.getMode()).toBe('thinking');
    await flush();

    expect(messages()).toEqual(['user: give me a status report', 'assistant: Voice reply to: give me a status report']);
    expect([...dock.elements.log.querySelectorAll('.brain-meta')].map((m) => m.textContent)).toEqual(['voice', 'voice · 120 in / 40 out']);
    expect(spokenReplies()).toHaveLength(1);
    expect(spokenReplies()[0].text).toBe('Voice reply to: give me a status report');
    expect(dock.getMode()).toBe('speaking');
    spokenReplies()[0].onend();
    expect(dock.getMode()).toBe('idle');

    // The stream stays open for the next utterance.
    dock.elements.micButton.click();
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('streams microphone audio when the engine reports STT, ending the utterance on stop', async () => {
    FakeSocket.readyFrame = { stt: true, tts: false };
    // No browser speech recognition, so the engine's transcription is the way to talk.
    mount({ Recognition: null });
    dock.elements.micButton.click();
    await flush();
    const recorder = FakeRecorder.last;
    expect(recorder.state).toBe('recording');
    expect(recorder.options.mimeType).toBe('audio/webm;codecs=opus');
    expect(dock.elements.hint.textContent).toBe('Voice: the engine transcribes your audio.');

    recorder.ondataavailable({ data: new Blob(['chunk-1']) });
    dock.elements.micButton.click();
    await flush();
    const socket = FakeSocket.instances[0];
    expect(socket.sent.slice(0, 2).every((d) => d instanceof Blob)).toBe(true);
    expect(socket.sent[2]).toBe('{"type":"end_utterance"}');
    expect(messages()).toEqual(['user: transcribed audio', 'assistant: Voice reply to: transcribed audio']);
  });

  it('plays the engine’s TTS audio instead of browser speech when available', async () => {
    FakeSocket.readyFrame = { stt: false, tts: true };
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeRecognition.last.say('hello');
    await flush();
    expect(played).toHaveLength(1);
    expect(atob(played[0].data)).toBe('fake-audio');
    expect(spokenReplies()).toHaveLength(0);
    expect(dock.getMode()).toBe('idle');
  });

  it('stays quiet when spoken replies are muted', async () => {
    mount();
    dock.elements.speakButton.click();
    expect(store.get(SPEAK_STORAGE_KEY)).toBe('false');
    dock.elements.micButton.click();
    await flush();
    FakeRecognition.last.say('quiet please');
    await flush();
    // Muted: nothing is spoken, and nothing is primed either.
    expect(synth.speak).not.toHaveBeenCalled();
    expect(dock.getMode()).toBe('idle');
  });

  it('goes HALTED when the engine halts the stream (AGENT_HALTED + close 4423)', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeSocket.autoReply = false;
    FakeRecognition.last.say('one more thing');
    expect(dock.getMode()).toBe('thinking');
    const socket = FakeSocket.instances[0];
    socket.serverSend({ type: 'error', code: 'AGENT_HALTED', message: 'Agent execution is currently HALTED by circuit breaker', agent_id: AGENT, reason: 'Tripped from the bar' });
    socket.serverClose(4423, 'Agent HALTED');
    await flush();
    expect(dock.getMode()).toBe('halted');
    expect(messages().at(-1)).toBe('system: Halted by the circuit breaker: Tripped from the bar. Reset the agent from the top bar to continue.');
    expect(events).toContain('HALTED:voice');
    expect(dock.elements.micButton.disabled).toBe(true);
  });

  it('does not open a stream when the pre-check finds the agent HALTED', async () => {
    engine.state = 'HALTED';
    mount();
    dock.elements.micButton.click();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(dock.getMode()).toBe('halted');
  });

  it('reports engine voice errors such as STT_UNAVAILABLE', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();
    FakeSocket.instances[0].serverSend({ type: 'error', code: 'STT_UNAVAILABLE', message: 'No speech-to-text provider is configured.' });
    expect(messages().at(-1)).toBe('error: The engine has no speech-to-text yet. Type instead.');
  });

  it('closes the voice stream and stops listening when the page is hidden', async () => {
    mount();
    dock.elements.micButton.click();
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    expect(FakeRecognition.last.aborted).toBe(true);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    expect(dock.getMode()).toBe('idle');
  });

  it('explains when neither the browser nor the engine can transcribe', async () => {
    mount({ Recognition: null });
    dock.elements.micButton.click();
    await flush();
    expect(messages().at(-1)).toMatch(/^error: Voice input needs speech recognition/);
  });
});

describe('scope chips', () => {
  it('shows what the conversation is about, tags the question, and sends the scope with it', async () => {
    mount();
    expect(dock.elements.scopeBar.hidden).toBe(true);
    dock.setScopes([{ id: 'page', label: 'Marketing', context: { page: 'Marketing' } }], 'page');
    expect(dock.elements.scopeBar.hidden).toBe(false);
    expect([...dock.elements.scopeBar.querySelectorAll('.brain-chip')].map((c) => c.textContent + ':' + c.getAttribute('aria-pressed'))).toEqual(['Marketing:true', 'Everything:false']);
    await type('How is it going?');
    const chat = engine.calls.find((c) => c.path === '/api/master-brain/chat');
    expect(chat.body.context).toEqual({ asking_about: 'Marketing', page: 'Marketing' });
    expect(dock.elements.log.querySelector('.brain-user .brain-scope-tag').textContent).toBe('Asking about: Marketing');
    dock.elements.scopeBar.querySelector('[data-scope=""]').click();
    expect(dock.getScope()).toBe(null);
    await type('And overall?');
    const second = engine.calls.filter((c) => c.path === '/api/master-brain/chat')[1];
    expect(second.body.context).toBeUndefined();
  });
});
