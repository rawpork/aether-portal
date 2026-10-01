import { afterEach, describe, expect, it } from 'vitest';
import { createEngineApi, onEngineState } from '../../src/services/engineApi.ts';
import { buildVoiceStreamUrl, CLOSE_HALTED, connectVoiceStream, VoiceStreamError } from '../../src/services/voiceStream.ts';
import type { VoiceServerFrame } from '../../src/services/voiceStream.ts';

// Minimal browser-style WebSocket the tests drive by hand.
class FakeSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static last: FakeSocket;
	url: string;
	protocols: string[];
	readyState = 0;
	binaryType = 'blob';
	sent: unknown[] = [];

	constructor(url: string, protocols: string[]) {
		super();
		this.url = url;
		this.protocols = protocols;
		FakeSocket.last = this;
	}
	send(data: unknown) {
		this.sent.push(data);
	}
	close(code = 1000, reason = '') {
		this.serverClose(code, reason);
	}
	serverOpen() {
		this.readyState = 1;
		this.dispatchEvent(new Event('open'));
	}
	serverSend(frame: unknown) {
		this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
	}
	serverClose(code: number, reason = '') {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
	}
}

const WS = FakeSocket as unknown as typeof WebSocket;
const READY = { type: 'ready', session_id: 's1', agent_id: 'master-brain', format: 'webm-opus', sample_rate: null, stt: false, tts: false };

describe('voiceStream', () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	it('builds the engine URL from the HTTP base', () => {
		expect(buildVoiceStreamUrl('http://localhost:3333', { sessionId: 'a b', agentId: 'mb' })).toBe(
			'ws://localhost:3333/api/voice/stream?session_id=a+b&agent_id=mb&format=webm-opus',
		);
		expect(buildVoiceStreamUrl('https://engine.test/', { sessionId: 's', format: 'pcm16', sampleRate: 16000 })).toBe(
			'wss://engine.test/api/voice/stream?session_id=s&format=pcm16&sample_rate=16000',
		);
	});

	it('authenticates with the bearer subprotocol through the engine client', async () => {
		const api = createEngineApi({ baseUrl: 'http://localhost:3333', getToken: () => 'jwt.token.sig' });
		const stream = api.openVoiceStream({ sessionId: 's1', WebSocketImpl: WS });
		expect(FakeSocket.last.url).toBe('ws://localhost:3333/api/voice/stream?session_id=s1&format=webm-opus');
		expect(FakeSocket.last.protocols).toEqual(['aether-voice', 'bearer.jwt.token.sig']);
		FakeSocket.last.serverOpen();
		FakeSocket.last.serverSend(READY);
		await expect(stream.ready).resolves.toMatchObject({ type: 'ready', stt: false });
	});

	it('omits the bearer subprotocol without a token', () => {
		connectVoiceStream({ baseUrl: 'http://localhost:3333', token: null, sessionId: 's', WebSocketImpl: WS });
		expect(FakeSocket.last.protocols).toEqual(['aether-voice']);
	});

	it('sends client frames and relays server frames', async () => {
		const frames: VoiceServerFrame[] = [];
		const stream = connectVoiceStream({ baseUrl: 'http://x', token: null, sessionId: 's', WebSocketImpl: WS }, { onFrame: (f) => frames.push(f) });
		const socket = FakeSocket.last;
		expect(() => stream.sendText('early')).toThrow('not open');
		socket.serverOpen();
		socket.serverSend(READY);
		await stream.ready;

		const chunk = new Uint8Array([1, 2, 3]);
		stream.sendAudio(chunk);
		stream.endUtterance();
		stream.sendText('hello');
		stream.cancel();
		expect(socket.sent).toEqual([chunk, '{"type":"end_utterance"}', '{"type":"text","text":"hello"}', '{"type":"cancel"}']);
		expect(() => stream.sendText('  ')).toThrow(TypeError);

		socket.serverSend({ type: 'response', text: 'hi', tokens: { input: 1, output: 2 }, status: 'ACTIVE' });
		socket.dispatchEvent(Object.assign(new Event('message'), { data: 'not json' }));
		expect(frames.map((f) => f.type)).toEqual(['ready', 'response']);
	});

	it('rejects ready and reports halted when the engine closes with 4423', async () => {
		const events: string[] = [];
		stop = onEngineState((d) => events.push(d.agentId + ':' + d.state + ':' + d.source));
		const closes: unknown[] = [];
		const stream = connectVoiceStream(
			{ baseUrl: 'http://x', token: null, sessionId: 's', agentId: 'mb', WebSocketImpl: WS },
			{ onClose: (info) => closes.push(info) },
		);
		FakeSocket.last.serverOpen();
		FakeSocket.last.serverSend({ type: 'error', code: 'AGENT_HALTED', message: 'Agent execution is currently HALTED by circuit breaker', agent_id: 'mb', reason: 'stop' });
		FakeSocket.last.serverClose(CLOSE_HALTED, 'Agent HALTED');

		const error = await stream.ready.catch((e) => e);
		expect(error).toBeInstanceOf(VoiceStreamError);
		expect(error.halted).toBe(true);
		expect(closes).toEqual([{ code: 4423, reason: 'Agent HALTED', halted: true }]);
		expect(events).toEqual(['mb:HALTED:voice']);
	});

	it('rejects ready when the handshake fails', async () => {
		const stream = connectVoiceStream({ baseUrl: 'http://x', token: 'bad', sessionId: 's', WebSocketImpl: WS });
		FakeSocket.last.serverClose(1006);
		const error = await stream.ready.catch((e) => e);
		expect(error.halted).toBe(false);
		expect(error.message).toMatch(/offline, or the token was rejected/);
	});
});
