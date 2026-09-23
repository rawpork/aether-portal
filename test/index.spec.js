import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

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
});
