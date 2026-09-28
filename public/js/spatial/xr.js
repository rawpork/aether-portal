// WebXR session (SPATIAL_ARCHITECTURE.md 5, Phase 6): enters mixed reality (immersive-ar, the headset's passthrough)
// or VR, moves the viewer dolly with the comfort rules (teleports behind a short fade, snap turns, a stable floor),
// and turns controller and hand rays into hover and select. It knows nothing about cards or galleries: the page gives
// it a pick function and gets select and back events, and places the viewer through place().

import { SNAP_TURN, placement, snapTurn } from './xr-math.js';

// Zoom (the left thumbstick, pushed forward or back): how fast the world grows or shrinks around the head, per second
// at full tilt, and the dead zone before it starts.
const ZOOM_RATE = 1.2;
const STICK_DEAD_ZONE = 0.2;

const FADE_MS = 150;
// Ray length in metres when it hits nothing, and the cursor's radius.
const RAY_M = 4;
const CURSOR_M = 0.012;
const RAY_COLOR = 0x00ffcc;
// Thumbstick: past PRESS it turns once; it must come back under RELEASE before the next turn.
const STICK_PRESS = 0.7;
const STICK_RELEASE = 0.3;
// xr-standard gamepad: the thumbstick press is button 3, A/X is button 4 and B/Y button 5.
const BACK_BUTTONS = [5];
const MENU_BUTTON = 4;
const RAY_MODE_BUTTON = 3;
// Where a controller's ray comes from: 'pointer' is the platform's own pointing pose (the Quest Browser's laser), the
// default; 'grip' is the grip pose's forward axis, which on the Quest runs along the handle (the Quest 2 test found it
// pointing at the sky), kept only as an alternative. Tracked hands always use their pointing pose.
export const RAY_MODES = ['pointer', 'grip'];

// Which immersive modes this browser can open. Mixed reality comes first when both are there.
export async function xrSupport() {
  const xr = typeof navigator !== 'undefined' ? navigator.xr : null;
  if (!xr || !xr.isSessionSupported) return { ar: false, vr: false };
  const check = mode => xr.isSessionSupported(mode).catch(() => false);
  const [ar, vr] = await Promise.all([check('immersive-ar'), check('immersive-vr')]);
  return { ar: Boolean(ar), vr: Boolean(vr) };
}

