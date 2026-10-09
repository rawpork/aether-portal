// Approvals over Telegram. The engine asks (POST /api/approvals/telegram) when a run waits for you; the bot sends the question with
// one button per option; a tap is checked against the chat you linked and recorded; the engine collects the answers it has not seen
// yet (GET /api/approvals/pending) and acknowledges each (POST /api/approvals/:id/delivered). The engine only ever calls out, so
// the portal never drives your machine. A text reply such as "approve" is never an answer: only a button tap on the request is.

export const APPROVAL_TTL_MS = 35 * 60 * 1000;
const DETAIL_MAX = 3000;
const CALLBACK = /^ap:([A-Za-z0-9]{12}):([1-9])$/;

const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const clip = (value, max) => (String(value || "").length > max ? String(value).slice(0, max - 1) + "…" : String(value || ""));

// Returns { status, body }. telegram.send(env, chatId, text, buttons) returns Telegram's response (json with result.message_id).
export async function createApprovalRequest(env, userId, body, telegram, now = Date.now()) {
	const options = Array.isArray(body && body.options) ? body.options.map((o) => clip(o, 60)).filter(Boolean).slice(0, 4) : [];
	const run = body && String(body.run_id || "");
	if (!run || !body.agent_id || !body.task_id || options.length < 2) return { status: 400, body: { error: "agent_id, task_id, run_id and at least two options are required." } };
	if (!env.TELEGRAM_TOKEN) return { status: 503, body: { error: "The Telegram bot is not configured on the portal." } };
	const user = await env.DB.prepare("SELECT telegram_chat_id FROM users WHERE id = ?").bind(userId).first();
	if (!user || !user.telegram_chat_id) return { status: 409, body: { error: "Link your Telegram chat first." } };
	const id = newId();
	await env.DB.prepare("INSERT INTO approval_requests (id, user_id, chat_id, agent_id, task_id, run_id, question, options, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(id, userId, String(user.telegram_chat_id), String(body.agent_id), String(body.task_id), run, clip(body.question, 600), JSON.stringify(options), now, now + APPROVAL_TTL_MS).run();
	const text = ["Needs your approval", clip(body.question, 600), body.detail ? clip(body.detail, DETAIL_MAX) : "", "Tap a button. This stays open for 30 minutes."].filter(Boolean).join("\n\n");
	const response = await telegram.send(env, user.telegram_chat_id, text, options.map((label, i) => ({ text: label, callback_data: "ap:" + id + ":" + (i + 1) })));
	if (!response || !response.ok) {
		await env.DB.prepare("DELETE FROM approval_requests WHERE id = ?").bind(id).run();
		return { status: 502, body: { error: "Telegram did not accept the message." } };
	}
	return { status: 200, body: { id } };
}

// A button tap. update.callback_query = { id, from, message: { chat, message_id }, data }. Returns the text to flash and the new
// message text (or null to leave it).
export async function handleApprovalCallback(env, query, telegram, now = Date.now()) {
	const match = CALLBACK.exec(String((query && query.data) || ""));
	if (!match) return null; // not an approval button
	const chatId = String(query.message && query.message.chat && query.message.chat.id);
	const row = await env.DB.prepare("SELECT * FROM approval_requests WHERE id = ?").bind(match[1]).first();
	const linked = row && await env.DB.prepare("SELECT id FROM users WHERE telegram_chat_id = ?").bind(chatId).first();
	let flash;
	let edit = null;
	if (!row || !linked || linked.id !== row.user_id || chatId !== row.chat_id) {
		flash = "This is not your approval.";
	} else {
		const options = JSON.parse(row.options);
		const n = Number(match[2]);
		if (row.chosen) {
			flash = "Already answered: " + options[row.chosen - 1] + ".";
		} else if (now > row.expires_at) {
			flash = "This approval has expired.";
			edit = "Expired: nobody answered in time.";
		} else if (n > options.length) {
			flash = "That is not an option.";
		} else {
			const result = await env.DB.prepare("UPDATE approval_requests SET chosen = ? WHERE id = ? AND chosen IS NULL").bind(n, row.id).run();
			flash = result && result.meta && result.meta.changes === 0 ? "Already answered." : "Got it: " + options[n - 1] + ".";
			edit = "Answered: " + options[n - 1] + ".";
		}
	}
	await telegram.answer(env, query.id, flash);
	if (edit && query.message) await telegram.edit(env, chatId, query.message.message_id, edit);
	return { flash, edit };
}

// Answers the engine has not collected yet (and that have not expired).
export async function pendingApprovalAnswers(env, userId, now = Date.now()) {
	const { results } = await env.DB.prepare("SELECT id, agent_id, task_id, run_id, chosen FROM approval_requests WHERE user_id = ? AND chosen IS NOT NULL AND delivered = 0 AND created_at > ?").bind(userId, now - 24 * 3600 * 1000).all();
	return (results || []).map((r) => ({ id: r.id, agent_id: r.agent_id, task_id: r.task_id, run_id: r.run_id, option: r.chosen }));
}

export async function markApprovalDelivered(env, userId, id) {
	const result = await env.DB.prepare("UPDATE approval_requests SET delivered = 1 WHERE id = ? AND user_id = ?").bind(id, userId).run();
	return result && result.meta && result.meta.changes === 0 ? { status: 404, body: { error: "No such approval." } } : { status: 200, body: { delivered: true } };
}
