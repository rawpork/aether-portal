// Camera rig (SPATIAL_ARCHITECTURE.md, section 2): critically damped springs that move a viewer pose between framing
// goals. The rig never touches a camera. It outputs a pose ({ position, target }) and a viewer adapter applies it: to
// the camera on screens, or to the dolly the camera sits in once a WebXR headset owns the camera (section 5). The math
// uses plain { x, y, z } objects and no three.js, so it runs in unit tests as-is.

// ---------- Math ----------

// Critically damped spring step (the SmoothDamp form). Unlike plain exponential smoothing it keeps velocity continuous
// when the goal changes mid-flight. smoothTime is roughly the time to cover 63% of the way.
export function smoothDamp(current, goal, velocity, smoothTime, dt) {
  const omega = 2 / Math.max(smoothTime, 1e-4);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - goal;
  const temp = (velocity + omega * change) * dt;
  return { value: goal + (change + temp) * decay, velocity: (velocity - omega * temp) * decay };
}

// The angle equal to `angle` (mod 2π) closest to `reference`, so orbits take the short way round.
export function wrapNear(angle, reference) {
  const turn = Math.PI * 2;
  return angle + turn * Math.round((reference - angle) / turn);
}

// three.js Spherical convention: phi from +Y (0 = straight above), theta around Y from +Z.
export function toSpherical({ x, y, z }) {
  const radius = Math.hypot(x, y, z);
  if (!radius) return { radius: 0, theta: 0, phi: Math.PI / 2 };
  return { radius, theta: Math.atan2(x, z), phi: Math.acos(Math.min(1, Math.max(-1, y / radius))) };
}

export function fromSpherical(radius, theta, phi) {
  const s = Math.sin(phi);
  return { x: radius * s * Math.sin(theta), y: radius * Math.cos(phi), z: radius * s * Math.cos(theta) };
}

// Right and up vectors of a camera looking at its target from the (theta, phi) side, with world +Y as up.
export function cameraBasis(theta, phi) {
  const forward = fromSpherical(-1, theta, phi);
  const right = { x: Math.cos(theta), y: 0, z: -Math.sin(theta) };
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x
  };
  return { right, up, forward };
}

const horizontalFov = (vFov, aspect) => 2 * Math.atan(Math.tan(vFov / 2) * aspect);

// Distance at which a bounding sphere fills the view with a margin (vFov in radians).
export function fitSphereDistance(radius, vFov, aspect, margin = 1.15) {
  return (radius * margin) / Math.sin(Math.min(vFov, horizontalFov(vFov, aspect)) / 2);
}

// Distance at which a flat halfWidth × halfHeight rectangle facing the camera fits the view.
export function fitRectDistance(halfWidth, halfHeight, vFov, aspect, margin = 1.1) {
  return margin * Math.max(halfHeight / Math.tan(vFov / 2), halfWidth / Math.tan(horizontalFov(vFov, aspect) / 2));
}

// Shifts the look-at target so `point` lands in the middle of the part of the screen a panel does not cover.
// cover: { side: 'right' | 'bottom', fraction } is the share of the viewport width (right) or height (bottom) covered.
export function uncoveredTarget(point, { theta, phi, distance, vFov, aspect }, cover) {
  if (!cover || !(cover.fraction > 0)) return { ...point };
  const { right, up } = cameraBasis(theta, phi);
  const visibleHeight = 2 * distance * Math.tan(vFov / 2);
  const visibleWidth = 2 * distance * Math.tan(horizontalFov(vFov, aspect) / 2);
  const fraction = Math.min(cover.fraction, 0.9);
  const [axis, amount] = cover.side === 'bottom'
    ? [up, -(fraction / 2) * visibleHeight]
    : [right, (fraction / 2) * visibleWidth];
  return { x: point.x + axis.x * amount, y: point.y + axis.y * amount, z: point.z + axis.z * amount };
}

// ---------- Rig ----------

const DEFAULT_TIMES = { target: 0.35, orbit: 0.3, distance: 0.4 };
const REDUCED_TIME = 0.05;
const MIN_RADIUS = 1e-3;

// Holds the current pose as springs (target xyz, theta, phi, log distance) and eases it toward a goal. States follow
// the section 2.1 machine ('macro', 'group', 'node'); the rig records them but the page decides transitions.
export class CameraRig {
  constructor({ reducedMotion = false, times = DEFAULT_TIMES } = {}) {
    this.times = reducedMotion
      ? { target: REDUCED_TIME, orbit: REDUCED_TIME, distance: REDUCED_TIME }
      : { ...DEFAULT_TIMES, ...times };
    this.current = null;
    this.goal = null;
    this.velocity = { tx: 0, ty: 0, tz: 0, theta: 0, phi: 0, logRadius: 0 };
    this.active = false;
    this.state = 'macro';
    this.detail = null;
  }

