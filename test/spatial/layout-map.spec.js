import { describe, expect, it } from "vitest";
import { mapLayout, wirePoints } from "../../public/js/spatial/layout-map.js";

const size = { cardWidth: 12, cardHeight: 7.5 };

describe("mapLayout", () => {
	it("flows a chain left to right on one row", () => {
		const { slots, wires } = mapLayout(["a", "b", "c"], [{ source: "a", target: "b" }, { source: "b", target: "c", type: "ai" }], size);
		expect(slots.get("a").x).toBeLessThan(slots.get("b").x);
		expect(slots.get("b").x).toBeLessThan(slots.get("c").x);
		expect(slots.get("a").y).toBeCloseTo(slots.get("c").y, 6);
		expect(wires).toEqual([{ source: "a", target: "b", type: null }, { source: "b", target: "c", type: "ai" }]);
	});

	it("fans a branch out into one column", () => {
		const { slots } = mapLayout(["a", "b", "c"], [{ source: "a", target: "b" }, { source: "a", target: "c" }], size);
		expect(slots.get("b").x).toBe(slots.get("c").x);
		expect(slots.get("b").y).not.toBe(slots.get("c").y);
		// The source sits level with the middle of its fan.
		expect(slots.get("a").y).toBeCloseTo((slots.get("b").y + slots.get("c").y) / 2, 6);
	});

	it("handles cycles, duplicate and dangling links, and puts unlinked cards below", () => {
		const { slots, wires, width, height } = mapLayout(
			["a", "b", "c", "lone1", "lone2"],
			[
				{ source: "a", target: "b" },
				{ source: "b", target: "c" },
				{ source: "c", target: "a" },
				{ source: "b", target: "a" },
				{ source: "a", target: "missing" },
				{ source: "a", target: "a" }
			],
			size
		);
		expect(wires).toHaveLength(3);
		["a", "b", "c", "lone1", "lone2"].forEach(id => {
			expect(Number.isFinite(slots.get(id).x)).toBe(true);
			expect(Number.isFinite(slots.get(id).y)).toBe(true);
		});
		const linkedLowest = Math.min(...["a", "b", "c"].map(id => slots.get(id).y));
		expect(slots.get("lone1").y).toBeLessThan(linkedLowest);
		// Centred on the origin.
		const xs = [...slots.values()].map(slot => slot.x);
		expect(Math.min(...xs) - size.cardWidth / 2 + Math.max(...xs) + size.cardWidth / 2).toBeCloseTo(0, 6);
		expect(width).toBeGreaterThan(0);
		expect(height).toBeGreaterThan(0);
	});

	it("keeps crossing wires down by ordering columns after their neighbours", () => {
		// a1 -> b2 and a2 -> b1 would cross if b kept alphabetical order.
		const { slots } = mapLayout(["r", "a1", "a2", "b1", "b2"], [
			{ source: "r", target: "a1" },
			{ source: "r", target: "a2" },
			{ source: "a1", target: "b2" },
			{ source: "a2", target: "b1" }
		], size);
		const above = (p, q) => slots.get(p).y > slots.get(q).y;
		expect(above("a1", "a2")).toBe(above("b2", "b1"));
	});
});

describe("wirePoints", () => {
	it("runs from the source's right edge to the target's left edge", () => {
		const points = wirePoints({ x: 0, y: 0 }, { x: 40, y: 10 }, { cardWidth: 12, segments: 8 });
		expect(points).toHaveLength(9);
		expect(points[0]).toEqual({ x: 6, y: 0, z: 0 });
		expect(points[8]).toEqual({ x: 34, y: 10, z: 0 });
		// Leaves and arrives horizontally.
		expect(points[1].y).toBeCloseTo(0, 0);
	});
});
