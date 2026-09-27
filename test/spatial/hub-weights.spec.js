import { describe, expect, it } from "vitest";
import { GLOW_THRESHOLD, HUB_MAX_SCALE, computeHubWeights, glowOpacity, hubScale } from "../../public/js/spatial/hub-weights.js";

const nodes = ["hub", "a", "b", "c", "lone"].map(id => ({ id }));

describe("computeHubWeights", () => {
	it("ranks the most connected node at 1 and unlinked nodes at 0", () => {
		const links = [
			{ source: "hub", target: "a", type: "ai" },
			{ source: "hub", target: "b", type: "ai" },
			{ source: { id: "hub" }, target: { id: "c" }, type: "concept" },
			{ source: "a", target: "b", type: "semantic" },
		];
		const weights = computeHubWeights(nodes, links);
		expect(weights.get("hub")).toBe(1);
		expect(weights.get("lone")).toBe(0);
		expect(weights.get("a")).toBeGreaterThan(weights.get("c"));
		expect(weights.get("a")).toBeLessThan(1);
	});

	it("ignores category chain links, self-loops and links to hidden nodes", () => {
		const links = [
			{ source: "a", target: "b", type: "category" },
			{ source: "a", target: "a", type: "ai" },
			{ source: "a", target: "gone", type: "ai" },
		];
		const weights = computeHubWeights(nodes, links);
		expect([...weights.values()].every(value => value === 0)).toBe(true);
	});

	it("is relative to the visible set", () => {
		const links = [{ source: "a", target: "b", type: "semantic" }];
		expect(computeHubWeights(nodes, links).get("a")).toBe(1);
	});
});

describe("hubScale", () => {
	it("keeps ordinary cards at 1 and tops out at the hub maximum", () => {
		expect(hubScale(0)).toBe(1);
		expect(hubScale(0.15)).toBe(1);
		expect(hubScale(1)).toBeCloseTo(HUB_MAX_SCALE, 10);
		expect(hubScale(0.6)).toBeGreaterThan(1);
		expect(hubScale(0.6)).toBeLessThan(HUB_MAX_SCALE);
	});
});

describe("glowOpacity", () => {
	it("glows only past the threshold, rising to 0.45 at the top hub", () => {
		expect(glowOpacity(0)).toBe(0);
		expect(glowOpacity(GLOW_THRESHOLD)).toBe(0);
		expect(glowOpacity(GLOW_THRESHOLD + 0.01)).toBeGreaterThan(0.12);
		expect(glowOpacity(1)).toBeCloseTo(0.45, 10);
		expect(glowOpacity(Number.NaN)).toBe(0);
	});
});
