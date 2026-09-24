import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { needsWebResearch } from "../src/index.js";

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

describe("Aether Portal worker", () => {
	it("serves the graph UI with a client script that parses", async () => {
		const response = await SELF.fetch("http://example.com/");
		const html = await response.text();
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(html).toContain("Aether Portal");

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