  // Adopts an actual pose (after the user orbited, or on start) with no motion.
  syncFromPose(position, target) {
    const s = toSpherical({ x: position.x - target.x, y: position.y - target.y, z: position.z - target.z });
    this.current = { tx: target.x, ty: target.y, tz: target.z, theta: s.theta, phi: s.phi, logRadius: Math.log(Math.max(s.radius, MIN_RADIUS)) };
    if (!this.active) this.velocity = { tx: 0, ty: 0, tz: 0, theta: 0, phi: 0, logRadius: 0 };
  }

  // Sets a new goal. Missing theta/phi keep the current viewing direction. With { instant: true } it jumps there.
  goTo({ target, distance, theta, phi, state, detail = null, instant = false }, fromPose) {
    if (!this.current || !this.active) this.syncFromPose(fromPose.position, fromPose.target);
    const goal = {
      tx: target.x,
      ty: target.y,
      tz: target.z,
      theta: wrapNear(theta ?? this.current.theta, this.current.theta),
      phi: Math.min(Math.PI - 0.01, Math.max(0.01, phi ?? this.current.phi)),
      logRadius: Math.log(Math.max(distance, MIN_RADIUS))
    };
    this.goal = goal;
    if (state) {
      this.state = state;
      this.detail = detail;
    }
    if (instant) {
      this.current = { ...goal };
      this.velocity = { tx: 0, ty: 0, tz: 0, theta: 0, phi: 0, logRadius: 0 };
      this.active = false;
      return this.pose();
    }
    this.active = true;
    return null;
  }

  // Stops where it is, keeping the pose; used when the user grabs the camera mid-flight.
  cancel() {
    this.active = false;
    this.goal = null;
    this.velocity = { tx: 0, ty: 0, tz: 0, theta: 0, phi: 0, logRadius: 0 };
  }

  pose() {
    const c = this.current;
    const offset = fromSpherical(Math.exp(c.logRadius), c.theta, c.phi);
    return {
      position: { x: c.tx + offset.x, y: c.ty + offset.y, z: c.tz + offset.z },
      target: { x: c.tx, y: c.ty, z: c.tz },
      theta: c.theta,
      phi: c.phi,
      distance: Math.exp(c.logRadius)
    };
  }

  // Advances the springs by dt seconds and returns the new pose, or null when idle. Arrival is when every channel is
  // within a small share of the goal distance and nearly still.
  update(dt) {
    if (!this.active || !this.goal) return null;
    const step = Math.min(Math.max(dt, 0), 0.05);
    const times = { tx: this.times.target, ty: this.times.target, tz: this.times.target, theta: this.times.orbit, phi: this.times.orbit, logRadius: this.times.distance };
    for (const key of Object.keys(times)) {
      const next = smoothDamp(this.current[key], this.goal[key], this.velocity[key], times[key], step);
      this.current[key] = next.value;
      this.velocity[key] = next.velocity;
    }
    const scale = Math.exp(this.goal.logRadius);
    const positional = Math.hypot(this.current.tx - this.goal.tx, this.current.ty - this.goal.ty, this.current.tz - this.goal.tz) / scale;
    const angular = Math.abs(this.current.theta - this.goal.theta) + Math.abs(this.current.phi - this.goal.phi) + Math.abs(this.current.logRadius - this.goal.logRadius);
    const speed = Math.hypot(this.velocity.tx, this.velocity.ty, this.velocity.tz) / scale + Math.abs(this.velocity.theta) + Math.abs(this.velocity.phi) + Math.abs(this.velocity.logRadius);
    if (positional < 0.002 && angular < 0.002 && speed < 0.01) {
      this.current = { ...this.goal };
      this.cancel();
    }
    return this.pose();
  }
}

// ---------- Viewer adapter (WebXR-ready) ----------

// Puts the camera inside a dolly group and applies rig poses. On screens the dolly stays at the origin with no
// rotation, so the camera's local transform is its world transform and the graph's orbit controls work unchanged; the
// pose goes onto the camera and the controls' target. In an XR session (Phase 6) the headset owns the camera's local
// transform, so poses must move the dolly instead; applyPose refuses to run then rather than fight the headset.
// The dolly is attached once three.js has loaded (attachDolly); poses apply the same way before and after.
export function createViewer({ camera, controls }) {
  let dolly = null;
  let presenting = false;
  return {
    getDolly: () => dolly,
    attachDolly(THREE, scene) {
      if (dolly) return dolly;
      dolly = new THREE.Group();
      dolly.name = 'aether-viewer-dolly';
      scene.add(dolly);
      dolly.add(camera);
      return dolly;
    },
    isPresenting: () => presenting,
    setPresenting: value => { presenting = Boolean(value); },
    currentPose: () => ({ position: camera.position.clone(), target: controls.target.clone() }),
    applyPose(pose) {
      if (presenting) return false;
      camera.position.set(pose.position.x, pose.position.y, pose.position.z);
      camera.up.set(0, 1, 0);
      camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
      controls.target.set(pose.target.x, pose.target.y, pose.target.z);
      return true;
    }
  };
}
