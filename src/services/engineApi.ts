// Typed IPC client for the local Aether_Engine server (Phase 2 endpoints, default http://localhost:3333).
//
// Runs in the browser (or any runtime with fetch): the engine listens on the operator's machine, so the
// deployed Worker cannot reach it. Every /api call carries "Authorization: Bearer <jwt>" when a token is
// available (explicit getToken, else localStorage "aether.engine.jwt"); with no token the header is omitted,
// which only succeeds against an engine started with REQUIRE_AUTH=false (local bypass).
//
// Types mirror Aether_Engine/src/server.ts and blueprint_schema.json; keep them in sync with the engine.

import { emitState } from './engineEvents.ts';
import type { AgentExecutionState } from './engineEvents.ts';
import { connectVoiceStream } from './voiceStream.ts';
import type { VoiceStream, VoiceStreamHandlers, VoiceStreamOptions } from './voiceStream.ts';

export const DEFAULT_ENGINE_BASE_URL = 'http://localhost:3333';
export const ENGINE_JWT_STORAGE_KEY = 'aether.engine.jwt';
export const ENGINE_BASE_URL_STORAGE_KEY = 'aether.engine.baseUrl';

const DEFAULT_TIMEOUT_MS = 15_000;
// Master Brain turns go through Miserly.io; the engine allows the model up to 300s.
const CHAT_TIMEOUT_MS = 310_000;

// ---------------------------------------------------------------------------
// Engine contract types
// ---------------------------------------------------------------------------

export type { AgentExecutionState };

export interface TokenUsage {
	input: number;
	output: number;
}

export interface EngineHealth {
	status: 'healthy';
	system: string;
	timestamp: string;
}

export interface AgentState {
	agent_id: string;
	state: AgentExecutionState;
	reason?: string;
	updated_at?: string;
}

export interface TripBreakerOptions {
	session_tokens?: TokenUsage;
	estimated_cost?: number;
}

export interface TripBreakerResult {
	status: 'HALTED';
	logged: boolean;
	timestamp: string;
}

export interface ResetBreakerResult {
	status: 'ACTIVE';
	reset: true;
	logged: boolean;
	timestamp: string;
}

