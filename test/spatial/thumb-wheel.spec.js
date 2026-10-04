import { describe, expect, it } from "vitest";
import { wheelGrowth } from "../../public/js/spatial/thumb-wheel.js";

describe("wheelGrowth", () => {
	it("keeps the base corner for two and three rings", () => {
		expect(wheelGrowth(["view", "primary"])).toBe(1);
		expect(wheelGrowth(["view", "primary", "inner"])).toBe(1);
		expect(wheelGrowth(["view", "primary"], { collapsed: true })).toBe(1);
	});

	it("grows the corner for four rings instead of squeezing them", () => {
		const grow = wheelGrowth(["view", "primary", "inner", "inner"]);
		expect(grow).toBeGreaterThan(1);
		// Hub 34 + four bands with their gaps (22, 32, 30, 30) + room for the index mark, over the 164 px base.
		expect(grow).toBeCloseTo((34 + 4 * 3 + 22 + 32 + 30 + 30 + 10) / 164, 6);
	});
});
