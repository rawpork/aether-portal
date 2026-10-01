import { describe, expect, it } from 'vitest';
import { createEngineApi, EngineApiError } from '../../src/services/engineApi.ts';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function mockFetch(status = 200, body: unknown = {}) {
	const calls: Call[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({
			url,
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
			body: init.body ? JSON.parse(init.body as string) : undefined,
		});
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe('engineApi', () => {
	it('maps every helper to its engine route', async () => {
		const { calls, fetchImpl } = mockFetch();
		const api = createEngineApi({ baseUrl: 'http://engine.test/', fetch: fetchImpl, getToken: () => 'jwt' });
		await api.getEngineHealth();
		await api.tripBreaker('agent 1', 'stop', { session_tokens: { input: 1, output: 2 } });
		await api.resetBreaker('agent 1');
		await api.getAgentState('agent 1');
		await api.sendMasterBrainChat('hi', 's1', { agentId: 'mb' });
		await api.executeSubAgentTask('a', 't', [{ step_id: 's', action: 'echo' }]);
		await api.getTaskStatus('a', 't/1');
		await api.compileBlueprint({ links: [{ url: 'https://example.com' }] });

		expect(calls.map(c => c.method + ' ' + c.url)).toEqual([
			'GET http://engine.test/health',
			'POST http://engine.test/api/agents/trip-breaker',
			'POST http://engine.test/api/agents/reset',
			'GET http://engine.test/api/agents/agent%201/state',
			'POST http://engine.test/api/master-brain/chat',
			'POST http://engine.test/api/agents/execute-task',
			'GET http://engine.test/api/agents/a/tasks/t%2F1',
			'POST http://engine.test/api/blueprint/compile',
		]);
		expect(calls[1].body).toEqual({ agent_id: 'agent 1', reason: 'stop', session_tokens: { input: 1, output: 2 } });
		expect(calls[4].body).toEqual({ session_id: 's1', message: 'hi', agent_id: 'mb' });
		expect(calls[5].body).toEqual({ agent_id: 'a', task_id: 't', steps: [{ step_id: 's', action: 'echo' }] });
	});

	it('attaches the bearer token to /api calls only', async () => {
		const { calls, fetchImpl } = mockFetch();
		const api = createEngineApi({ fetch: fetchImpl, getToken: () => 'secret-jwt' });
		await api.getEngineHealth();
		await api.getAgentState('a');
		expect(calls[0].headers.Authorization).toBeUndefined();
		expect(calls[1].headers.Authorization).toBe('Bearer secret-jwt');
	});

	it('omits the header when no token is available (local bypass)', async () => {
		const { calls, fetchImpl } = mockFetch();
		await createEngineApi({ fetch: fetchImpl, getToken: () => null }).getAgentState('a');
		expect(calls[0].headers.Authorization).toBeUndefined();
	});

	it('reads the token from localStorage by default', async () => {
		const store = new Map([['aether.engine.jwt', 'stored-jwt']]);
		const previous = (globalThis as any).localStorage;
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null };
		try {
			const { calls, fetchImpl } = mockFetch();
			await createEngineApi({ fetch: fetchImpl }).getAgentState('a');
			expect(calls[0].headers.Authorization).toBe('Bearer stored-jwt');
		} finally {
			(globalThis as any).localStorage = previous;
		}
	});

	it('resolves a 423 task halt as an outcome', async () => {
		const halted = { status: 'HALTED', interrupted_step_index: 2, completed_steps: 2, results: [] };
		const { fetchImpl } = mockFetch(423, halted);
		const outcome = await createEngineApi({ fetch: fetchImpl }).executeSubAgentTask('a', 't', [{ step_id: 's', action: 'echo' }]);
		expect(outcome.status).toBe('HALTED');
	});

	it('throws EngineApiError with the engine body on other failures', async () => {
		const { fetchImpl } = mockFetch(423, { error: 'Agent execution is currently HALTED by circuit breaker', status: 'HALTED' });
		const error = await createEngineApi({ fetch: fetchImpl }).sendMasterBrainChat('hi', 's').catch(e => e);
		expect(error).toBeInstanceOf(EngineApiError);
		expect(error.isHalted).toBe(true);
		expect(error.message).toMatch(/HALTED/);
	});

	it('reports an unreachable engine as status 0', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		const error = await createEngineApi({ fetch: fetchImpl }).getEngineHealth().catch(e => e);
		expect(error).toBeInstanceOf(EngineApiError);
		expect(error.isUnreachable).toBe(true);
	});

	it('rejects blank identifiers before calling the engine', async () => {
		const { calls, fetchImpl } = mockFetch();
		await expect(createEngineApi({ fetch: fetchImpl }).getAgentState(' ')).rejects.toThrow(TypeError);
		expect(calls).toHaveLength(0);
	});
});