export interface ChatOptions {
	agentId?: string;
	context?: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface ChatResponse {
	session_id: string;
	response: string;
	tokens: TokenUsage;
	status: 'ACTIVE';
}

export type StepAction = 'prompt' | 'echo' | 'wait';

export type TaskStep =
	| { step_id: string; action: 'prompt'; params: { prompt: string; context?: Record<string, unknown> } }
	| { step_id: string; action: 'wait'; params: { ms: number } }
	| { step_id: string; action: 'echo'; params?: Record<string, unknown> };

export interface StepResult {
	step_index: number;
	step_id: string;
	action: StepAction;
	status: 'COMPLETED';
	output: unknown;
	tokens: TokenUsage;
	cost_usd: number | null;
	started_at: string;
	duration_ms: number;
}

interface TaskSummary {
	task_id: string;
	agent_id: string;
	run_id: string;
	completed_steps: number;
	results: StepResult[];
	total_tokens: TokenUsage;
}

export interface TaskCompleted extends TaskSummary {
	status: 'COMPLETED';
}

// 423 from /api/agents/execute-task: the breaker stopped the loop before `interrupted_step_index`.
export interface TaskHalted extends TaskSummary {
	status: 'HALTED';
	error: string;
	interrupted_step_index: number;
	interrupted_step_id: string;
	halted_at: string;
	reason?: string;
}

export type TaskOutcome = TaskCompleted | TaskHalted;

export type TaskStatus = 'RUNNING' | 'COMPLETED' | 'HALTED' | 'FAILED';

export interface TaskHistoryEntry {
	at: string;
	event: 'STARTED' | 'STEP_STARTED' | 'STEP_COMPLETED' | 'STEP_FAILED' | 'HALTED' | 'COMPLETED';
	step_index?: number;
	step_id?: string;
	detail?: string;
}

export interface TaskRecord {
	task_id: string;
	agent_id: string;
	run_id: string;
	requested_by: string;
	status: TaskStatus;
	total_steps: number;
	completed_steps: number;
	interrupted_step_index: number | null;
	results: StepResult[];
	total_tokens: TokenUsage;
	history: TaskHistoryEntry[];
	started_at: string;
	finished_at: string | null;
	halt?: { halted_at: string; reason?: string };
	failure?: { step_index: number; status: number; error: string };
}

// blueprint_schema.json#/definitions/compile_request
export interface CompileBlueprintRequest {
	links: Array<{ url: string; title?: string; rawSnippet?: string }>;
	projectName?: string;
	creator?: string;
	lodLevel?: number;
	useMiserlyProxy?: boolean;
	interviewResponses?: {
		database?: string;
		hosting?: string;
		miserlyBudgetCapUsd?: number;
		unresolvedConnectors?: string[];
	};
}

export type BlueprintStatus = 'DRAFT' | 'APPROVED_FOR_EXECUTION' | 'EXECUTING' | 'HALTED' | 'COMPLETED' | 'FAILED';

// Root schema of blueprint_schema.json.
export interface CompiledBlueprint {
	blueprint_id: string;
	project_name: string;
	generated_from_recommendation_id?: string;
	status: BlueprintStatus;
	metadata: { creator: string; lod_spatial_level: number; created_at: string };
	interview_responses: {
		database: string;
		hosting: string;
		miserly_budget_cap_usd: number;
		unresolved_connectors: string[];
	};
	sources: Array<{ source_id: string; url: string; scraped_summary?: string; content_type: 'web_link' }>;
	execution_phases: Array<{
		phase_index: number;
		phase_name: string;
		agent_role: string;
		required_mcp_tools: string[];
		prompt_template: string;
	}>;
	project_scaffold: Array<{ path: string; template: string; required: boolean }>;
	miserly_integration: { enabled: boolean; proxy_endpoint: string | null; budget_cap_usd: number };
}

export interface CompileBlueprintResult {
	success: true;
	message: string;
	blueprint_id: string;
	artifact_path: string;
	logged: boolean;
	blueprint: CompiledBlueprint;
}

export interface SchemaViolation {
	path: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface EngineErrorBody {
	error?: string;
	validation_errors?: SchemaViolation[];
	status?: string;
	[key: string]: unknown;
}

export class EngineApiError extends Error {
	// HTTP status, or 0 when the engine could not be reached (offline, CORS, timeout).
	readonly status: number;
	readonly body: EngineErrorBody | null;
	readonly path: string;

	constructor(status: number, path: string, message: string, body: EngineErrorBody | null = null) {
		super(message);
		this.name = 'EngineApiError';
		this.status = status;
		this.path = path;
		this.body = body;
	}

	get isUnreachable(): boolean {
		return this.status === 0;
	}

	get isUnauthorized(): boolean {
		return this.status === 401;
	}

