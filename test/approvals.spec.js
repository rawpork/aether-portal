import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import approvals from "../migrations/0022_approvals.sql?raw";
import { APPROVAL_TTL_MS, createApprovalRequest, handleApprovalCallback, markApprovalDelivered, pendingApprovalAnswers } from "../src/approvals.js";

const sql = approvals.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").split(";").map((s) => s.trim()).filter(Boolean);

beforeAll(async () => {
	await env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, telegram_chat_id TEXT)").run();
	for (const statement of sql) await env.DB.prepare(statement).run();
});
beforeEach(async () => {
	await env.DB.prepare("DELETE FROM approval_requests").run();
	await env.DB.prepare("DELETE FROM users").run();
	await env.DB.prepare("INSERT INTO users (id, telegram_chat_id) VALUES ('u1', '555'), ('u2', '777')").run();
});

const fake = () => {
	const calls = { send: [], answer: [], edit: [] };
	return {
		calls,
		send: async (_env, chat, text, buttons) => { calls.send.push({ chat, text, buttons }); return { ok: true }; },
		answer: async (_env, id, text) => { calls.answer.push({ id, text }); },
		edit: async (_env, chat, mid, text) => { calls.edit.push({ chat, mid, text }); },
	};
};
const body = { agent_id: "workflow:wf1", task_id: "t1", run_id: "r1", question: "Approve before publishing", detail: "Latest work: the page", options: ["Approve and continue", "Stop the run here"] };
const tap = (data, chat = 555) => ({ id: "cq1", data, message: { chat: { id: chat }, message_id: 9 } });

describe("Telegram approvals", () => {
	const E = () => ({ ...env, TELEGRAM_TOKEN: "t" });

	it("sends the question and the work with one button per option, to the linked chat", async () => {
		const t = fake();
		const result = await createApprovalRequest(E(), "u1", body, t);
		expect(result.status).toBe(200);
		expect(t.calls.send[0].chat).toBe("555");
		expect(t.calls.send[0].text).toContain("Approve before publishing");
		expect(t.calls.send[0].text).toContain("Latest work: the page");
		expect(t.calls.send[0].buttons.map((b) => b.text)).toEqual(["Approve and continue", "Stop the run here"]);
		expect(t.calls.send[0].buttons[0].callback_data).toBe("ap:" + result.body.id + ":1");
		expect(t.calls.send[0].buttons[0].callback_data.length).toBeLessThanOrEqual(64);
	});

	it("refuses a bad request, no bot, no linked chat, or when Telegram refuses (and keeps no row)", async () => {
		const t = fake();
		expect((await createApprovalRequest(E(), "u1", { ...body, options: ["only one"] }, t)).status).toBe(400);
		expect((await createApprovalRequest({ ...env, TELEGRAM_TOKEN: "" }, "u1", body, t)).status).toBe(503);
		expect((await createApprovalRequest(E(), "nobody", body, t)).status).toBe(409);
		expect((await createApprovalRequest(E(), "u1", body, { ...t, send: async () => ({ ok: false }) })).status).toBe(502);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approval_requests").first()).n).toBe(0);
	});

	it("records a tap from the linked chat once, lets the engine collect it, and never twice", async () => {
		const t = fake();
		const { body: made } = await createApprovalRequest(E(), "u1", body, t);
		const first = await handleApprovalCallback(E(), tap("ap:" + made.id + ":1"), t);
		expect(first.flash).toBe("Got it: Approve and continue.");
		expect(t.calls.edit[0].text).toBe("Answered: Approve and continue.");
		const second = await handleApprovalCallback(E(), tap("ap:" + made.id + ":2"), t);
		expect(second.flash).toBe("Already answered: Approve and continue.");
		expect(await pendingApprovalAnswers(E(), "u1")).toEqual([{ id: made.id, agent_id: "workflow:wf1", task_id: "t1", run_id: "r1", option: 1 }]);
		expect((await markApprovalDelivered(E(), "u1", made.id)).status).toBe(200);
		expect(await pendingApprovalAnswers(E(), "u1")).toEqual([]);
		expect((await markApprovalDelivered(E(), "u2", made.id)).status).toBe(404);
	});

	it("ignores a tap from another chat, an expired request, and buttons that are not approvals", async () => {
		const t = fake();
		const { body: made } = await createApprovalRequest(E(), "u1", body, t, 1000);
		expect((await handleApprovalCallback(E(), tap("ap:" + made.id + ":1", 777), t)).flash).toBe("This is not your approval.");
		expect((await handleApprovalCallback(E(), tap("ap:" + made.id + ":1"), t, 1000 + APPROVAL_TTL_MS + 1)).flash).toBe("This approval has expired.");
		expect(await handleApprovalCallback(E(), tap("something:else"), t)).toBeNull();
		expect(await pendingApprovalAnswers(E(), "u1", 2000)).toEqual([]);
	});

	it("the routes need a signed-in session or an engine token", async () => {
		expect((await SELF.fetch("https://example.com/api/approvals/pending")).status).toBe(401);
		expect((await SELF.fetch("https://example.com/api/approvals/telegram", { method: "POST", body: "{}" })).status).toBe(401);
		expect((await SELF.fetch("https://example.com/api/approvals/abc123/delivered", { method: "POST" })).status).toBe(401);
	});
});
