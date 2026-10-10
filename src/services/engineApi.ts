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
// The portal Worker's relay to the engine's public address (ENGINE_PUBLIC_URL secret, src/index.js). Mission Control
// says it is available with <meta name="aether-engine-relay" content="1">.
export const ENGINE_RELAY_PATH = '/api/engine/relay';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackUrl(url: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

// True when the engine address points at "this computer" but the page is open on another device or the hosted
// site, so the engine can't be reached from here (a phone has no engine on localhost).
export function engineUnreachableFromHere(baseUrl: string, pageUrl: string | undefined = globalThis.location?.href): boolean {
	if (!pageUrl || !isLoopbackUrl(baseUrl)) return false;
	return !isLoopbackUrl(pageUrl);
}

function relayAvailable(): boolean {
	try {
		const meta = globalThis.document?.querySelector('meta[name="aether-engine-relay"]');
		return meta?.getAttribute('content') === '1';
	} catch {
		return false;
	}
}

// A Cloudflare quick tunnel (*.trycloudflare.com): its address changes every time the tunnel restarts.
export function isQuickTunnelUrl(value: string): boolean {
	try {
		return new URL(value).hostname.toLowerCase().endsWith('.trycloudflare.com');
	} catch {
		return false;
	}
}

// Engine address for this browser: a saved address (Settings / pairing) wins; away from the engine's computer the
// portal relay is used when the Worker has one; otherwise localhost. A saved quick-tunnel address goes stale on the
// tunnel's next restart while the relay follows the Worker's ENGINE_PUBLIC_URL, so where the relay is available it
// takes over from a saved quick tunnel (a permanent address or localhost still wins).
export function resolveEngineBaseUrl(): string {
	const stored = readStorage(ENGINE_BASE_URL_STORAGE_KEY);
	const here = globalThis.location;
	const relay = here && relayAvailable() && !isLoopbackUrl(here.href) ? here.origin + ENGINE_RELAY_PATH : null;
	if (stored && !(relay && isQuickTunnelUrl(stored))) return stored;
	if (relay) return relay;
	return DEFAULT_ENGINE_BASE_URL;
}

export const isRelayUrl = (baseUrl: string): boolean => {
	try {
		return new URL(baseUrl).pathname.replace(/\/+$/, '') === ENGINE_RELAY_PATH;
	} catch {
		return false;
	}
};

const DEFAULT_TIMEOUT_MS = 15_000;
// Master Brain turns go through Miserly.io; the engine allows the model up to 300s.
const CHAT_TIMEOUT_MS = 310_000;
// Project runs: the engine plans for up to 90 s (plus repo inspection) before answering.
const PROJECT_PLAN_TIMEOUT_MS = 150_000;

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

// What a turn is for, which picks the engine's provider (MODEL_ROUTES): by default Claude for chat, plan and agent,
// Gemini for step.
export type TurnPurpose = 'chat' | 'plan' | 'agent' | 'step';

export interface ChatOptions {
	agentId?: string;
	context?: Record<string, unknown>;
	signal?: AbortSignal;
	purpose?: TurnPurpose;
}

export interface ChatResponse {
	session_id: string;
	response: string;
	tokens: TokenUsage;
	// Sent by engines with per-purpose routing.
	model?: string;
	tier?: string | null;
	purpose?: TurnPurpose;
	status: 'ACTIVE';
}

// GET /api/roadmap: ROADMAP.md's phases and goals, recent Claude Code sessions (metadata only) and the memory index.
export interface SkillIngestResult {
	draft: { slug: string; name: string; description: string; markdown: string; source: { kind: 'github' | 'url' | 'text'; url: string | null; title: string } };
	exists: boolean;
	model?: string;
}

export interface RoadmapGoal {
	text: string;
	detail: string;
	done: boolean;
	completed_on: string | null;
	depth: number;
	children: { done: number; total: number };
}

export interface RoadmapReport {
	roadmap: { file: string; updated_at: string | null; title: string; phases: { title: string; level: number; done: number; total: number; goals: RoadmapGoal[] }[] } | null;
	roadmap_error: string | null;
	sessions: { id: string; project: string; title: string; started_at: string | null; last_active_at: string; size_kb: number; active: boolean }[];
	memory: { title: string; hook: string }[];
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

// A choice step waiting for the operator (the task stays RUNNING); options are numbered from 1.
export interface PendingChoice {
	step_index: number;
	step_id: string;
	question: string;
	options: string[];
	asked_at: string;
	expires_at: string;
}

export interface ChoiceMade {
	step_id: string;
	question: string;
	option: number;
	choice: string;
	at: string;
}

export interface TaskHistoryEntry {
	at: string;
	event: 'STARTED' | 'STEP_STARTED' | 'STEP_COMPLETED' | 'STEP_FAILED' | 'HALTED' | 'COMPLETED';
	step_index?: number;
	step_id?: string;
	detail?: string;
}

// POST /api/projects/run: Elarion's plan for a compiled blueprint, answered once its run has started (202).
export interface ProjectPlanStep {
	id: string;
	title: string;
	depends_on: string[];
	prompt: string;
}

export interface ProjectRunStarted {
	status: 'RUNNING';
	task_id: string;
	agent_id: string;
	plan: {
		summary: string;
		goals: string[];
		steps: ProjectPlanStep[];
		preview_page: boolean;
		planned_by: 'elarion' | 'phases';
		fallback_reason?: string;
	};
	repos: { repo: string; ok: boolean; error?: string }[];
	skills: string[];
	total_steps: number;
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
	awaiting?: PendingChoice | null;
	choices?: ChoiceMade[];
}

// GET /api/tasks: one entry per task (latest run), without per-step results.
export interface TaskListItem {
	task_id: string;
	agent_id: string;
	run_id: string;
	status: TaskStatus;
	total_steps: number;
	completed_steps: number;
	current_step: { index: number; step_id: string } | null;
	interrupted_step_index: number | null;
	total_tokens: TokenUsage;
	started_at: string;
	finished_at: string | null;
	halt?: { halted_at: string; reason?: string };
	failure?: { step_index: number; status: number; error: string };
	awaiting?: PendingChoice;
}

export interface TaskList {
	tasks: TaskListItem[];
	counts: { running: number; completed: number; halted: number; failed: number };
}

// GET /api/artifacts: compiled blueprints stored by the engine.
// Studio workflows (Aether_Engine src/workflows.ts, blueprint_schema.json#/definitions/workflow_*).
export type WorkflowNodeKind = 'trigger' | 'agent' | 'mcp' | 'action' | 'human';
export type WorkflowCableKind = 'start' | 'mcp_read' | 'a2a' | 'action';
export type WorkflowOrigin = 'generated' | 'prompt' | 'operator';

export interface WorkflowNode {
	id: string;
	kind: WorkflowNodeKind;
	label: string;
	role?: string;
	instructions?: string;
	server?: string;
	x?: number | null;
	y?: number | null;
	origin?: WorkflowOrigin;
}

export interface WorkflowCable {
	id: string;
	from: string;
	from_port: string;
	to: string;
	to_port: string;
	kind?: WorkflowCableKind;
	origin?: WorkflowOrigin;
}

export type WorkflowRunStatus = 'RUNNING' | 'COMPLETED' | 'HALTED' | 'FAILED';
export type WorkflowNodeRunStatus = 'running' | 'done' | 'failed' | 'halted' | 'proposed' | 'waiting';

export interface WorkflowRunSummary {
	run_id: string;
	task_id: string;
	agent_id: string;
	status: WorkflowRunStatus;
	started_at: string;
	finished_at: string | null;
	node_status: Record<string, WorkflowNodeRunStatus>;
	error?: string;
}

export interface WorkflowEvent {
	seq: number;
	ts: number;
	type: 'flow' | 'node_status' | 'run_status';
	cable_id?: string;
	kind?: WorkflowCableKind;
	from?: string;
	to?: string;
	node_id?: string;
	status?: WorkflowNodeRunStatus | WorkflowRunStatus;
	summary?: string;
	tokens?: number;
}

export interface Workflow {
	workflow_id: string;
	requested_by: string;
	title: string;
	goal: string;
	version: number;
	created_at: string;
	updated_at: string;
	nodes: WorkflowNode[];
	cables: WorkflowCable[];
	history: { at: string; version: number; source: 'model' | 'planner' | 'operator'; summary: string }[];
	run: (WorkflowRunSummary & { events?: WorkflowEvent[] }) | null;
}

export interface WorkflowListItem {
	workflow_id: string;
	title: string;
	goal: string;
	version: number;
	updated_at: string;
	agents: number;
	run_status: WorkflowRunStatus | null;
}

export interface WorkflowCreateResult {
	workflow: Workflow;
	source: 'model' | 'planner';
	note: string;
}

export interface WorkflowMutateResult {
	workflow: Workflow;
	applied: Record<string, unknown>[];
	skipped: { op: Record<string, unknown>; reason: string }[];
	summary: string;
	source: 'model' | 'planner';
	note: string | null;
}

// GET /api/canvas/graph (Aether_Engine src/canvasGraph.ts): task trees, MCP server nodes and scored bridges.
export interface CanvasTaskNode {
	id: string;
	kind: 'task';
	label: string;
	agent_id: string;
	run_id: string;
	status: TaskStatus;
	completed_steps: number;
	total_steps: number;
	started_at: string;
	finished_at: string | null;
}

export interface CanvasStepNode {
	id: string;
	kind: 'step';
	label: string;
	task: string;
	index: number;
	action: StepAction;
	status: 'COMPLETED' | 'RUNNING' | 'PENDING' | 'FAILED' | 'HALTED';
}

export interface CanvasMcpNode {
	id: string;
	kind: 'mcp';
	label: string;
	category: string | null;
	status: 'ready' | 'missing_keys';
	transport: string;
	description: string | null;
	missing_env: string[];
}

export type CanvasNode = CanvasTaskNode | CanvasStepNode | CanvasMcpNode;

export interface BridgeSignal {
	type: 'name' | 'category' | 'description' | 'keys_missing';
	terms: string[];
	weight: number;
}

export interface CanvasTreeEdge {
	id: string;
	kind: 'tree';
	from: string;
	to: string;
}

export interface CanvasBridgeEdge {
	id: string;
	kind: 'bridge';
	from: string;
	to: string;
	confidence: number;
	depth: 'logic' | 'associative' | 'abstract';
	rationale: string;
	signals: BridgeSignal[];
	metadata: {
		agent_id: string;
		task_id: string;
		run_id: string;
		step_id: string;
		step_index: number;
		step_action: StepAction;
		step_status: CanvasStepNode['status'];
		step_excerpt: string;
		elarion_excerpt: string | null;
		server: string;
		category: string | null;
		transport: string;
		server_status: CanvasMcpNode['status'];
		scoring: string;
	};
}

export type CanvasEdge = CanvasTreeEdge | CanvasBridgeEdge;

export interface CanvasGraph {
	generated_at: string;
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	counts: { tasks: number; steps: number; mcp_servers: number; bridges: number };
	mcp_error: string | null;
}

export interface ArtifactSummary {
	filename: string;
	blueprint_id: string;
	project_name: string;
	created_at?: string;
	status: BlueprintStatus;
	phases?: number;
	sources?: number;
}

export interface ArtifactList {
	success: true;
	count: number;
	artifacts: ArtifactSummary[];
}

// GET /api/public-url: how other devices reach this engine (ENGINE_PUBLIC_URL or a running cloudflared quick tunnel).
export interface PublicUrl {
	public_url: string | null;
	source: 'env' | 'cloudflared' | null;
}

// GET / POST /api/engine/config (Quick Setup). The key itself is never returned, only its last 4 characters.
// 'sandbox': the free sandbox key (miserly_free_sandbox), accepted locally; Elarion then answers with local mock replies.
export type MiserlyKeyStatus = 'missing' | 'verified' | 'sandbox' | 'invalid' | 'unreachable';
export type ExecutionMode = 'miserly' | 'miserly-free' | 'unconfigured';

export interface LaunchLink {
	id: string;
	label: string;
	url: string;
	// True when the operator set a referral link (AFFILIATE_<HOST>_URL); Mission Control says so.
	affiliate: boolean;
	what: string;
}

export interface EngineConfigSummary {
	// Sandboxed builds and staging (engines with project-run builds).
	build_sandbox?: { ready: boolean; detail: string; staging: 'cloudflare-pages' | 'off' };
	launch_links?: LaunchLink[];
	miserly_key_configured: boolean;
	miserly_key_hint: string | null;
	miserly_key_status: MiserlyKeyStatus;
	miserly_key_detail: string;
	public_url: string | null;
	// Missing on engines older than Free Sandbox Mode.
	execution_mode?: ExecutionMode;
	elarion_ready: boolean;
	saved?: string[];
}

export interface EngineConfigChanges {
	miserly_client_key?: string;
	// true leaves Miserly (or the sandbox): the engine then calls the model provider directly with its own key.
	clear_miserly_key?: boolean;
	// "" clears it.
	public_url?: string;
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

// GET /api/projects/:id/lifecycle: where a project stands from idea to delivery, and what Elarion asks next (Aether_Engine src/lifecycle.ts).
export interface LifecycleStep {
	id: 'plan' | 'map' | 'connections' | 'test' | 'launch' | 'deliver';
	label: string;
	state: 'done' | 'current' | 'todo' | 'blocked';
	detail: string;
}

export interface LifecycleNext {
	kind: 'make_map' | 'open_map' | 'connect' | 'test' | 'fix_test' | 'wait' | 'launch' | 'fix_launch' | 'review' | 'done';
	title: string;
	question: string;
	options: string[];
}

export interface ProjectLifecycle {
	blueprint_id: string;
	project_name: string;
	stage: string;
	steps: LifecycleStep[];
	next: LifecycleNext;
	summary: string;
}

// GET /api/workflows/:id/versions and POST .../restore: the version history of a workflow and going back to one.
export interface WorkflowVersionInfo {
	version: number;
	at: string;
	source: 'model' | 'planner' | 'operator';
	summary: string;
	current: boolean;
	restorable: boolean;
}

// GET /api/connectors and POST /api/connectors/test: the Studio toolbox (Aether_Engine src/connectors.ts).
export interface ConnectorField {
	id: string;
	label: string;
	type: 'text' | 'longtext' | 'select' | 'url';
	required?: boolean;
	placeholder?: string;
	options?: string[];
	default?: string;
}

export interface ConnectorAction {
	id: string;
	label: string;
	description: string;
	fields: ConnectorField[];
	outward: boolean;
	live_test?: boolean;
}

export interface ConnectorInfo {
	id: string;
	name: string;
	category: 'messaging' | 'web' | 'google';
	description: string;
	available: boolean;
	status: 'ready' | 'needs_setup' | 'coming_soon';
	status_detail: string;
	actions: ConnectorAction[];
}

export interface ConnectorTestRequest {
	connector: string;
	action: string;
	params?: Record<string, string>;
	// Send for real: only for actions the engine marks live_test (a Telegram message to yourself).
	send?: boolean;
}

export interface ConnectorTestResult {
	ok: boolean;
	simulated: boolean;
	summary: string;
	detail?: string;
	error?: string;
}

// POST /api/intake/architect: Elarion drafts the engineered execution prompt (personas, bound skills, deliverables, criteria).
export interface ArchitectRequest {
	goal: string;
	name?: string;
	sources?: { title: string; snippet?: string }[];
}
export interface ArchitectResult {
	prompt: string;
	personas: { name: string; role: string }[];
	skills: { name: string; repo: string; kind: string }[];
	deliverables: string[];
	criteria: string[];
	source: 'elarion' | 'template';
	note?: string;
}

// POST /api/intake/analyze: Elarion checks the target page against the on-page benchmark and asks what decides the plan.
export interface IntakeRequest {
	url?: string;
	region?: string;
	goal?: string;
	deliverables?: string[];
	template?: { name?: string; category?: string; summary?: string } | null;
}

export interface IntakeFinding {
	id: string;
	label: string;
	points: number;
	max: number;
	detail: string;
}

export interface IntakeQuestion {
	id: string;
	question: string;
	why: string;
	kind: 'choice' | 'text';
	options?: string[];
}

export interface IntakeResult {
	target: { url: string; checked: boolean; status?: number; error?: string; score?: number; grade?: string; findings?: IntakeFinding[] } | null;
	summary: string;
	questions: IntakeQuestion[];
}

export interface CompileBlueprintResult {
	success: true;
	message: string;
	blueprint_id: string;
	artifact_path: string;
	logged: boolean;
	// The project's map in the Studio (one agent per phase), made when it is compiled.
	workflow_id?: string | null;
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
	const baseUrl = (options.baseUrl ?? resolveEngineBaseUrl()).replace(/\/+$/, '');
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
				// An HTML error page (a proxy or Cloudflare answering for the engine) is not a message to show.
				body = { error: /^\s*</.test(text) ? 'The engine’s address answered with an error page (HTTP ' + response.status + ') instead of the engine. Is the engine and its tunnel running?' : text.slice(0, 500) };
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
				body: { session_id: sessionId, message, agent_id: opts.agentId, context: opts.context, purpose: opts.purpose },
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

		// POST /api/skills/ingest: Elarion reads a link (GitHub repo, web page) or pasted text and drafts a SKILL.md.
		// Nothing is saved; saveSkill writes it. Reading and drafting take up to two minutes.
		ingestSkill(source: string, opts: { name?: string } = {}): Promise<SkillIngestResult> {
			requireText('source', source);
			return request<SkillIngestResult>('POST', '/api/skills/ingest', { body: { source, name: opts.name }, timeoutMs: PROJECT_PLAN_TIMEOUT_MS });
		},

		// POST /api/skills/save: writes Aether_Engine/skills/<slug>/SKILL.md (409 if it exists and replace is not set).
		saveSkill(slug: string, markdown: string, opts: { replace?: boolean } = {}): Promise<{ saved: true; slug: string; file: string }> {
			requireText('slug', slug);
			return request('POST', '/api/skills/save', { body: { slug, markdown, replace: opts.replace === true } });
		},

		// GET /api/roadmap: the project's roadmap and recent sessions, read on the engine's computer.
		getRoadmap(): Promise<RoadmapReport> {
			return request<RoadmapReport>('GET', '/api/roadmap');
		},

		// POST /api/projects/run: Elarion analyzes the stored blueprint, plans a DAG and starts it as deploy-<id>.
		// Planning is one model call, so this waits up to PROJECT_PLAN_TIMEOUT_MS; follow the run with getTaskStatus.
		// deliver: 'website' asks for a live website page (preview/index.html), drafted at /s/<slug> by the portal.
		runProject(blueprintId: string, opts: { agentId?: string; deliver?: 'website'; signal?: AbortSignal } = {}): Promise<ProjectRunStarted> {
			requireText('blueprintId', blueprintId);
			return request<ProjectRunStarted>('POST', '/api/projects/run', {
				body: { blueprint_id: blueprintId, agent_id: opts.agentId, deliver: opts.deliver },
				timeoutMs: PROJECT_PLAN_TIMEOUT_MS,
				signal: opts.signal,
			});
		},

		// GET /api/agents/:agentId/tasks/:taskId: latest run record for the authenticated user (404 if none).
		getTaskStatus(agentId: string, taskId: string): Promise<TaskRecord> {
			requireText('agentId', agentId);
			requireText('taskId', taskId);
			return request<TaskRecord>('GET', agentPath(agentId) + '/tasks/' + encodeURIComponent(taskId));
		},

		// POST /api/agents/:agentId/tasks/:taskId/choice: answers the choice step the task is waiting on (option from 1).
		answerTaskChoice(agentId: string, taskId: string, option: number): Promise<{ ok: true; task_id: string; agent_id: string; option: number }> {
			requireText('agentId', agentId);
			requireText('taskId', taskId);
			if (!Number.isInteger(option) || option < 1) throw new TypeError('option must be a whole number from 1.');
			return request('POST', agentPath(agentId) + '/tasks/' + encodeURIComponent(taskId) + '/choice', { body: { option } });
		},

		// GET /api/tasks: the caller's task runs, newest first (optionally one agent's).
		listTasks(opts: { agentId?: string; limit?: number } = {}): Promise<TaskList> {
			const query = new URLSearchParams();
			if (opts.agentId) query.set('agent_id', opts.agentId);
			if (opts.limit) query.set('limit', String(opts.limit));
			const qs = query.toString();
			return request<TaskList>('GET', '/api/tasks' + (qs ? '?' + qs : ''));
		},

		// GET /api/canvas/graph: the Studio canvas (task trees, MCP servers, scored step -> server bridges).
		getCanvasGraph(opts: { limit?: number } = {}): Promise<CanvasGraph> {
			return request<CanvasGraph>('GET', '/api/canvas/graph' + (opts.limit ? '?limit=' + encodeURIComponent(String(opts.limit)) : ''));
		},

		// Studio workflows. A stale base_version throws EngineApiError 409 whose body.workflow is the current version.
		listWorkflows(): Promise<{ workflows: WorkflowListItem[] }> {
			return request<{ workflows: WorkflowListItem[] }>('GET', '/api/workflows');
		},

		// POST /api/workflows/from-blueprint: the Studio map of a compiled project (made when it was compiled; this makes one for older projects).
		getProjectLifecycle(blueprintId: string): Promise<ProjectLifecycle> {
			requireText('blueprintId', blueprintId);
			return request<ProjectLifecycle>('GET', '/api/projects/' + encodeURIComponent(blueprintId) + '/lifecycle');
		},

		listProjectLifecycles(): Promise<{ projects: ProjectLifecycle[] }> {
			return request<{ projects: ProjectLifecycle[] }>('GET', '/api/projects/lifecycle');
		},

		createWorkflowFromBlueprint(blueprintId: string): Promise<{ workflow: Workflow }> {
			requireText('blueprintId', blueprintId);
			return request<{ workflow: Workflow }>('POST', '/api/workflows/from-blueprint', { body: { blueprint_id: blueprintId } });
		},

		listWorkflowVersions(workflowId: string): Promise<{ versions: WorkflowVersionInfo[] }> {
			requireText('workflowId', workflowId);
			return request<{ versions: WorkflowVersionInfo[] }>('GET', '/api/workflows/' + encodeURIComponent(workflowId) + '/versions');
		},

		// The earlier version's graph becomes a new version, so nothing is lost. 409 when baseVersion is stale.
		restoreWorkflowVersion(workflowId: string, version: number, baseVersion: number): Promise<Workflow> {
			requireText('workflowId', workflowId);
			return request<Workflow>('POST', '/api/workflows/' + encodeURIComponent(workflowId) + '/restore', { body: { version, base_version: baseVersion } });
		},

		getWorkflow(workflowId: string): Promise<Workflow> {
			requireText('workflowId', workflowId);
			return request<Workflow>('GET', '/api/workflows/' + encodeURIComponent(workflowId));
		},

		// POST /api/workflows: the engine designs agents, A2A hand-offs and tool bindings for the goal (model, or the
		// built-in planner in sandbox mode). Can take a while with a real model.
		generateWorkflow(goal: string): Promise<WorkflowCreateResult> {
			requireText('goal', goal);
			return request<WorkflowCreateResult>('POST', '/api/workflows', { body: { goal }, timeoutMs: 180_000 });
		},

		// POST /api/workflows/:id/mutate: change the graph from a prompt ("add a reviewer before Deploy").
		mutateWorkflow(workflowId: string, prompt: string, baseVersion?: number): Promise<WorkflowMutateResult> {
			requireText('workflowId', workflowId);
			requireText('prompt', prompt);
			return request<WorkflowMutateResult>('POST', '/api/workflows/' + encodeURIComponent(workflowId) + '/mutate', {
				body: baseVersion === undefined ? { prompt } : { prompt, base_version: baseVersion },
				timeoutMs: 180_000,
			});
		},

		// POST /api/workflows/:id/graph: operator edits (positions, wires, node fields) saved over base_version.
		saveWorkflowGraph(workflowId: string, baseVersion: number, nodes: WorkflowNode[], cables: WorkflowCable[]): Promise<Workflow> {
			requireText('workflowId', workflowId);
			return request<Workflow>('POST', '/api/workflows/' + encodeURIComponent(workflowId) + '/graph', { body: { base_version: baseVersion, nodes, cables } });
		},

		// POST /api/workflows/:id/run: starts a run (202); poll getWorkflowEvents for node statuses and pulses.
		runWorkflow(workflowId: string): Promise<{ run: WorkflowRunSummary }> {
			requireText('workflowId', workflowId);
			return request<{ run: WorkflowRunSummary }>('POST', '/api/workflows/' + encodeURIComponent(workflowId) + '/run', { body: {} });
		},

		getWorkflowEvents(workflowId: string, after = 0): Promise<{ run: WorkflowRunSummary | null; events: WorkflowEvent[] }> {
			requireText('workflowId', workflowId);
			return request<{ run: WorkflowRunSummary | null; events: WorkflowEvent[] }>('GET', '/api/workflows/' + encodeURIComponent(workflowId) + '/events?after=' + encodeURIComponent(String(after)), { timeoutMs: 10_000 });
		},

		// GET /api/public-url: the engine's public address, for pairing another device.
		getPublicUrl(): Promise<PublicUrl> {
			return request<PublicUrl>('GET', '/api/public-url', { timeoutMs: 5_000 });
		},

		// GET /api/engine/config: whether Elarion's Miserly key is set and verified, and the saved public URL.
		getEngineConfig(): Promise<EngineConfigSummary> {
			return request<EngineConfigSummary>('GET', '/api/engine/config', { timeoutMs: 15_000 });
		},

		// POST /api/engine/config: the engine checks the key with Miserly.io, then saves and applies it without a
		// restart. Throws EngineApiError 422 when Miserly rejects the key, 502 when Miserly can't be reached.
		saveEngineConfig(changes: EngineConfigChanges): Promise<EngineConfigSummary> {
			return request<EngineConfigSummary>('POST', '/api/engine/config', { body: changes, timeoutMs: 20_000 });
		},

		// GET /api/artifacts: compiled blueprints (project status).
		listArtifacts(): Promise<ArtifactList> {
			return request<ArtifactList>('GET', '/api/artifacts');
		},

		// GET /api/artifacts/:blueprintId: one stored blueprint in full (404 if missing).
		getArtifact(blueprintId: string): Promise<CompiledBlueprint> {
			requireText('blueprintId', blueprintId);
			return request<CompiledBlueprint>('GET', '/api/artifacts/' + encodeURIComponent(blueprintId));
		},

		// POST /api/blueprint/compile. Schema violations throw EngineApiError 400 with body.validation_errors.
		compileBlueprint(payload: CompileBlueprintRequest): Promise<CompileBlueprintResult> {
			return request<CompileBlueprintResult>('POST', '/api/blueprint/compile', { body: payload });
		},

		listConnectors(): Promise<{ connectors: ConnectorInfo[] }> {
			return request<{ connectors: ConnectorInfo[] }>('GET', '/api/connectors');
		},

		// GET /api/mcp/servers: the tool servers in the engine's mcp-config.json and whether their keys are set.
		listMcpServers(): Promise<{ servers: { name: string; status: 'ready' | 'missing_keys'; missing_env: string[] }[] }> {
			return request('GET', '/api/mcp/servers');
		},

		testConnector(payload: ConnectorTestRequest): Promise<ConnectorTestResult> {
			return request<ConnectorTestResult>('POST', '/api/connectors/test', { body: payload, timeoutMs: 20_000 });
		},

		architectPrompt(payload: ArchitectRequest): Promise<ArchitectResult> {
			return request<ArchitectResult>('POST', '/api/intake/architect', { body: payload, timeoutMs: 120_000 });
		},

		analyzeIntake(payload: IntakeRequest): Promise<IntakeResult> {
			return request<IntakeResult>('POST', '/api/intake/analyze', { body: payload, timeoutMs: 20_000 });
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
export const getRoadmap: EngineApi['getRoadmap'] = () => getEngineApi().getRoadmap();
export const runProject: EngineApi['runProject'] = (...args) => getEngineApi().runProject(...args);
export const getTaskStatus: EngineApi['getTaskStatus'] = (...args) => getEngineApi().getTaskStatus(...args);
export const compileBlueprint: EngineApi['compileBlueprint'] = (...args) => getEngineApi().compileBlueprint(...args);
export const listTasks: EngineApi['listTasks'] = (...args) => getEngineApi().listTasks(...args);
export const answerTaskChoice: EngineApi['answerTaskChoice'] = (...args) => getEngineApi().answerTaskChoice(...args);
export const listArtifacts: EngineApi['listArtifacts'] = () => getEngineApi().listArtifacts();
export const getArtifact: EngineApi['getArtifact'] = (...args) => getEngineApi().getArtifact(...args);
