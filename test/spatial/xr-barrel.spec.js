import { describe, expect, it } from "vitest";
import { GAP_M, HUB_M, MARK_ANGLE, STEP_M, WIDTH_M, barrelLayout, dialAngle, labelAngle, ringPitch, tapOffset } from "../../public/js/spatial/xr-barrel.js";
import { createDial } from "../../public/js/spatial/dial.js";

// Innermost first, as the barrel orders them.
const advanced = [
	{ id: "filters", role: "inner", width: WIDTH_M.inner, full: WIDTH_M.inner },
	{ id: "depth", role: "inner", width: WIDTH_M.inner, full: WIDTH_M.inner },
	{ id: "time", role: "primary", width: WIDTH_M.primary, full: WIDTH_M.primary },
	{ id: "view", role: "view", width: WIDTH_M.view, full: WIDTH_M.view },
];

describe("barrelLayout", () => {
	it("stacks the rings outward from the hub, the View rim outermost", () => {
		const { rings, outer } = barrelLayout(advanced);
		expect(rings[0].inner).toBeCloseTo(HUB_M + GAP_M, 9);
		rings.slice(1).forEach((ring, i) => expect(ring.inner).toBeCloseTo(rings[i].outer + GAP_M, 9));
		expect(rings[rings.length - 1].id).toBe("view");
		expect(outer).toBeCloseTo(rings[rings.length - 1].outer, 9);
	});

	it("telescopes: each ring stands a step in front of the one around it, and the hub in front of them all", () => {
		const { rings, hubFront } = barrelLayout(advanced);
		expect(rings.map(ring => ring.front)).toEqual([3, 2, 1, 0].map(n => n * STEP_M));
		expect(hubFront).toBeGreaterThan(rings[0].front);
	});

	it("slides a retracting ring back into the ring around it, and drops it once it is gone", () => {
		const half = advanced.map((layer, i) => (i < 2 ? { ...layer, width: layer.full / 2 } : layer));
		const halfway = barrelLayout(half).rings;
		expect(halfway[1].front).toBeCloseTo(2 * STEP_M - STEP_M / 2, 9);
		const gone = advanced.map((layer, i) => (i < 2 ? { ...layer, width: 0 } : layer));
		const simple = barrelLayout(gone);
		expect(simple.rings.map(ring => ring.id)).toEqual(["time", "view"]);
		expect(simple.rings[0].inner).toBeCloseTo(HUB_M + GAP_M, 9);
		expect(simple.outer).toBeLessThan(barrelLayout(advanced).outer);
	});
});

describe("ring angles", () => {
	it("puts the current stop at the mark and later stops clockwise of it", () => {
		expect(labelAngle(2, 2, 0.4)).toBeCloseTo(MARK_ANGLE, 9);
		expect(labelAngle(3, 2, 0.4)).toBeCloseTo(MARK_ANGLE - 0.4, 9);
	});

	it("turns a held ring with the ray: the stop under the ray stays under it", () => {
		const pitch = 0.4;
		const dial = createDial({ count: 5, index: 1, pitch });
		// The ray takes hold at the label of stop 2, then moves round to the mark.
		const start = labelAngle(2, dial.position, pitch);
		dial.grab(dialAngle(Math.cos(start), Math.sin(start)), 0);
		dial.move(dialAngle(Math.cos(MARK_ANGLE), Math.sin(MARK_ANGLE)), 50);
		expect(dial.position).toBeCloseTo(2, 6);
	});

	it("turns a clicked ring to the stop under the ray", () => {
		const pitch = 0.35;
		const at = labelAngle(4, 1, pitch);
		expect(1 + tapOffset(Math.cos(at) * 0.05, Math.sin(at) * 0.05, pitch)).toBeCloseTo(4, 6);
	});

	it("spaces stops wider on the smaller inner rings", () => {
		expect(ringPitch(8, "inner", 0.03)).toBeGreaterThan(ringPitch(8, "inner", 0.06));
	});
});
