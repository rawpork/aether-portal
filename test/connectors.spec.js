import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sendTelegramToUser, TELEGRAM_TEXT_MAX } from "../src/connectors.js";

const envWith = (row, extra = {}) => ({ TELEGRAM_TOKEN: "t", DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) }, ...extra });
const ok = async () => ({ ok: true });

describe("Telegram connector", () => {
	it("sends to the user's own linked chat, trimmed to Telegram's limit", async () => {
		const sent = [];
		const result = await sendTelegramToUser(envWith({ telegram_chat_id: "123" }), "u1", "  " + "x".repeat(5000), async (_env, chat, text) => { sent.push([chat, text.length]); return { ok: true }; });
		expect(result).toEqual({ status: 200, body: { sent: true } });
		expect(sent).toEqual([["123", TELEGRAM_TEXT_MAX]]);
	});

	it("says plainly when there is nothing to send, no bot, no linked chat, or Telegram refuses", async () => {
		expect((await sendTelegramToUser(envWith({ telegram_chat_id: "1" }), "u1", "  ", ok)).status).toBe(400);
		expect((await sendTelegramToUser(envWith({ telegram_chat_id: "1" }, { TELEGRAM_TOKEN: "" }), "u1", "hi", ok)).status).toBe(503);
		const unlinked = await sendTelegramToUser(envWith({ telegram_chat_id: null }), "u1", "hi", ok);
		expect([unlinked.status, unlinked.body.error]).toEqual([409, expect.stringMatching(/Link your Telegram/)]);
		expect((await sendTelegramToUser(envWith({ telegram_chat_id: "1" }), "u1", "hi", async () => ({ ok: false }))).status).toBe(502);
	});

	it("the route needs a signed-in session or an engine token", async () => {
		expect((await SELF.fetch("https://example.com/api/connectors/telegram/send", { method: "POST", body: "{}" })).status).toBe(401);
		expect((await SELF.fetch("https://example.com/api/connectors/telegram/send")).status).toBe(405);
	});
});
