// Elarion conversation storage (migrations/0020_conversations.sql). The browser saves each exchange here as it happens and loads
// the thread back when the drawer opens, so a conversation outlives the page. Each thread is also filed in records as a
// 'conversation' (title, project, and a summary of its latest messages) so Elarion can find what was discussed.
// Threads: "main", or "project:<blueprint id>" for talk about one project. Every query is scoped to one user.
import { upsertRecord } from "./records.js";

export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,119}$/;
export const MESSAGE_MAX_CHARS = 8000;
export const BATCH_MAX = 20;
export const THREAD_KEEP_MESSAGES = 500;
export const THREAD_READ_DEFAULT = 100;
export const THREAD_READ_MAX = 200;
const SUMMARY_MESSAGES = 6;
const SUMMARY_MAX_CHARS = 1500;
const ROLES = ["user", "assistant"];

const clip = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

export function summarizeMessages(messages) {
	return messages.slice(-SUMMARY_MESSAGES).map(m => (m.role === "user" ? "You: " : "Elarion: ") + clip(m.content, 400).replace(/\s+/g, " ")).join(" | ").slice(0, SUMMARY_MAX_CHARS);
}

// Appends messages to a thread (creating it) and refreshes the thread's record. Returns { thread_id, saved } or { error }.
export async function appendMessages(env, userId, threadId, body) {
	if (!THREAD_ID_PATTERN.test(String(threadId))) return { error: "thread id must be 1-120 letters, digits, : _ . -" };
	const incoming = Array.isArray(body && body.messages) ? body.messages : [];
	if (!incoming.length || incoming.length > BATCH_MAX) return { error: "Send 1 to " + BATCH_MAX + " messages." };
	const messages = [];
	for (const m of incoming) {
		const role = m && m.role;
		const content = clip(m && m.content, MESSAGE_MAX_CHARS);
		if (!ROLES.includes(role) || !content) return { error: "Each message needs a role (user or assistant) and content." };
		messages.push({ role, content });
	}
	const projectId = clip(body.project_id, 200) || (threadId.startsWith("project:") ? threadId.slice(8) : null);
	const suppliedTitle = clip(body.title, 200);
	const title = suppliedTitle || (projectId ? "Project conversation" : "Elarion conversation");
	const now = Date.now();
	await env.DB.batch([
		...messages.map((m, i) => env.DB.prepare("INSERT INTO conversation_messages (user_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, threadId, m.role, m.content, now + i)),
		env.DB.prepare(
			"INSERT INTO conversations (id, user_id, project_id, title, message_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT (user_id, id) DO UPDATE SET title = CASE WHEN ? = 1 THEN excluded.title ELSE title END, project_id = COALESCE(excluded.project_id, project_id), message_count = message_count + excluded.message_count, updated_at = excluded.updated_at",
		).bind(threadId, userId, projectId, title, messages.length, now, now, suppliedTitle ? 1 : 0),
		// Bounded: the oldest messages beyond the keep limit go.
		env.DB.prepare("DELETE FROM conversation_messages WHERE user_id = ? AND thread_id = ? AND id <= (SELECT id FROM conversation_messages WHERE user_id = ? AND thread_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)")
			.bind(userId, threadId, userId, threadId, THREAD_KEEP_MESSAGES),
	]);
	const { results } = await env.DB.prepare("SELECT role, content FROM conversation_messages WHERE user_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?").bind(userId, threadId, SUMMARY_MESSAGES).all();
	await upsertRecord(env, userId, {
		id: "thread:" + threadId,
		type: "conversation",
		title: (await env.DB.prepare("SELECT title FROM conversations WHERE user_id = ? AND id = ?").bind(userId, threadId).first()).title,
		summary: summarizeMessages((results || []).reverse()),
		project_id: projectId,
		body_ref: "conversation:" + threadId,
		tags: ["conversation", ...(projectId ? ["project"] : [])],
	});
	return { thread_id: threadId, saved: messages.length };
}

// The newest messages of a thread, oldest first. Null when the thread does not exist.
export async function getThread(env, userId, threadId, limit) {
	const thread = await env.DB.prepare("SELECT id, project_id, title, message_count, created_at, updated_at FROM conversations WHERE user_id = ? AND id = ?").bind(userId, threadId).first();
	if (!thread) return null;
	const n = Math.min(Math.max(Math.floor(Number(limit)) || THREAD_READ_DEFAULT, 1), THREAD_READ_MAX);
	const { results } = await env.DB.prepare("SELECT role, content, created_at FROM conversation_messages WHERE user_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?").bind(userId, threadId, n).all();
	return { ...thread, messages: (results || []).reverse() };
}

export async function listThreads(env, userId, { project_id } = {}) {
	const { results } = project_id
		? await env.DB.prepare("SELECT id, project_id, title, message_count, updated_at FROM conversations WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 50").bind(userId, String(project_id)).all()
		: await env.DB.prepare("SELECT id, project_id, title, message_count, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50").bind(userId).all();
	return { threads: results || [] };
}

export async function deleteThread(env, userId, threadId) {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM conversation_messages WHERE user_id = ? AND thread_id = ?").bind(userId, threadId),
		env.DB.prepare("DELETE FROM conversations WHERE user_id = ? AND id = ?").bind(userId, threadId),
		env.DB.prepare("DELETE FROM records WHERE user_id = ? AND id = ?").bind(userId, "thread:" + threadId),
	]);
}
