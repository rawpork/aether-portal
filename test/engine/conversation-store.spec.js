import { expect, it, vi } from 'vitest';
import { createConversationStore, replayContext } from '../../public/js/engine/conversation-store.js';

it('loads, saves and clears a thread through the portal, encoding the thread id', async () => {
	const portalFetch = vi.fn(async () => new Response(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), { status: 200 }));
	const store = createConversationStore(portalFetch);
	expect(await store.load('project:bp 1')).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
	expect(portalFetch.mock.calls[0][0]).toBe('/api/conversations/project%3Abp%201?limit=60');
	await store.save('main', [{ role: 'user', content: 'x' }], { title: 'T', project_id: 'p' });
	expect(portalFetch.mock.calls[1][1].method).toBe('POST');
	expect(JSON.parse(portalFetch.mock.calls[1][1].body)).toEqual({ messages: [{ role: 'user', content: 'x' }], title: 'T', project_id: 'p' });
	await store.clear('main');
	expect(portalFetch.mock.calls[2][1].method).toBe('DELETE');
});

it('returns null instead of throwing when the portal fails or is missing', async () => {
	expect(await createConversationStore(async () => { throw new Error('offline'); }).load('main')).toBe(null);
	expect(await createConversationStore(async () => new Response('{}', { status: 404 })).load('main')).toBe(null);
	expect(await createConversationStore(null).save('main', [])).toBe(null);
});

it('replays only the last few messages, shortened', () => {
	const many = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: String(i).repeat(900) }));
	const replay = replayContext(many);
	expect(replay).toHaveLength(8);
	expect(replay[0].content.length).toBe(500);
	expect(replay[0].content.startsWith('4')).toBe(true);
});
