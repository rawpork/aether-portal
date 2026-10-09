// Connector endpoints the engine calls on a user's behalf (the engine holds no bot token; the portal does). Telegram: a message to the
// user's own chat with the bot, the chat they linked in Settings. Nothing here can message anyone else.

export const TELEGRAM_TEXT_MAX = 3900;

// Returns { status, body }. send(env, chatId, text) is the bot call (injected so it can be tested).
export async function sendTelegramToUser(env, userId, text, send) {
	const message = typeof text === "string" ? text.trim().slice(0, TELEGRAM_TEXT_MAX) : "";
	if (!message) return { status: 400, body: { error: "text is required." } };
	if (!env.TELEGRAM_TOKEN) return { status: 503, body: { error: "The Telegram bot is not configured on the portal." } };
	const user = await env.DB.prepare("SELECT telegram_chat_id FROM users WHERE id = ?").bind(userId).first();
	if (!user || !user.telegram_chat_id) return { status: 409, body: { error: "Link your Telegram chat first (message the bot once, then add your chat id in Settings)." } };
	const response = await send(env, user.telegram_chat_id, message);
	return response && response.ok ? { status: 200, body: { sent: true } } : { status: 502, body: { error: "Telegram did not accept the message." } };
}
