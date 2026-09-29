import { describe, expect, it } from "vitest";
import { ARC_EDGE, ARC_FILL, ARC_MIN_FILL, ZOOM_STOPS, arcFraming, arcNeighbourEdge, createWheelStepper, stepStop, stopFor, wallPose } from "../../public/js/spatial/zoom-stops.js";
import { galleryLayout } from "../../public/js/spatial/layout-gallery.js";
import { fromSpherical } from "../../public/js/spatial/camera-rig.js";

const card = { cardWidth: 12, cardHeight: 7.5 };
// A 16:9 desktop canvas with 50-degree vertical field of view, nothing covered; and a portrait phone.
const desktop = { tanHalfHeight: Math.tan(Math.PI * 25 / 180), tanHalfWidth: Math.tan(Math.PI * 25 / 180) * 16 / 9 };
const phone = { tanHalfHeight: Math.tan(Math.PI * 25 / 180) * 0.55, tanHalfWidth: Math.tan(Math.PI * 25 / 180) * 0.46 };
const layoutRadius = count => galleryLayout(count, { ...card, minRadius: 18 }).radius;

describe("arcFraming", () => {
	it("frames the middle card large, with the next cards just showing at the edges", () => {
		for (const view of [desktop, phone]) {
			const perRow = 9;
			const { radius, distance } = arcFraming({ ...card, ...view, perRow, minRadius: layoutRadius(9) });
			const share = card.cardWidth / 2 / distance / view.tanHalfWidth;
			expect(share).toBeLessThanOrEqual(ARC_FILL + 1e-9);
			expect(share).toBeGreaterThanOrEqual(ARC_MIN_FILL - 1e-9);
			// The neighbours' inner edges sit at (or, on a wider wall, just past) ARC_EDGE of the half-width.
			const edge = arcNeighbourEdge(radius, distance, Math.PI / perRow, card.cardWidth / 2) / view.tanHalfWidth;
			expect(edge).toBeGreaterThanOrEqual(ARC_EDGE - 1e-6);
			expect(edge).toBeLessThan(1.05);
			expect(radius).toBeGreaterThanOrEqual(layoutRadius(9));
		}
	});

	it("puts the camera inside the arc, much nearer the wall than the old standpoint 1.35 R away", () => {
		const { radius, distance } = arcFraming({ ...card, ...desktop, perRow: 5, minRadius: layoutRadius(5) });
		expect(distance).toBeLessThan(radius);
		expect(distance).toBeLessThan(1.35 * layoutRadius(5) * 0.6);
	});

	it("steps back on a wider wall to keep the neighbours' edges in view, down to the smallest card size", () => {
		const framed = arcFraming({ ...card, ...desktop, perRow: 5, minRadius: 0 });
		const wider = arcFraming({ ...card, ...desktop, perRow: 5, minRadius: framed.radius * 1.03 });
		expect(wider.distance).toBeGreaterThan(framed.distance);
		const edge = arcNeighbourEdge(wider.radius, wider.distance, Math.PI / 5, 6) / desktop.tanHalfWidth;
		expect(edge).toBeCloseTo(ARC_EDGE, 6);
		const widest = arcFraming({ ...card, ...desktop, perRow: 3, minRadius: 400 });
		expect(card.cardWidth / 2 / widest.distance / desktop.tanHalfWidth).toBeCloseTo(ARC_MIN_FILL, 6);
	});

	it("frames a lone card on its own", () => {
		const { radius, distance } = arcFraming({ ...card, ...desktop, perRow: 1, minRadius: 18 });
		expect(radius).toBe(18);
		expect(card.cardWidth / 2 / distance / desktop.tanHalfWidth).toBeCloseTo(ARC_FILL, 6);
	});
});

describe("wallPose", () => {
	it("stands the camera on the radius, distance from the wall, a little above and looking down", () => {
		const origin = { x: 10, y: 5, z: -3 };
		const yaw = 0.7;
		const pose = wallPose({ origin, radius: 30, yaw, distance: 12, elevation: 0.1 });
		const wall = { x: origin.x + Math.sin(yaw) * 30, z: origin.z - Math.cos(yaw) * 30 };
		expect(pose.target.x).toBeCloseTo(wall.x, 6);
		expect(pose.target.z).toBeCloseTo(wall.z, 6);
		const offset = fromSpherical(pose.distance, pose.theta, pose.phi);
		const camera = { x: pose.target.x + offset.x, y: pose.target.y + offset.y, z: pose.target.z + offset.z };
		expect(camera.y).toBeGreaterThan(origin.y);
		// Horizontally the camera sits on the line from the origin to the wall point, between the two.
		const fromOrigin = Math.hypot(camera.x - origin.x, camera.z - origin.z);
		expect(fromOrigin).toBeCloseTo(30 - 12 * Math.cos(0.1), 6);
		expect(Math.atan2(camera.x - origin.x, -(camera.z - origin.z))).toBeCloseTo(yaw, 6);
	});

	it("shifts the look-at point so the wall point lands off-centre", () => {
		const base = wallPose({ origin: { x: 0, y: 0, z: 0 }, radius: 20, yaw: 0, distance: 10 });
		const shifted = wallPose({ origin: { x: 0, y: 0, z: 0 }, radius: 20, yaw: 0, distance: 10, shift: { x: 2, y: 1 } });
		expect(shifted.target.x).toBeCloseTo(base.target.x - 2, 6);
		expect(shifted.target.y).toBeCloseTo(base.target.y - 1, 6);
	});
});

describe("stops", () => {
	it("reads the stop from the view", () => {
		expect(stopFor({})).toBe("space");
		expect(stopFor({ cluster: true })).toBe("cluster");
		expect(stopFor({ gallery: true })).toBe("horizon");
		expect(stopFor({ gallery: true, focused: true })).toBe("atomic");
	});

	it("steps one stop at a time and stops at the ends", () => {
		expect(ZOOM_STOPS).toEqual(["space", "cluster", "horizon", "atomic"]);
		expect(stepStop("horizon", 1)).toBe("atomic");
		expect(stepStop("horizon", -3)).toBe("cluster");
		expect(stepStop("atomic", 1)).toBe("atomic");
		expect(stepStop("space", -1)).toBe("space");
	});
});

describe("createWheelStepper", () => {
	it("steps once per flick, after enough travel", () => {
		const wheel = createWheelStepper({ threshold: 150, cooldownMs: 450, idleMs: 250 });
		expect(wheel(100, 0)).toBe(0);
		expect(wheel(100, 16)).toBe(1);
		// The rest of the same flick is ignored.
		expect(wheel(300, 32)).toBe(0);
		expect(wheel(-200, 600)).toBe(-1);
	});

	it("takes one step for a long trackpad flick, however long its inertia runs", () => {
		const wheel = createWheelStepper({ threshold: 150, cooldownMs: 450, idleMs: 250 });
		let steps = 0;
		for (let t = 0; t < 2000; t += 40) steps += Math.abs(wheel(60, t));
		expect(steps).toBe(1);
		expect(wheel(200, 2400)).toBe(1);
	});

	it("forgets small scrolls after a pause", () => {
		const wheel = createWheelStepper({ threshold: 150, idleMs: 250 });
		expect(wheel(100, 0)).toBe(0);
		expect(wheel(100, 1000)).toBe(0);
	});
});
