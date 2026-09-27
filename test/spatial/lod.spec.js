import { describe, expect, it } from "vitest";
import { LOD_MIN_RADIUS, lodFactor, lodGoal } from "../../public/js/spatial/lod.js";

describe("lodFactor", () => {
	it("shows cards up close and the proxy far away, easing in between", () => {
		expect(lodFactor(50, 20)).toBe(0);
		expect(lodFactor(200, 20)).toBe(1);
		const mid = lodFactor(100, 20);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
	});

	it("treats small clusters as at least the minimum radius", () => {
		expect(lodFactor(3.4 * LOD_MIN_RADIUS, 2)).toBe(0);
	});
});

describe("lodGoal", () => {
	it("keeps cards in short scopes, collapses everything in Groups, and follows distance in All time", () => {
		expect(lodGoal({ distance: 1000, radius: 20, mode: "cards" })).toBe(0);
		expect(lodGoal({ distance: 10, radius: 20, mode: "groups" })).toBe(1);
		expect(lodGoal({ distance: 1000, radius: 20, mode: "auto" })).toBe(1);
		expect(lodGoal({ distance: 10, radius: 20, mode: "auto" })).toBe(0);
	});

	it("always shows the cards of the cluster being worked in", () => {
		expect(lodGoal({ distance: 1000, radius: 20, mode: "groups", active: true })).toBe(0);
		expect(lodGoal({ distance: 1000, radius: 20, mode: "auto", active: true })).toBe(0);
	});
});
