// The browser's side of conversation storage (src/conversations.js): a thread is loaded when the drawer needs it and each message is
// saved as it is sent or answered, so a conversation outlives the page and can be found again. Best effort: chat works the same
// without it, so every call swallows its own failure.
export const REPLAY_MESSAGES = 8;
const REPLAY_CHARS = 500;
const url = (thread) => '/api/conversations/' + encodeURIComponent(thread);

export function createConversationStore(portalFetch) {
  const call = async (path, init) => {
    if (!portalFetch) return null;
    try {
      const response = await portalFetch(path, init);
      return response && response.ok ? await response.json().catch(() => ({})) : null;
    } catch {
      return null;
    }
  };
  return {
    // { messages: [{ role, content }] } or null (no such thread, or the portal could not be reached).
    load: (thread, limit = 60) => call(url(thread) + '?limit=' + limit),
    save: (thread, messages, { title, project_id } = {}) =>
      call(url(thread), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, title, project_id }) }),
    clear: (thread) => call(url(thread), { method: 'DELETE' }),
  };
}

// The last few messages as context for the first message after a thread is reloaded: the engine's own memory of it may be gone
// (a restart, another device), so it is reminded of what was said.
export function replayContext(messages) {
  return (messages || []).slice(-REPLAY_MESSAGES).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, REPLAY_CHARS) }));
}