	// 423 Locked: the target agent's circuit breaker is tripped.
	get isHalted(): boolean {
		return this.status === 423;
	}
}

// ---------------------------------------------------------------------------
// State events (shared with the voice stream client)
// ---------------------------------------------------------------------------

export { ENGINE_STATE_EVENT, engineEvents, onEngineState } from './engineEvents.ts';
export type { EngineStateEventDetail } from './engineEvents.ts';
export * from './voiceStream.ts';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface EngineApiOptions {
	baseUrl?: string;
	// Returns the Supabase JWT for the engine; null/undefined falls back to no header (local bypass).
	getToken?: () => string | null | undefined;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

interface RequestOptions {
	body?: unknown;
	timeoutMs?: number | null;
	signal?: AbortSignal;
	// Statuses that resolve with the parsed body instead of throwing.
	acceptStatuses?: number[];
}

function readStorage(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		// Storage can be blocked (private mode, sandboxed frames); treat as empty.
		return null;
	}
}

export function getStoredEngineToken(): string | null {
	return readStorage(ENGINE_JWT_STORAGE_KEY);
}

export function setStoredEngineToken(token: string | null): void {
	try {
		if (token) globalThis.localStorage?.setItem(ENGINE_JWT_STORAGE_KEY, token);
		else globalThis.localStorage?.removeItem(ENGINE_JWT_STORAGE_KEY);
	} catch {
		// Ignore: the client still works with an explicit getToken or the local bypass.
	}
}

function combineSignals(timeoutMs: number | null, signal?: AbortSignal): AbortSignal | undefined {
	const signals: AbortSignal[] = [];
	if (timeoutMs !== null) signals.push(AbortSignal.timeout(timeoutMs));
	if (signal) signals.push(signal);
	if (signals.length === 0) return undefined;
	return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function requireText(name: string, value: string): void {
	if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + ' must be a non-empty string.');
}

export function createEngineApi(options: EngineApiOptions = {}) {
	const baseUrl = (options.baseUrl ?? readStorage(ENGINE_BASE_URL_STORAGE_KEY) ?? DEFAULT_ENGINE_BASE_URL).replace(/\/+$/, '');
	const getToken = options.getToken ?? getStoredEngineToken;
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
		if (path.startsWith('/api/')) {
			const token = getToken();
			if (token) headers.Authorization = 'Bearer ' + token;
		}

		let response: Response;
		try {
			response = await fetchImpl(baseUrl + path, {
				method,
				headers,
				body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
				signal: combineSignals(opts.timeoutMs === undefined ? defaultTimeout : opts.timeoutMs, opts.signal),
			});
		} catch (error) {
			const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
			throw new EngineApiError(0, path, 'Aether Engine at ' + baseUrl + ' ' + reason + '.', null);
		}

		let body: unknown = null;
		const text = await response.text();
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {
				body = { error: text };
			}
		}

		if (response.status === 423) {
			const halted = body as { agent_id?: unknown; reason?: unknown } | null;
			if (typeof halted?.agent_id === 'string') {
				emitState({
					agentId: halted.agent_id,
					state: 'HALTED',
					reason: typeof halted.reason === 'string' ? halted.reason : undefined,
					source: 'halted-response',
				});
			}
		}

		if (response.ok || opts.acceptStatuses?.includes(response.status)) return body as T;

		const errorBody = (body && typeof body === 'object' ? body : null) as EngineErrorBody | null;
		const message = errorBody?.error || 'Aether Engine request failed (' + response.status + ').';
		throw new EngineApiError(response.status, path, message, errorBody);
	}

	const agentPath = (agentId: string) => '/api/agents/' + encodeURIComponent(agentId);

