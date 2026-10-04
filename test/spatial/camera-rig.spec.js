import { describe, expect, it } from "vitest";
import {
	CameraRig,
	cameraBasis,
	clusterCore,
	spanDistance,
	createViewer,
	fitRectDistance,
	fitSphereDistance,
	fromSpherical,
	smoothDamp,
	toSpherical,
	uncoveredTarget,
	wrapNear,
} from "../../public/js/spatial/camera-rig.js";

const close = (a, b, digits = 6) => expect(a).toBeCloseTo(b, digits);
const run = (rig, seconds, dt = 1 / 60) => {
	let pose = null;
	for (let t = 0; t < seconds && rig.active; t += dt) pose = rig.update(dt) || pose;
	return pose;
};

describe("smoothDamp", () => {
	it("converges without overshoot", () => {
		let state = { value: 0, velocity: 0 };
		let max = 0;
		for (let i = 0; i < 180; i++) {
			state = smoothDamp(state.value, 10, state.velocity, 0.3, 1 / 60);
			max = Math.max(max, state.value);
		}
		close(state.value, 10, 3);
		expect(max).toBeLessThanOrEqual(10 + 1e-9);
	});

	it("gives the same result at 30 and 120 fps", () => {
		const settle = fps => {
			let state = { value: 0, velocity: 0 };
			for (let i = 0; i < fps * 0.5; i++) state = smoothDamp(state.value, 1, state.velocity, 0.3, 1 / fps);
			return state.value;
		};
		expect(Math.abs(settle(30) - settle(120))).toBeLessThan(0.02);
	});
});

describe("spherical helpers", () => {
	it("round-trips positions", () => {
		const point = { x: 3, y: -4, z: 12 };
		const s = toSpherical(point);
		const back = fromSpherical(s.radius, s.theta, s.phi);
		close(back.x, 3);
		close(back.y, -4);
		close(back.z, 12);
	});

	it("wraps angles the short way round", () => {
		close(wrapNear(-3, 3), -3 + Math.PI * 2);
		close(wrapNear(1, 0.5), 1);
	});

	it("builds a right-handed camera basis", () => {
		const { right, up, forward } = cameraBasis(0, Math.PI / 2);
		expect([right.x, right.y, right.z].map(v => Math.round(v) + 0)).toEqual([1, 0, 0]);
		expect([up.x, up.y, up.z].map(v => Math.round(v) + 0)).toEqual([0, 1, 0]);
		expect([forward.x, forward.y, forward.z].map(v => Math.round(v) + 0)).toEqual([0, 0, -1]);
	});
});

describe("framing", () => {
	const vFov = (50 * Math.PI) / 180;

	it("fits a sphere to the narrower field of view", () => {
		const wide = fitSphereDistance(100, vFov, 2);
		const tall = fitSphereDistance(100, vFov, 0.5);
		close(wide, 115 / Math.sin(vFov / 2), 3);
		expect(tall).toBeGreaterThan(wide);
	});

	it("fits a flat rectangle", () => {
		close(fitRectDistance(0, 100, vFov, 1, 1), 100 / Math.tan(vFov / 2), 3);
	});

	it("shifts the target so a point clears a covering panel", () => {
		const view = { theta: 0, phi: Math.PI / 2, distance: 100, vFov, aspect: 1 };
		const visible = 2 * 100 * Math.tan(vFov / 2);
		const right = uncoveredTarget({ x: 0, y: 0, z: 0 }, view, { side: "right", fraction: 0.4 });
		close(right.x, 0.2 * visible, 3);
		const bottom = uncoveredTarget({ x: 0, y: 0, z: 0 }, view, { side: "bottom", fraction: 0.5 });
		close(bottom.y, -0.25 * visible, 3);
		expect(uncoveredTarget({ x: 1, y: 2, z: 3 }, view, null)).toEqual({ x: 1, y: 2, z: 3 });
		const sides = uncoveredTarget({ x: 0, y: 0, z: 0 }, view, { side: "sides", left: 0.25, right: 0.35, fraction: 0.6 });
		close(sides.x, 0.05 * visible, 3);
		const even = uncoveredTarget({ x: 0, y: 0, z: 0 }, view, { side: "sides", left: 0.3, right: 0.3, fraction: 0.6 });
		close(even.x, 0, 6);
		const band = uncoveredTarget({ x: 0, y: 0, z: 0 }, view, { side: "band", top: 0.4, bottom: 0.2, fraction: 0.6 });
		close(band.y, 0.1 * visible, 3);
	});
});

