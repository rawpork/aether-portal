// Agent state change channel shared by the HTTP client (engineApi.ts) and the voice stream (voiceStream.ts).

export type AgentExecutionState = 'ACTIVE' | 'HALTED';

export const ENGINE_STATE_EVENT = 'engine-state';

export interface EngineStateEventDetail {
	agentId: string;
	state: AgentExecutionState;
	reason?: string;
	// What revealed the state: a poll, a breaker call, a 423 from any other route, or a halted voice stream.
	source: 'state' | 'trip' | 'reset' | 'halted-response' | 'voice';
}

// Every client publishes agent state changes here, so UI (the breaker bar) reacts to a 423 from chat, a
// task run or a voice stream without waiting for its next poll.
export const engineEvents = new EventTarget();

export function emitState(detail: EngineStateEventDetail): void {
	engineEvents.dispatchEvent(new CustomEvent<EngineStateEventDetail>(ENGINE_STATE_EVENT, { detail }));
}

export function onEngineState(listener: (detail: EngineStateEventDetail) => void): () => void {
	const handler = (event: Event) => listener((event as CustomEvent<EngineStateEventDetail>).detail);
	engineEvents.addEventListener(ENGINE_STATE_EVENT, handler);
	return () => engineEvents.removeEventListener(ENGINE_STATE_EVENT, handler);
}
