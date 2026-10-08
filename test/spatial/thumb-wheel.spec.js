import { describe, expect, it } from "vitest";
import { labelOpacity, wheelGrowth } from "../../public/js/spatial/thumb-wheel.js";

describe("wheelGrowth", () => {
	it("keeps the base corner for two and three rings", () => {
		expect(wheelGrowth(["view", "primary"])).toBe(1);
		expect(wheelGrowth(["view", "primary", "inner"])).toBe(1);
		expect(wheelGrowth(["view", "primary"], { collapsed: true })).toBe(1);
	});

	it("grows the corner for four rings instead of squeezing them", () => {
		const grow = wheelGrowth(["view", "primary", "inner", "inner"]);
		expect(grow).toBeGreaterThan(1);
		// Hub 34 + four bands with their gaps (26, 32, 30, 30; the View band is 26 so its 12px labels fit) + room for the index mark, over the 164 px base.
		expect(grow).toBeCloseTo((34 + 4 * 3 + 26 + 32 + 30 + 30 + 10) / 164, 6);
	});
});

describe("labelOpacity", () => {
	const edge = Math.PI * 1.5;
	const start = Math.PI;
	const half = 0.06;

	it("draws a label in full while all of it is inside the quarter", () => {
		expect(labelOpacity((5 * Math.PI) / 4, half)).toBe(1);
		expect(labelOpacity(edge - half, half)).toBe(1);
		expect(labelOpacity(start + half, half)).toBe(1);
	});

	it("fades a label running past the screen edge, so no half-word shows, and drops it once most of it is over", () => {
		// Centred on the edge, half the word would be cut: it is gone. Just over, it is fading; fully inside, it is full.
		expect(labelOpacity(edge, half)).toBe(0);
		const justOver = labelOpacity(edge - half * 0.9, half);
		expect(justOver).toBeGreaterThan(0.5);
		expect(justOver).toBeLessThan(1);
		expect(labelOpacity(edge - half, half)).toBe(1);
		expect(labelOpacity(edge + half, half)).toBe(0);
		expect(labelOpacity(start - half, half)).toBe(0);
	});
});