	return {
		baseUrl,

		// GET /health (public, no auth header).
		getEngineHealth(): Promise<EngineHealth> {
			return request<EngineHealth>('GET', '/health', { timeoutMs: 5_000 });
		},

		// POST /api/agents/trip-breaker: halts the agent (task loops stop at the next step, voice streams close).
		async tripBreaker(agentId: string, reason: string, opts: TripBreakerOptions = {}): Promise<TripBreakerResult> {
			requireText('agentId', agentId);
			requireText('reason', reason);
			const result = await request<TripBreakerResult>('POST', '/api/agents/trip-breaker', { body: { agent_id: agentId, reason, ...opts } });
			emitState({ agentId, state: 'HALTED', reason, source: 'trip' });
			return result;
		},

		// POST /api/agents/reset: HALTED -> ACTIVE. Throws EngineApiError 409 if the agent is not halted.
		async resetBreaker(agentId: string): Promise<ResetBreakerResult> {
			requireText('agentId', agentId);
			const result = await request<ResetBreakerResult>('POST', '/api/agents/reset', { body: { agent_id: agentId } });
			emitState({ agentId, state: 'ACTIVE', source: 'reset' });
			return result;
		},

		// GET /api/agents/:agentId/state (unknown agents report ACTIVE).
		async getAgentState(agentId: string): Promise<AgentState> {
			requireText('agentId', agentId);
			const result = await request<AgentState>('GET', agentPath(agentId) + '/state');
			emitState({ agentId: result.agent_id, state: result.state, reason: result.reason, source: 'state' });
			return result;
		},

		// POST /api/master-brain/chat. Throws EngineApiError with isHalted when the agent is tripped.
		sendMasterBrainChat(message: string, sessionId: string, opts: ChatOptions = {}): Promise<ChatResponse> {
			requireText('message', message);
			requireText('sessionId', sessionId);
			return request<ChatResponse>('POST', '/api/master-brain/chat', {
				body: { session_id: sessionId, message, agent_id: opts.agentId, context: opts.context },
				timeoutMs: CHAT_TIMEOUT_MS,
				signal: opts.signal,
			});
		},

		// POST /api/agents/execute-task. Resolves with status COMPLETED or HALTED (423); other failures throw.
		// No default timeout: a task runs as many steps as it was given. Pass a signal to stop waiting.
		executeSubAgentTask(agentId: string, taskId: string, steps: TaskStep[], opts: { signal?: AbortSignal } = {}): Promise<TaskOutcome> {
			requireText('agentId', agentId);
			requireText('taskId', taskId);
			return request<TaskOutcome>('POST', '/api/agents/execute-task', {
				body: { agent_id: agentId, task_id: taskId, steps },
				timeoutMs: null,
				signal: opts.signal,
				acceptStatuses: [423],
			});
		},

		// GET /api/agents/:agentId/tasks/:taskId: latest run record for the authenticated user (404 if none).
		getTaskStatus(agentId: string, taskId: string): Promise<TaskRecord> {
			requireText('agentId', agentId);
			requireText('taskId', taskId);
			return request<TaskRecord>('GET', agentPath(agentId) + '/tasks/' + encodeURIComponent(taskId));
		},

		// POST /api/blueprint/compile. Schema violations throw EngineApiError 400 with body.validation_errors.
		compileBlueprint(payload: CompileBlueprintRequest): Promise<CompileBlueprintResult> {
			return request<CompileBlueprintResult>('POST', '/api/blueprint/compile', { body: payload });
		},

		// WebSocket /api/voice/stream on the same engine, authenticated with the same token.
		openVoiceStream(options: VoiceStreamOptions, handlers?: VoiceStreamHandlers): VoiceStream {
			return connectVoiceStream({ ...options, baseUrl, token: getToken() }, handlers);
		},
	};
}

export type EngineApi = ReturnType<typeof createEngineApi>;

// Shared default client (localStorage token, localhost:3333) for portal UI code.
let defaultClient: EngineApi | null = null;

export function getEngineApi(): EngineApi {
	if (!defaultClient) defaultClient = createEngineApi();
	return defaultClient;
}

export const getEngineHealth: EngineApi['getEngineHealth'] = () => getEngineApi().getEngineHealth();
export const tripBreaker: EngineApi['tripBreaker'] = (...args) => getEngineApi().tripBreaker(...args);
export const resetBreaker: EngineApi['resetBreaker'] = (...args) => getEngineApi().resetBreaker(...args);
export const getAgentState: EngineApi['getAgentState'] = (...args) => getEngineApi().getAgentState(...args);
export const sendMasterBrainChat: EngineApi['sendMasterBrainChat'] = (...args) => getEngineApi().sendMasterBrainChat(...args);
export const executeSubAgentTask: EngineApi['executeSubAgentTask'] = (...args) => getEngineApi().executeSubAgentTask(...args);
export const getTaskStatus: EngineApi['getTaskStatus'] = (...args) => getEngineApi().getTaskStatus(...args);
export const compileBlueprint: EngineApi['compileBlueprint'] = (...args) => getEngineApi().compileBlueprint(...args);
