// The headset dashboard (PROJECT_STATE.md, spatial dashboard): the panel from xr-panel.js on a mesh, riding above the
// left controller or hand and turned to face the user, or pinned in front of the user at waist height, where it
// follows lazily as the user turns. It lives in the viewer dolly, so it is sized and placed in real metres whatever
// the world scale, and it draws over everything (depth test off), so cards never hide it.

import { PANEL_HEIGHT, PANEL_METRES_WIDE, PANEL_WIDTH, drawPanel, hitTest, layoutPanel } from './xr-panel.js';

// Above the wrist, and how far out and down the pinned panel sits.
const WRIST_LIFT_M = 0.14;
const PINNED_DISTANCE_M = 0.55;
const PINNED_DROP_M = 0.3;
// The pinned panel re-centres in front of the user once they have turned this far away from it, gliding there.
const FOLLOW_ANGLE = 0.6;
const FOLLOW_RATE = 4;

export function createDashboard({ THREE, dolly, camera }) {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL_WIDTH;
  canvas.height = PANEL_HEIGHT;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const width = PANEL_METRES_WIDE;
  const height = (PANEL_METRES_WIDE * PANEL_HEIGHT) / PANEL_WIDTH;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })
  );
  mesh.name = 'aether-dashboard';
  mesh.renderOrder = 9000;
  mesh.frustumCulled = false;
  mesh.visible = false;
  dolly.add(mesh);

  const temp = { matrix: new THREE.Matrix4(), up: new THREE.Vector3(0, 1, 0), head: new THREE.Vector3(), euler: new THREE.Euler(0, 0, 0, 'YXZ') };
  let state = {};
  let stateKey = '';
  let layout = layoutPanel(state);
  let hoverId = null;
  let dirty = true;
  let shown = true;
  let pinned = false;
  let pinnedYaw = null;
  let following = false;
  let lastTime = 0;

  const redraw = () => {
    const full = { ...state, pinned };
    layout = layoutPanel(full);
    drawPanel(ctx, layout, full, hoverId);
    texture.needsUpdate = true;
    dirty = false;
  };
  // Head yaw inside the dolly (0 looks along -Z).
  const headYaw = () => {
    temp.euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return temp.euler.y;
  };
  const face = position => {
    temp.head.copy(camera.position);
    temp.matrix.lookAt(temp.head, position, temp.up);
    mesh.quaternion.setFromRotationMatrix(temp.matrix);
  };

  return {
    mesh,
    setState(next) {
      const key = JSON.stringify(next);
      if (key === stateKey) return;
      stateKey = key;
      state = { ...next };
      dirty = true;
    },
    setHover(id) {
      if (id === hoverId) return;
      hoverId = id;
      dirty = true;
    },
    hoverId: () => hoverId,
    isShown: () => mesh.visible,
    toggle() {
      shown = !shown;
    },
    show(on) {
      shown = Boolean(on);
    },
    isPinned: () => pinned,
    setPinned(on) {
      pinned = Boolean(on);
      pinnedYaw = pinned ? headYaw() : null;
      dirty = true;
    },
    // The button under a ray (a THREE.Raycaster already set), or null. id is null between buttons.
    pick(raycaster) {
      if (!mesh.visible) return null;
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (!hit || !hit.uv) return null;
      return { distance: hit.distance, id: hitTest(layout, hit.uv.x, hit.uv.y) };
    },
    // Every XR frame: wristGrip is the left grip (or null when that hand is not tracked).
    frame(wristGrip, time = performance.now()) {
      const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0;
      lastTime = time;
      mesh.visible = shown && (pinned || Boolean(wristGrip));
      if (!mesh.visible) return;
      if (pinned) {
        const yaw = headYaw();
        let delta = yaw - pinnedYaw;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        if (Math.abs(delta) > FOLLOW_ANGLE || following) {
          following = Math.abs(delta) > 0.02;
          pinnedYaw += delta * Math.min(1, FOLLOW_RATE * dt);
        }
        mesh.position.set(
          camera.position.x - Math.sin(pinnedYaw) * PINNED_DISTANCE_M,
          camera.position.y - PINNED_DROP_M,
          camera.position.z - Math.cos(pinnedYaw) * PINNED_DISTANCE_M
        );
      } else {
        mesh.position.set(wristGrip.position.x, wristGrip.position.y + WRIST_LIFT_M, wristGrip.position.z);
      }
      face(mesh.position);
      if (dirty) redraw();
    },
    dispose() {
      dolly.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      texture.dispose();
    }
  };
}
