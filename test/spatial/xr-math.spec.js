import { describe, expect, it } from "vitest";
import { GALLERY_ARC_M, OVERVIEW_DISTANCE_M, OVERVIEW_RADIUS_M, dollyRotationForYaw, galleryPlacement, isTeleport, overviewPlacement, placement, snapTurn } from "../../public/js/spatial/xr-math.js";

// The head's world position for a dolly placement, using three.js's rotation.y convention.
const headWorld = (dolly, head) => {
	const c = Math.cos(dolly.rotationY);
	const s = Math.sin(dolly.rotationY);
	return {
		x: dolly.position.x + (head.x * c + head.z * s) * dolly.scale,
		y: dolly.position.y + head.y * dolly.scale,
		z: dolly.position.z + (-head.x * s + head.z * c) * dolly.scale
	};
};
// Where the dolly's forward (-Z) points in the world.
const forward = dolly => ({ x: -Math.sin(dolly.rotationY), z: -Math.cos(dolly.rotationY) });
const close = (a, b, digits = 6) => {
	expect(a.x).toBeCloseTo(b.x, digits);
	expect(a.y).toBeCloseTo(b.y, digits);
	expect(a.z).toBeCloseTo(b.z, digits);
};

describe("placement", () => {
	it("puts the head on the point whatever the head's offset in the room", () => {
		const head = { x: 0.4, y: 1.7, z: -0.3 };
		const dolly = placement({ point: { x: 10, y: 20, z: 30 }, yaw: 0.7, scale: 12, head });
		close(headWorld(dolly, head), { x: 10, y: 20, z: 30 });
		// The floor is the dolly: 1.7 m below the head at 12 units per metre.
		expect(dolly.position.y).toBeCloseTo(20 - 1.7 * 12, 6);
	});

	it("faces the yaw's direction (0 = -Z, positive turns right)", () => {
		expect(forward({ rotationY: dollyRotationForYaw(0) }).z).toBeCloseTo(-1, 6);
		const right = forward({ rotationY: dollyRotationForYaw(Math.PI / 2) });
		expect(right.x).toBeCloseTo(1, 6);
		expect(right.z).toBeCloseTo(0, 6);
	});
});

describe("overview and gallery placements", () => {
	it("frames the graph in front of the user at the overview scale", () => {
		const head = { x: 0, y: 1.6, z: 0 };
		const dolly = overviewPlacement({ center: { x: 5, y: 6, z: 7 }, radius: 220, head });
		expect(dolly.scale).toBeCloseTo(220 / OVERVIEW_RADIUS_M, 6);
		const at = headWorld(dolly, head);
		// The centre is straight ahead, OVERVIEW_DISTANCE_M away, at eye height.
		expect(at.x).toBeCloseTo(5, 6);
		expect(at.y).toBeCloseTo(6, 6);
		expect((at.z - 7) / dolly.scale).toBeCloseTo(OVERVIEW_DISTANCE_M, 6);
		expect(forward(dolly).z).toBeCloseTo(-1, 6);
	});

	it("stands at a gallery's centre with the arc GALLERY_ARC_M away", () => {
		const head = { x: 0.1, y: 1.5, z: 0.2 };
		const dolly = galleryPlacement({ origin: { x: 1, y: 2, z: 3 }, yaw: -0.4, radius: 24, head });
		close(headWorld(dolly, head), { x: 1, y: 2, z: 3 });
		expect(24 / dolly.scale).toBeCloseTo(GALLERY_ARC_M, 6);
		expect(dolly.rotationY).toBeCloseTo(0.4, 6);
	});
});

describe("snapTurn and teleports", () => {
	it("turns about the head without moving it", () => {
		const head = { x: 0.5, y: 1.6, z: -0.2 };
		const dolly = placement({ point: { x: 3, y: 4, z: 5 }, yaw: 0.2, scale: 10, head });
		const turned = snapTurn(dolly, head, Math.PI / 6);
		close(headWorld(turned, head), headWorld(dolly, head));
		expect(turned.rotationY).toBeCloseTo(dolly.rotationY - Math.PI / 6, 6);
	});

	it("treats moves over half a metre as teleports", () => {
		expect(isTeleport({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 10)).toBe(false);
		expect(isTeleport({ x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, 10)).toBe(true);
	});
});