// renderer: the graph's WebGLRenderer. camera: the graph's camera, already inside `dolly` (createViewer). frame is
// called on every XR frame with (time, frame) and must render. pick(ray) returns { distance } (graph units) or null.
export function createXR({ THREE, renderer, scene, camera, dolly, frame, pick, onHover, onSelect, onBack, onEnd, rayMode = 'pointer', onRayMode, onMenu, onScale }) {
  let session = null;
  let mode = null;
  let currentRayMode = RAY_MODES.includes(rayMode) ? rayMode : 'pointer';
  const temp = { matrix: new THREE.Matrix4(), origin: new THREE.Vector3(), direction: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

  // ---- Rays: one per controller or tracked hand ----
  const hands = [0, 1].map(index => {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: RAY_COLOR, transparent: true, opacity: 0.75 }));
    line.scale.z = RAY_M;
    line.raycast = () => {};
    line.visible = false;
    const cursor = new THREE.Mesh(new THREE.SphereGeometry(CURSOR_M, 12, 8), new THREE.MeshBasicMaterial({ color: RAY_COLOR }));
    cursor.raycast = () => {};
    cursor.visible = false;
    const hand = { index, controller, grip, line, cursor, source: null, stickLatched: false, buttons: [] };
    controller.addEventListener('connected', event => {
      hand.source = event.data || null;
      line.visible = true;
      attachRay(hand);
    });
    controller.addEventListener('disconnected', () => {
      hand.source = null;
      line.visible = false;
      cursor.visible = false;
      if (onHover) onHover(hand.index, null);
    });
    controller.addEventListener('select', () => {
      if (onSelect) onSelect(rayOf(hand), hand.index);
    });
    controller.addEventListener('squeeze', () => {
      if (onBack) onBack(hand.index);
    });
    return hand;
  });

  // The pose a hand's ray comes from: the grip or the pointing pose for controllers, the pointing pose for tracked
  // hands (their grip is the palm). The line and cursor live on it, so what is drawn is what is picked.
  const rayPose = hand => (currentRayMode === 'grip' && hand.source && !hand.source.hand ? hand.grip : hand.controller);
  const attachRay = hand => {
    const pose = rayPose(hand);
    if (hand.line.parent !== pose) pose.add(hand.line);
    if (hand.cursor.parent !== pose) pose.add(hand.cursor);
  };
  const setRayMode = next => {
    if (!RAY_MODES.includes(next) || next === currentRayMode) return;
    currentRayMode = next;
    hands.forEach(attachRay);
    if (onRayMode) onRayMode(currentRayMode);
  };

  // World-space ray from a controller: origin and forward (-Z) direction.
  const rayOf = hand => {
    temp.matrix.copy(rayPose(hand).matrixWorld);
    temp.origin.setFromMatrixPosition(temp.matrix);
    temp.quaternion.setFromRotationMatrix(temp.matrix);
    temp.direction.set(0, 0, -1).applyQuaternion(temp.quaternion).normalize();
    return { origin: temp.origin.clone(), direction: temp.direction.clone() };
  };

  // ---- Fade: a dark shell around the head for teleports (comfort: never a visible jump) ----
  const fadeShell = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false })
  );
  fadeShell.renderOrder = 10000;
  fadeShell.visible = false;
  fadeShell.raycast = () => {};
  camera.add(fadeShell);
  let fade = null;
  const setFade = opacity => {
    fadeShell.material.opacity = opacity;
    fadeShell.visible = opacity > 0.001;
  };
  const stepFade = time => {
    if (!fade) return;
    if (fade.start === null) fade.start = time;
    const t = Math.min(1, (time - fade.start) / FADE_MS);
    if (fade.phase === 'out') {
      setFade(t);
      if (t >= 1) {
        fade.apply();
        fade.phase = 'in';
        fade.start = time;
      }
    } else {
      setFade(1 - t);
      if (t >= 1) {
        setFade(0);
        fade = null;
      }
    }
  };

  const applyDolly = next => {
    dolly.position.set(next.position.x, next.position.y, next.position.z);
    dolly.rotation.set(0, next.rotationY, 0);
    dolly.scale.setScalar(next.scale);
    dolly.updateMatrixWorld(true);
  };
  const headInDolly = () => ({ x: camera.position.x, y: camera.position.y || 1.6, z: camera.position.z });
  // The camera only holds the head pose once the first XR frame has rendered (until then it still has its screen
  // position, hundreds of units off), so placements wait for that; the view stays dark meanwhile.
  let posed = false;
  let pendingPlace = null;

  // Moves the viewer: next is a placement (xr-math.js), or a function of the current head that returns one (so the
  // head is read after the fade, when it is final). instant skips the fade (the first placement on entering).
  const place = (next, { instant = false } = {}) => {
    const resolve = () => applyDolly(typeof next === 'function' ? next(headInDolly()) : next);
    if (!session) {
      resolve();
      return;
    }
    if (!posed) {
      pendingPlace = resolve;
      return;
    }
    if (instant) {
      resolve();
      // Still dark from the start of the session: fade in now that the viewer is in place.
      if (fadeShell.visible && !fade) fade = { phase: 'in', start: null, apply: null };
      return;
    }
    fade = { phase: 'out', start: null, apply: resolve };
  };

  // Grows or shrinks the world around the head (the head stays where it is): factor multiplies the graph units per
  // metre, so below 1 zooms in. Returns the new scale.
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 1e5;
  const zoomBy = factor => {
    const current = { position: { x: dolly.position.x, y: dolly.position.y, z: dolly.position.z }, rotationY: dolly.rotation.y, scale: dolly.scale.x };
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
    if (scale === current.scale) return scale;
    const head = headInDolly();
    const c = Math.cos(current.rotationY);
    const s = Math.sin(current.rotationY);
    const worldHead = {
      x: current.position.x + (head.x * c + head.z * s) * current.scale,
      y: current.position.y + head.y * current.scale,
      z: current.position.z + (-head.x * s + head.z * c) * current.scale
    };
    applyDolly(placement({ point: worldHead, yaw: -current.rotationY, scale, head }));
    if (onScale) onScale(scale);
    return scale;
  };

  // ---- Input polling: snap turns (right stick), zoom (left stick), menu and back buttons (select and squeeze arrive
  // as events) ----
  let lastPoll = 0;
  const pollInput = time => {
    const dt = lastPoll ? Math.min(0.1, (time - lastPoll) / 1000) : 0;
    lastPoll = time;
    hands.forEach(hand => {
      const gamepad = hand.source && hand.source.gamepad;
      if (!gamepad) return;
      const x = gamepad.axes.length >= 4 ? gamepad.axes[2] : gamepad.axes[0] || 0;
      const y = gamepad.axes.length >= 4 ? gamepad.axes[3] : gamepad.axes[1] || 0;
      const left = hand.source.handedness === 'left';
      if (left) {
        // Forward (negative y) zooms in: fewer graph units per metre, so everything looks bigger.
        if (Math.abs(y) > STICK_DEAD_ZONE && dt) zoomBy(Math.exp(y * ZOOM_RATE * dt));
        const menu = Boolean(gamepad.buttons[MENU_BUTTON] && gamepad.buttons[MENU_BUTTON].pressed);
        if (menu && !hand.buttons[MENU_BUTTON] && onMenu) onMenu(hand.index);
        hand.buttons[MENU_BUTTON] = menu;
      } else if (!hand.stickLatched && Math.abs(x) > STICK_PRESS) {
        hand.stickLatched = true;
        const current = { position: { ...dolly.position }, rotationY: dolly.rotation.y, scale: dolly.scale.x };
        applyDolly(snapTurn(current, headInDolly(), x > 0 ? SNAP_TURN : -SNAP_TURN));
      } else if (hand.stickLatched && Math.abs(x) < STICK_RELEASE) {
        hand.stickLatched = false;
      }
      BACK_BUTTONS.forEach(index => {
        const pressed = Boolean(gamepad.buttons[index] && gamepad.buttons[index].pressed);
        if (pressed && !hand.buttons[index] && onBack) onBack(hand.index);
        hand.buttons[index] = pressed;
      });
      // Pressing a thumbstick in switches where the rays come from, to compare on the headset.
      const stickPress = Boolean(gamepad.buttons[RAY_MODE_BUTTON] && gamepad.buttons[RAY_MODE_BUTTON].pressed);
      if (stickPress && !hand.buttons[RAY_MODE_BUTTON]) setRayMode(currentRayMode === 'grip' ? 'pointer' : 'grip');
      hand.buttons[RAY_MODE_BUTTON] = stickPress;
    });
  };

  // Rays end where they hit something (the cursor sits there), else run RAY_M metres.
  const updateRays = () => {
    hands.forEach(hand => {
      if (!hand.source) return;
      const hit = pick ? pick(rayOf(hand)) : null;
      const metres = hit ? hit.distance / Math.max(1e-6, dolly.scale.x) : RAY_M;
      hand.line.scale.z = Math.max(0.01, metres);
      hand.cursor.visible = Boolean(hit);
      hand.cursor.position.set(0, 0, -metres);
      if (onHover) onHover(hand.index, hit);
    });
  };

  // three.js builds the headset's culling frustum from both eyes without allowing for a scaled parent, so with the
  // dolly scaled (the world shrunk around the viewer) whole regions of cards are culled while in plain view. Culling
  // is switched off while presenting (checked every CULL_EVERY frames, which also catches cards built meanwhile) and
  // restored afterwards.
  const CULL_EVERY = 30;
  let frameCount = 0;
  let loggedFrameError = false;
  const unculled = new Set();
  const disableCulling = () => {
    if (!scene) return;
    scene.traverse(object => {
      if (object.frustumCulled) {
        object.frustumCulled = false;
        unculled.add(object);
      }
    });
  };
  const restoreCulling = () => {
    unculled.forEach(object => { object.frustumCulled = true; });
    unculled.clear();
  };

  // The session's frame time is not guaranteed to share the page clock, so timing uses performance.now().
  const loop = (frameTime, xrFrame) => {
    const time = performance.now();
    if (frameCount++ % CULL_EVERY === 0) disableCulling();
    if (posed && pendingPlace) {
      pendingPlace();
      pendingPlace = null;
      // Fade in from the dark start.
      fade = { phase: 'in', start: null, apply: null };
    }
    try {
      pollInput(time);
      stepFade(time);
      if (posed) updateRays();
      frame(time, xrFrame);
    } catch (err) {
      // Logged once: a frame that throws must not take the session down, and must not flood the console at 72-90 Hz.
      if (!loggedFrameError) console.error('XR frame failed:', err);
      loggedFrameError = true;
    }
    posed = true;
  };

  const cleanup = () => {
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    session = null;
    mode = null;
    fade = null;
    posed = false;
    pendingPlace = null;
    frameCount = 0;
    restoreCulling();
    setFade(0);
    hands.forEach(hand => {
      hand.source = null;
      hand.line.visible = false;
      hand.cursor.visible = false;
    });
    applyDolly({ position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 });
    if (onEnd) onEnd();
  };

  return {
    isActive: () => Boolean(session),
    mode: () => mode,
    rayMode: () => currentRayMode,
    setRayMode,
    zoomBy,
    scale: () => dolly.scale.x,
    // The grip of the controller or hand in that hand ('left' or 'right'), or null when it is not tracked.
    gripFor: handedness => {
      const hand = hands.find(item => item.source && item.source.handedness === handedness);
      return hand ? hand.grip : null;
    },
    // A short haptic buzz on a controller, where it has one.
    pulse: (index, intensity = 0.3, ms = 20) => {
      const hand = hands[index];
      const actuator = hand && hand.source && hand.source.gamepad && hand.source.gamepad.hapticActuators && hand.source.gamepad.hapticActuators[0];
      if (actuator && actuator.pulse) {
        try { actuator.pulse(intensity, ms); } catch (err) {}
      }
    },
    place,
    placement,
    // Starts a session: 'immersive-ar' (mixed reality) or 'immersive-vr'.
    async start(nextMode) {
      if (session) return;
      const next = await navigator.xr.requestSession(nextMode, { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking'] });
      session = next;
      mode = nextMode;
      next.addEventListener('end', cleanup, { once: true });
      hands.forEach(hand => {
        dolly.add(hand.controller);
        dolly.add(hand.grip);
      });
      posed = false;
      setFade(1);
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(next);
      renderer.setAnimationLoop(loop);
    },
    end() {
      if (session) session.end();
    }
  };
}
