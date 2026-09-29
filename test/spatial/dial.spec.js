import { describe, expect, it } from "vitest";
import { createDial, detentPosition, gearTurn, wheelRings } from "../../public/js/spatial/dial.js";

// Runs the physics until the dial rests (or `seconds` pass), collecting events.
const run = (dial, seconds = 3, dt = 1 / 60) => {
	const events = [];
	for (let t = 0; t < seconds && (dial.moving || t === 0); t += dt) events.push(...dial.update(dt));
	return events;
};

describe("createDial", () => {
	it("follows a drag: turning the ring toward the next stop moves one stop per pitch", () => {
		const dial = createDial({ count: 4, index: 2, pitch: 0.4 });
		dial.grab(1, 0);
		const events = dial.move(1 - 0.4, 50);
		expect(dial.position).toBeCloseTo(3, 6);
		expect(events).toEqual([{ type: "tick", index: 3, end: true }]);
	});

	it("ticks once per stop crossed, then commits the stop it rests on", () => {
		const dial = createDial({ count: 5, index: 0, pitch: 0.3 });
		dial.grab(0, 0);
		const ticks = [];
		for (let i = 1; i <= 10; i++) ticks.push(...dial.move(-0.075 * i, i * 10));
		expect(ticks.map(e => e.index)).toEqual([1, 2, 3]);
		dial.release(400);
		const events = run(dial);
		expect(events.filter(e => e.type === "change")).toEqual([{ type: "change", index: 3 }]);
		expect(dial.index).toBe(3);
		expect(dial.moving).toBe(false);
	});

	it("coasts after a flick and still lands on a stop", () => {
		const dial = createDial({ count: 7, index: 0, pitch: 0.3 });
		dial.grab(0, 0);
		dial.move(-0.3, 40);
		dial.move(-0.6, 80);
		dial.release(80);
		const events = run(dial);
		expect(dial.index).toBeGreaterThan(2);
		expect(Number.isInteger(dial.position)).toBe(true);
		expect(events.filter(e => e.type === "change")).toHaveLength(1);
	});

	it("rubber-bands past the ends and springs back to the last stop", () => {
		const dial = createDial({ count: 3, index: 2, pitch: 0.4 });
		dial.grab(0, 0);
		dial.move(-2, 100);
		expect(dial.position).toBeGreaterThan(2);
		expect(dial.position).toBeLessThan(2.45);
		dial.release(1000);
		run(dial);
		expect(dial.position).toBe(2);
		expect(dial.index).toBe(2);
	});

	it("steps one stop at a time and clamps at the ends", () => {
		const dial = createDial({ count: 4, index: 1 });
		dial.step(1);
		expect(run(dial).filter(e => e.type === "change")).toEqual([{ type: "change", index: 2 }]);
		dial.step(1);
		dial.step(1);
		run(dial);
		expect(dial.index).toBe(3);
	});

	it("follows the view silently: no change event for a stop the view already moved to", () => {
		const dial = createDial({ count: 4, index: 0 });
		dial.set(3, { silent: true });
		const events = run(dial);
		expect(dial.index).toBe(3);
		expect(events.filter(e => e.type === "change")).toEqual([]);
		expect(events.filter(e => e.type === "tick").map(e => e.index)).toEqual([1, 2, 3]);
	});
});

describe("detentPosition", () => {
	it("sticks near a stop and snaps through the half-way point", () => {
		expect(detentPosition(2)).toBe(2);
		expect(detentPosition(2.5)).toBeCloseTo(2.5, 9);
		expect(Math.abs(detentPosition(2.1) - 2)).toBeLessThan(0.01);
	});
});

describe("wheelRings", () => {
	it("puts the View rim outermost, then the primary ring, then what the stop needs", () => {
		expect(wheelRings({ view: "space", scale: "space" })).toEqual(["view", "scale", "time"]);
		expect(wheelRings({ view: "space", scale: "cluster" })).toEqual(["view", "scale", "depth"]);
		expect(wheelRings({ view: "space", scale: "horizon" })).toEqual(["view", "scale", "filters"]);
		expect(wheelRings({ view: "space", scale: "atomic" })).toEqual(["view", "scale"]);
		expect(wheelRings({ view: "board" })).toEqual(["view", "layout", "filters", "time"]);
		expect(wheelRings({ view: "list" })).toEqual(["view", "time", "filters"]);
	});

	it("folds to the rim and the primary ring when idle", () => {
		expect(wheelRings({ view: "board", collapsed: true })).toEqual(["view", "layout"]);
	});
});

describe("gearTurn", () => {
	it("turns neighbouring rings opposite ways, faster the further in", () => {
		const first = gearTurn(1, 0.4, 1);
		const second = gearTurn(1, 0.4, 2);
		expect(Math.sign(first)).toBe(-Math.sign(second));
		expect(Math.abs(second)).toBeGreaterThan(Math.abs(first));
	});
});
