import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { TELEGRAM_COMMANDS, buildTelegramHelp, chunkTelegramMessage, formatTelegramAnswer, hashPassword, needsWebResearch, parseResearch, parseTelegramCommand, rankNodesForQuestion, signSession, splitLinkMessage, verifyPassword, verifySession } from "../src/index.js";

describe("needsWebResearch", () => {
	it("routes research-intent questions to the search tier", () => {
		for (const q of ["research moving to Lisbon", "what's the latest on Bun", "current rates for mortgages", "find online reviews", "any news about X", "Searching for options"]) {
			expect(needsWebResearch(q), q).toBe(true);
		}
	});

	it("keeps note, graph and coding questions on the fast tier", () => {
		for (const q of ["summarize these notes", "how do these nodes relate", "write a function to sort", "newsletter ideas", ""]) {
			expect(needsWebResearch(q), q).toBe(false);
		}
	});
});

describe("parseResearch", () => {
	it("reads saved Q&A entries and drops malformed ones", () => {
		const saved = JSON.stringify([{ question: "q1", answer: "a1", sources: [] }, { question: "no answer" }, null]);
		expect(parseResearch(saved)).toEqual([{ question: "q1", answer: "a1", sources: [] }]);
	});

	it("treats empty or corrupt values as no history", () => {
		for (const value of [null, "", "not json", "{}"]) {
			expect(parseResearch(value), String(value)).toEqual([]);
		}
	});
});

describe("splitLinkMessage", () => {
	it("returns plain text as a note with no URL", () => {
		expect(splitLinkMessage("  call the supplier  ")).toEqual({ url: "", note: "call the supplier" });
	});

	it("splits a URL from comments before or after it", () => {
		expect(splitLinkMessage("https://example.com/a?b=1 great pricing page")).toEqual({ url: "https://example.com/a?b=1", note: "great pricing page" });
		expect(splitLinkMessage("look at this: https://example.com/x")).toEqual({ url: "https://example.com/x", note: "look at this" });
		expect(splitLinkMessage("https://example.com")).toEqual({ url: "https://example.com", note: "" });
	});

	it("keeps sentence punctuation and unbalanced parentheses out of the URL", () => {
		expect(splitLinkMessage("see https://example.com/page.").url).toBe("https://example.com/page");
		expect(splitLinkMessage("(via https://example.com/a)").url).toBe("https://example.com/a");
		expect(splitLinkMessage("https://en.wikipedia.org/wiki/Mercury_(planet) neat").url).toBe("https://en.wikipedia.org/wiki/Mercury_(planet)");
	});

	it("keeps line breaks in the note", () => {
		expect(splitLinkMessage("https://example.com\nline one\nline two").note).toBe("line one\nline two");
	});
});

describe("parseTelegramCommand", () => {
	it("splits the command from its arguments, with or without a bot mention", () => {
		expect(parseTelegramCommand("/note buy milk")).toEqual({ command: "note", args: "buy milk" });
		expect(parseTelegramCommand("/Research@AetherBot  vector dbs\nfor teams")).toEqual({ command: "research", args: "vector dbs\nfor teams" });
		expect(parseTelegramCommand("/help")).toEqual({ command: "help", args: "" });
	});

	it("ignores ordinary text and paths", () => {
		expect(parseTelegramCommand("note to self")).toBeNull();
		expect(parseTelegramCommand("/Users/me/file.txt")).toBeNull();
		expect(parseTelegramCommand("https://example.com/ask")).toBeNull();
	});
});

describe("Telegram command guide", () => {
	it("lists every registered command and the pairing window", () => {
		const help = buildTelegramHelp();
		for (const { command, usage } of TELEGRAM_COMMANDS) {
			expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
			expect(help).toContain(usage);
		}
		expect(help).toContain("within 2 minutes");
	});
});

describe("rankNodesForQuestion", () => {
	const nodes = [
		{ id: "recent", title: "Grocery list", description: "milk" },
		{ id: "body", title: "Notes", description: "Pricing tiers for the pro plan" },
		{ id: "title", title: "Pricing ideas", description: "" },
		{ id: "old", title: "Old thing", description: "" }
	];

	it("puts title matches first, then body matches, then the rest in order", () => {
		expect(rankNodesForQuestion(nodes, "What about pricing?", 10).map(n => n.id)).toEqual(["title", "body", "recent", "old"]);
	});

	it("respects the limit and falls back to the given order without matches", () => {
		expect(rankNodesForQuestion(nodes, "the and of", 2).map(n => n.id)).toEqual(["recent", "body"]);
	});
});

