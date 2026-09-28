// WebXR placement maths (SPATIAL_ARCHITECTURE.md 5.2 and 5.4). Pure functions on plain { x, y, z } objects, so they
// run in unit tests as-is. In a session the headset owns the camera, which sits inside the viewer dolly, so every move
// is made on the dolly: its position, its yaw (never pitch or roll) and its scale (graph units per metre, which is
// how big the world looks).

// The whole graph in front of the user: its bounding radius spans this many metres, its centre this far ahead.
export const OVERVIEW_RADIUS_M = 1.1;
export const OVERVIEW_DISTANCE_M = 1.9;
// Standing in a gallery: the arc of cards sits this far away.
export const GALLERY_ARC_M = 1.6;
// Snap turns (comfort: no smooth rotation).
export const SNAP_TURN = Math.PI / 6;
// Larger moves than this (in metres at the new scale) are teleports behind a short fade, never glides.
export const TELEPORT_M = 0.5;

// Dolly rotation about +Y for a viewer yaw (yaw 0 looks along -Z, positive turns right, as in layout-gallery.js).
// three.js turns -Z toward (-sin r, 0, -cos r) for rotation.y = r, so r = -yaw.
export const dollyRotationForYaw = yaw => -yaw;

// Where the dolly goes so the head ends up at `point`, facing `yaw`, at `scale` units per metre. head is the camera's
// position inside the dolly (metres, from the headset). The head's horizontal offset is cancelled so it lands on the
// point, and its height is kept, so the real floor stays under the user's feet: the dolly's y is the floor's height.
export function placement({ point, yaw, scale, head = { x: 0, y: 1.6, z: 0 } }) {
  const r = dollyRotationForYaw(yaw);
  const c = Math.cos(r);
  const s = Math.sin(r);
  // The head's horizontal offset in the world: rotation about Y applied to (x, z), then scaled.
  const hx = (head.x * c + head.z * s) * scale;
  const hz = (-head.x * s + head.z * c) * scale;
  return {
    position: { x: point.x - hx, y: point.y - head.y * scale, z: point.z - hz },
    rotationY: r,
    scale
  };
}

// Standing back from the whole graph: centre and radius of what is shown, in graph units. The viewer looks along -Z at
// the centre from OVERVIEW_DISTANCE_M away, with the graph's radius at OVERVIEW_RADIUS_M.
export function overviewPlacement({ center, radius, head }) {
  const scale = Math.max(1e-3, radius) / OVERVIEW_RADIUS_M;
  const point = { x: center.x, y: center.y, z: center.z + OVERVIEW_DISTANCE_M * scale };
  return placement({ point, yaw: 0, scale, head });
}

// Standing at a gallery's centre, facing its middle, with the arc GALLERY_ARC_M away.
export function galleryPlacement({ origin, yaw, radius, head }) {
  return placement({ point: origin, yaw, scale: Math.max(1e-3, radius) / GALLERY_ARC_M, head });
}

// A snap turn keeps the head where it is: the dolly turns by `angle` about the head's vertical axis.
// dolly: { position, rotationY, scale }; head as in placement. Positive angle turns the view right.
export function snapTurn(dolly, head, angle) {
  const r = dolly.rotationY;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const worldHead = {
    x: dolly.position.x + (head.x * c + head.z * s) * dolly.scale,
    y: dolly.position.y + head.y * dolly.scale,
    z: dolly.position.z + (-head.x * s + head.z * c) * dolly.scale
  };
  const yaw = -r + angle;
  const next = placement({ point: worldHead, yaw, scale: dolly.scale, head });
  return next;
}

// Whether moving the head from `from` to `to` (graph units) at `scale` units per metre is a teleport.
export const isTeleport = (from, to, scale) =>
  Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / Math.max(1e-6, scale) > TELEPORT_M;