describe("CameraRig", () => {
	const start = { position: { x: 0, y: 0, z: 500 }, target: { x: 0, y: 0, z: 0 } };

	it("glides to a goal, keeps the viewing direction, then goes idle", () => {
		const rig = new CameraRig();
		expect(rig.goTo({ target: { x: 50, y: 0, z: 0 }, distance: 100, state: "node", detail: "n1" }, start)).toBeNull();
		expect(rig.active).toBe(true);
		const pose = run(rig, 5);
		expect(rig.active).toBe(false);
		close(pose.target.x, 50, 3);
		close(pose.position.z, 100, 2);
		expect(rig.state).toBe("node");
		expect(rig.detail).toBe("n1");
		expect(rig.update(1 / 60)).toBeNull();
	});

	it("retargets mid-flight without a velocity jump", () => {
		const rig = new CameraRig();
		rig.goTo({ target: { x: 100, y: 0, z: 0 }, distance: 500 }, start);
		for (let i = 0; i < 10; i++) rig.update(1 / 60);
		const before = rig.velocity.tx;
		rig.goTo({ target: { x: -100, y: 0, z: 0 }, distance: 500 }, start);
		expect(rig.velocity.tx).toBe(before);
		const x1 = rig.current.tx;
		rig.update(1 / 60);
		expect(rig.current.tx).toBeGreaterThan(x1 - 5);
	});

	it("orbits the short way to a requested angle", () => {
		const rig = new CameraRig();
		rig.goTo({ target: { x: 0, y: 0, z: 0 }, distance: 500, theta: -3 }, { position: fromSpherical(500, 3, Math.PI / 2), target: { x: 0, y: 0, z: 0 } });
		expect(Math.abs(rig.goal.theta - rig.current.theta)).toBeLessThan(Math.PI);
	});

	it("jumps with instant and stops on cancel", () => {
		const rig = new CameraRig();
		const pose = rig.goTo({ target: { x: 1, y: 2, z: 3 }, distance: 10, instant: true }, start);
		expect(rig.active).toBe(false);
		close(pose.target.y, 2);
		rig.goTo({ target: { x: 0, y: 0, z: 0 }, distance: 50 }, start);
		rig.cancel();
		expect(rig.active).toBe(false);
		expect(rig.update(1 / 60)).toBeNull();
	});

	it("settles almost at once with reduced motion", () => {
		const rig = new CameraRig({ reducedMotion: true });
		rig.goTo({ target: { x: 80, y: 0, z: 0 }, distance: 120 }, start);
		for (let i = 0; i < 12; i++) rig.update(1 / 60);
		close(rig.pose().target.x, 80, 0);
	});
});

describe("createViewer", () => {
	const vector = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); }, clone() { return { x: this.x, y: this.y, z: this.z }; } });
	const makeCamera = () => ({ position: vector(), up: vector(), lookedAt: null, lookAt(x, y, z) { this.lookedAt = [x, y, z]; } });

	it("applies poses to the camera and controls on screens", () => {
		const camera = makeCamera();
		const controls = { target: vector() };
		const viewer = createViewer({ camera, controls });
		expect(viewer.applyPose({ position: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 } })).toBe(true);
		expect(camera.position.clone()).toEqual({ x: 1, y: 2, z: 3 });
		expect(camera.lookedAt).toEqual([4, 5, 6]);
		expect(controls.target.clone()).toEqual({ x: 4, y: 5, z: 6 });
	});

	it("puts the camera in a dolly and leaves a presenting headset alone", () => {
		const camera = makeCamera();
		const added = [];
		const THREE = { Group: class { constructor() { this.children = []; } add(child) { this.children.push(child); } } };
		const viewer = createViewer({ camera, controls: { target: vector() } });
		const dolly = viewer.attachDolly(THREE, { add: object => added.push(object) });
		expect(added).toEqual([dolly]);
		expect(dolly.children).toEqual([camera]);
		expect(viewer.attachDolly(THREE, { add() {} })).toBe(dolly);
		viewer.setPresenting(true);
		expect(viewer.applyPose({ position: { x: 9, y: 9, z: 9 }, target: { x: 0, y: 0, z: 0 } })).toBe(false);
		expect(camera.position.x).toBe(0);
	});
});

describe("clusterCore", () => {
	it("frames the points nearest the middle and leaves outliers out", () => {
		const points = [
			{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 },
			{ x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: -1 },
			{ x: 300, y: 0, z: 0 }, { x: -280, y: 10, z: 0 }, { x: 5, y: 260, z: 0 }
		];
		const all = clusterCore(points, 1);
		const core = clusterCore(points, 0.7);
		expect(core.count).toBe(7);
		expect(core.radius).toBeLessThan(5);
		expect(all.radius).toBeGreaterThan(200);
		expect(core.center.x).toBeCloseTo(1, 5);
		expect(core.center.y).toBeCloseTo(1, 5);
	});

	it("handles one point, unplaced points and none", () => {
		expect(clusterCore([{ x: 4, y: 5, z: 6 }])).toEqual({ center: { x: 4, y: 5, z: 6 }, radius: 0, count: 1 });
		expect(clusterCore([{ x: NaN, y: 0, z: 0 }])).toBeNull();
		expect(clusterCore([])).toBeNull();
	});
});

describe("spanDistance", () => {
	it("gives the distance at which a width fills a number of pixels, nearer for more pixels", () => {
		const vFov = (50 * Math.PI) / 180;
		const far = spanDistance(12, 120, vFov, 16 / 9, 1366);
		const near = spanDistance(12, 240, vFov, 16 / 9, 1366);
		expect(near).toBeCloseTo(far / 2, 6);
		// At that distance the width spans exactly the pixels asked for.
		const halfWidthAtDistance = Math.tan(Math.atan(Math.tan(vFov / 2) * (16 / 9))) * near;
		expect((12 / (2 * halfWidthAtDistance)) * 1366).toBeCloseTo(240, 6);
		expect(spanDistance(12, 240, vFov, 1, 0)).toBe(0);
	});
});