describe("formatTelegramAnswer and chunkTelegramMessage", () => {
	it("adds the heading, web marker and at most five sources", () => {
		const sources = Array.from({ length: 7 }, (_, i) => ({ title: "S" + i, uri: "https://s" + i + ".example" }));
		const text = formatTelegramAnswer("🔎 Research", { answer: "Answer.", sources, tier: 2 });
		expect(text.startsWith("🔎 Research · web-grounded\n\nAnswer.\n\nSources:\n- S0 — https://s0.example")).toBe(true);
		expect(text).not.toContain("S5");
		expect(formatTelegramAnswer("", { answer: "Plain", sources: [], tier: 1 })).toBe("Plain");
	});

	it("splits long text at paragraph breaks under the limit", () => {
		const paragraph = "word ".repeat(150).trim();
		const chunks = chunkTelegramMessage([paragraph, paragraph, paragraph].join("\n\n"), 1000);
		expect(chunks.length).toBe(3);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
		expect(chunks.join("\n\n")).toBe([paragraph, paragraph, paragraph].join("\n\n"));
		expect(chunkTelegramMessage("short")).toEqual(["short"]);
	});
});

describe("password hashing", () => {
	it("verifies the right password and rejects others", async () => {
		const stored = await hashPassword("correct horse battery");
		expect(await verifyPassword("correct horse battery", stored)).toBe(true);
		expect(await verifyPassword("wrong password", stored)).toBe(false);
		expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
	});
});

describe("session tokens", () => {
	it("round-trips a signed session and rejects tampering, other secrets and expiry", async () => {
		const token = await signSession("user_owner", "secret-a", 1_000_000);
		expect(await verifySession(token, "secret-a", 1_000_000)).toEqual({ id: "user_owner" });
		expect(await verifySession(token, "secret-b", 1_000_000)).toBeNull();
		expect(await verifySession(token.slice(0, -2) + "xx", "secret-a", 1_000_000)).toBeNull();
		expect(await verifySession(token, "secret-a", 1_000_000 + 31 * 24 * 60 * 60 * 1000)).toBeNull();
	});
});

describe("Aether Portal worker", () => {
	it("serves the graph UI with a client script that parses", async () => {
		const response = await SELF.fetch("http://example.com/");
		const html = await response.text();
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(html).toContain("Aether Portal");
		for (const id of ["view-switch", "collection-view", "collection-items", "login-gate", "reader-modal", "telegram-help-button", "telegram-help-modal"]) {
			expect(html, id).toContain(`id="${id}"`);
		}
		for (const usage of ["/research &lt;topic or link&gt;", "/ask &lt;question&gt;", "/link &lt;url&gt; [note]", "/help"]) {
			expect(html, usage).toContain(usage);
		}
		for (const view of ["graph", "list", "timeline"]) {
			expect(html, view).toContain(`data-view="${view}"`);
		}

		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
		expect(scripts.length).toBeGreaterThan(0);
		for (const script of scripts) {
			expect(() => new Function(script)).not.toThrow();
		}
	});

	it("rejects webhook POSTs without the Telegram secret header", async () => {
		const response = await SELF.fetch("http://example.com/", {
			method: "POST",
			body: JSON.stringify({ message: { text: "hi", chat: { id: 1 } } }),
		});
		expect(response.status).toBe(401);
	});

	it("rejects POSTs to unknown paths", async () => {
		const response = await SELF.fetch("http://example.com/anything", { method: "POST" });
		expect(response.status).toBe(404);
	});

	it("only allows POST on /api/recluster", async () => {
		const response = await SELF.fetch("http://example.com/api/recluster");
		expect(response.status).toBe(405);
	});

	it("requires an admin token for /api/recluster", async () => {
		const response = await SELF.fetch("http://example.com/api/recluster", {
			method: "POST",
			headers: { Authorization: "Bearer wrong" },
		});
		expect(response.status).toBe(401);
	});

	it("only allows POST on /api/backfill-metadata", async () => {
		const response = await SELF.fetch("http://example.com/api/backfill-metadata");
		expect(response.status).toBe(405);
	});

	it("requires an admin token for /api/backfill-metadata", async () => {
		const response = await SELF.fetch("http://example.com/api/backfill-metadata", {
			method: "POST",
			headers: { Authorization: "Bearer wrong" },
		});
		expect(response.status).toBe(401);
	});

	it("only allows POST on /api/node", async () => {
		const response = await SELF.fetch("http://example.com/api/node");
		expect(response.status).toBe(405);
	});

	it("requires an admin token to create a node", async () => {
		const response = await SELF.fetch("http://example.com/api/node", {
			method: "POST",
			headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
			body: JSON.stringify({ title: "hi", category: "note" }),
		});
		expect(response.status).toBe(401);
	});

	it("only allows DELETE on /api/node/:id", async () => {
		const response = await SELF.fetch("http://example.com/api/node/abc");
		expect(response.status).toBe(405);
	});

	it("requires an admin token to delete a node", async () => {
		const response = await SELF.fetch("http://example.com/api/node/abc", {
			method: "DELETE",
			headers: { Authorization: "Bearer wrong" },
		});
		expect(response.status).toBe(401);
	});

	it("only allows POST on /api/ask", async () => {
		const response = await SELF.fetch("http://example.com/api/ask");
		expect(response.status).toBe(405);
	});

	it("requires an admin token for /api/ask", async () => {
		const response = await SELF.fetch("http://example.com/api/ask", {
			method: "POST",
			headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
			body: JSON.stringify({ question: "hi", nodeIds: ["abc"] }),
		});
		expect(response.status).toBe(401);
	});
});
