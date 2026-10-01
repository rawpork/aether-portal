// Typed client for the engine's voice WebSocket (Aether_Engine/src/voice.ts):
//   ws://<engine>/api/voice/stream?session_id=<id>&agent_id=<id>&format=webm-opus|pcm16&sample_rate=<hz>
// Browsers cannot set headers on a WebSocket, so the JWT rides in the subprotocol list
// ["aether-voice", "bearer.<jwt>"]; the engine selects only "aether-voice".
// Open it through createEngineApi().openVoiceStream(), which supplies the base URL and token.

import { emitState } from './engineEvents.ts';

export type VoiceAudioFormat = 'webm-opus' | 'pcm16';

export const VOICE_STREAM_PATH = '/api/voice/stream';
export const VOICE_SUBPROTOCOL = 'aether-voice';
// Close code the engine uses when the agent's breaker is tripped.
export const CLOSE_HALTED = 4423;

export interface VoiceReadyFrame {
	type: 'ready';
	session_id: string;
	agent_id: string;
	format: VoiceAudioFormat;
	sample_rate: number | null;
	// Whether the engine can transcribe audio / synthesize speech itself.
	stt: boolean;
	tts: boolean;
}

export interface VoiceTranscriptFrame {
	type: 'transcript';
	text: string;
	source: 'stt' | 'client';
}

export interface VoiceResponseFrame {
	type: 'response';
	text: string;
	tokens: { input: number; output: number };
	status: 'ACTIVE';
}

export interface VoiceAudioFrame {
	type: 'audio';
	format: VoiceAudioFormat;
	sample_rate: number | null;
	// base64-encoded audio in `format`.
	data: string;
}

export type VoiceErrorCode =
	| 'AGENT_HALTED'
	| 'BAD_FRAME'
	| 'BUSY'
	| 'EMPTY_UTTERANCE'
	| 'EMPTY_TRANSCRIPT'
	| 'STT_UNAVAILABLE'
	| 'UTTERANCE_TOO_LARGE'
	| 'TURN_FAILED';

export interface VoiceErrorFrame {
	type: 'error';
	code: VoiceErrorCode;
	message: string;
	agent_id?: string;
	status?: string | number;
	halted_at?: string;
	reason?: string;
}

export type VoiceServerFrame = VoiceReadyFrame | VoiceTranscriptFrame | VoiceResponseFrame | VoiceAudioFrame | VoiceErrorFrame;

export interface VoiceCloseInfo {
	code: number;
	reason: string;
	// True when the engine closed the stream because the agent is HALTED.
	halted: boolean;
}

export interface VoiceStreamHandlers {
	onFrame?(frame: VoiceServerFrame): void;
	onClose?(info: VoiceCloseInfo): void;
}

export interface VoiceStreamOptions {
	sessionId: string;
	agentId?: string;
	format?: VoiceAudioFormat;
	// Required by the engine for pcm16 (8000-48000); ignored for webm-opus.
	sampleRate?: number;
	WebSocketImpl?: typeof WebSocket;
}

export interface VoiceStreamConfig extends VoiceStreamOptions {
	baseUrl: string;
	token: string | null | undefined;
}

export class VoiceStreamError extends Error {
	readonly code: number;
	readonly halted: boolean;

	constructor(message: string, code: number, halted: boolean) {
		super(message);
		this.name = 'VoiceStreamError';
		this.code = code;
		this.halted = halted;
	}
}

export interface VoiceStream {
	// Resolves with the engine's ready frame; rejects with VoiceStreamError if the socket closes first
	// (bad token, engine offline, or agent HALTED at connect).
	readonly ready: Promise<VoiceReadyFrame>;
	readonly isOpen: boolean;
	sendAudio(chunk: ArrayBuffer | ArrayBufferView | Blob): void;
	endUtterance(): void;
	// Client-side transcript: skips engine STT.
	sendText(text: string): void;
	// Discards audio buffered on the engine since the last utterance.
	cancel(): void;
	close(): void;
}

export function buildVoiceStreamUrl(baseUrl: string, options: VoiceStreamOptions): string {
	const url = new URL(VOICE_STREAM_PATH, baseUrl.replace(/^http/i, 'ws'));
	url.searchParams.set('session_id', options.sessionId);
	if (options.agentId) url.searchParams.set('agent_id', options.agentId);
	const format = options.format || 'webm-opus';
	url.searchParams.set('format', format);
	if (format === 'pcm16' && options.sampleRate) url.searchParams.set('sample_rate', String(options.sampleRate));
	return url.toString();
}

export function connectVoiceStream(config: VoiceStreamConfig, handlers: VoiceStreamHandlers = {}): VoiceStream {
	if (typeof config.sessionId !== 'string' || !config.sessionId.trim()) throw new TypeError('sessionId must be a non-empty string.');
	const WebSocketImpl = config.WebSocketImpl ?? globalThis.WebSocket;
	if (!WebSocketImpl) throw new Error('WebSocket is not available in this runtime.');

	const protocols = config.token ? [VOICE_SUBPROTOCOL, 'bearer.' + config.token] : [VOICE_SUBPROTOCOL];
	const socket = new WebSocketImpl(buildVoiceStreamUrl(config.baseUrl, config), protocols);
	socket.binaryType = 'arraybuffer';

	let haltedFrame: VoiceErrorFrame | null = null;
	let settled = false;
	let resolveReady!: (frame: VoiceReadyFrame) => void;
	let rejectReady!: (error: VoiceStreamError) => void;
	const ready = new Promise<VoiceReadyFrame>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// Callers that never await `ready` must not see an unhandled rejection.
	ready.catch(() => {});

	socket.addEventListener('message', (event: MessageEvent) => {
		if (typeof event.data !== 'string') return;
		let frame: VoiceServerFrame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;

		if (frame.type === 'ready' && !settled) {
			settled = true;
			resolveReady(frame);
		}
		if (frame.type === 'error' && frame.code === 'AGENT_HALTED') {
			haltedFrame = frame;
			emitState({ agentId: frame.agent_id || config.agentId || 'master-brain', state: 'HALTED', reason: frame.reason, source: 'voice' });
		}
		handlers.onFrame?.(frame);
	});

	socket.addEventListener('close', (event: CloseEvent) => {
		const halted = event.code === CLOSE_HALTED || haltedFrame !== null;
		if (!settled) {
			settled = true;
			const message = halted
				? 'Agent execution is currently HALTED by circuit breaker'
				: 'Voice stream closed before it was ready (code ' + event.code + '): engine offline, or the token was rejected.';
			rejectReady(new VoiceStreamError(message, event.code, halted));
		}
		handlers.onClose?.({ code: event.code, reason: event.reason || haltedFrame?.message || '', halted });
	});

	function sendFrame(data: string | ArrayBuffer | ArrayBufferView | Blob) {
		if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('Voice stream is not open.');
		socket.send(data);
	}

	return {
		ready,
		get isOpen() {
			return socket.readyState === WebSocketImpl.OPEN;
		},
		sendAudio(chunk) {
			sendFrame(chunk);
		},
		endUtterance() {
			sendFrame(JSON.stringify({ type: 'end_utterance' }));
		},
		sendText(text) {
			if (typeof text !== 'string' || !text.trim()) throw new TypeError('text must be a non-empty string.');
			sendFrame(JSON.stringify({ type: 'text', text }));
		},
		cancel() {
			sendFrame(JSON.stringify({ type: 'cancel' }));
		},
		close() {
			if (socket.readyState === WebSocketImpl.CONNECTING || socket.readyState === WebSocketImpl.OPEN) socket.close(1000, 'client closed');
		},
	};
}
