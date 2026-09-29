// Spatial zoom stops (PROJECT_STATE.md, zoom stops): the four discrete levels the zoom slider, the wheel and the
// headset stick move between, and the screen framing of stop 3 (the 180-degree arc). Pure math with plain objects,
// so it runs in unit tests as-is.
//
//   1 space    the whole cloud (Macro)
//   2 cluster  one cluster framed as an island, its neighbours around it
//   3 zoom     that cluster opened as the 180-degree wall, one card large in the middle (the default on launch)
//   4 atomic   one card focused, with its details open

export const ZOOM_STOPS = ['space', 'cluster', 'zoom', 'atomic'];
export const ZOOM_STOP_LABELS = { space: 'Space', cluster: 'Cluster', zoom: 'Zoom', atomic: 'Atomic' };
export const DEFAULT_ZOOM_STOP = 'zoom';

// Stop 3 on screens. The camera stands inside the arc, looking straight at one card on the wall: that card fills
// ARC_FILL of the free width (at most ARC_HEIGHT_FILL of the free height), and the arc is wide enough that the next
// cards left and right only just show, their inner edges at ARC_EDGE of the way from the middle to the edge of the
// free area. The camera stands a little above the card and looks slightly down at it.
export const ARC_FILL = 0.62;
export const ARC_HEIGHT_FILL = 0.7;
export const ARC_EDGE = 0.88;
// A wall the layout makes wider than that puts its neighbours further out; the camera then steps back to show their
// edges, but never so far that the card drops under this share of the free width.
export const ARC_MIN_FILL = 0.5;
export const ARC_ELEVATION = 0.1;

// Share of the half-width at which a card's inner edge shows, seen from `distance` in front of the middle card of an
// arc of `radius` whose slots are `step` radians apart (tangents, straight ahead = 0).
export function arcNeighbourEdge(radius, distance, step, halfWidth) {
  const across = radius * Math.sin(step) - halfWidth * Math.cos(step);
  const ahead = radius * Math.cos(step) + halfWidth * Math.sin(step) - radius + distance;
  return ahead > 0 ? across / ahead : Infinity;
}

// Arc radius and viewing distance for stop 3. perRow is the number of slots in a row of the gallery (the slots are
// pi / perRow apart, galleryLayout), minRadius the radius the layout needs anyway. tanHalfWidth and tanHalfHeight are
// the tangents of half the free part of the view (the part the panels leave), horizontally and vertically.
// Returns { radius, distance }: distance is from the camera to the wall, along the middle card's radius.
export function arcFraming({
  cardWidth,
  cardHeight,
  perRow,
  minRadius,
  tanHalfWidth,
  tanHalfHeight,
  fill = ARC_FILL,
  heightFill = ARC_HEIGHT_FILL,
  edge = ARC_EDGE,
  minFill = ARC_MIN_FILL
}) {
  const halfWidth = cardWidth / 2;
  const halfHeight = cardHeight / 2;
  const framed = Math.max(halfWidth / (fill * tanHalfWidth), halfHeight / (heightFill * tanHalfHeight));
  if (!(perRow > 1)) return { radius: minRadius, distance: framed };
  const step = Math.PI / perRow;
  const want = edge * tanHalfWidth;
  const sin = Math.sin(step);
  const cos = Math.cos(step);
  // The radius that puts the neighbours' inner edges at `want` from `framed` away (arcNeighbourEdge solved for radius).
  const radius = (want * (halfWidth * sin + framed) + halfWidth * cos) / (sin + want * (1 - cos));
  if (radius >= minRadius) return { radius, distance: framed };
  // The layout's own wall is wider still, so its neighbours sit further out: step back to bring their edges in, but
  // never so far that the card drops under minFill.
  const back = (minRadius * (sin + want * (1 - cos)) - halfWidth * cos) / want - halfWidth * sin;
  const farthest = Math.max(framed, halfWidth / (minFill * tanHalfWidth));
  return { radius: minRadius, distance: Math.min(farthest, Math.max(framed, back)) };
}

// Camera goal for looking at the wall: at `distance` in front of the point on an arc of `radius` around `origin` at
// yaw (0 looks along -Z) and height y, raised by `elevation` radians. shift moves the look-at point across the view
// ({ x, y } in units at the wall), so the wall point lands in the middle of the free part of the screen instead of the
// middle of the canvas. theta and phi follow the camera rig's convention (three.js Spherical: camera = target +
// fromSpherical(distance, theta, phi)).
export function wallPose({ origin, radius, yaw, y = origin.y, distance, elevation = ARC_ELEVATION, shift = { x: 0, y: 0 } }) {
  const forward = { x: Math.sin(yaw), z: -Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
  return {
    target: {
      x: origin.x + forward.x * radius - right.x * shift.x,
      y: y - shift.y,
      z: origin.z + forward.z * radius - right.z * shift.x
    },
    distance,
    theta: -yaw,
    phi: Math.PI / 2 - elevation
  };
}

// The stop the view is at: a focused card on the wall is atomic, an open wall is zoom, a framed cluster is cluster,
// anything else space.
export function stopFor({ gallery = false, focused = false, cluster = false } = {}) {
  if (gallery) return focused ? 'atomic' : 'zoom';
  if (focused) return 'atomic';
  return cluster ? 'cluster' : 'space';
}

// The stop `delta` steps from `stop` (positive zooms in), clamped to the ends.
export function stepStop(stop, delta) {
  const index = ZOOM_STOPS.indexOf(stop);
  const from = index < 0 ? ZOOM_STOPS.indexOf(DEFAULT_ZOOM_STOP) : index;
  return ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, from + Math.sign(delta)))];
}

// Wheel zoom between stops: accumulates wheel travel (pixels, positive = out as the browser reports it) and steps once
// it passes `threshold`. The rest of that flick is ignored: everything until the wheel has been still for `idleMs`
// (a trackpad's inertia keeps sending events for a second or more), and at least `cooldownMs`. Returns a function of
// (deltaY, time) that gives -1 (in), 1 (out) or 0.
export function createWheelStepper({ threshold = 150, cooldownMs = 450, idleMs = 250 } = {}) {
  let travel = 0;
  let last = -Infinity;
  let locked = false;
  let blockedUntil = -Infinity;
  return (deltaY, time) => {
    if (time - last > idleMs) {
      travel = 0;
      locked = false;
    }
    last = time;
    if (locked || time < blockedUntil) return 0;
    travel += deltaY;
    if (Math.abs(travel) < threshold) return 0;
    const direction = Math.sign(travel);
    travel = 0;
    locked = true;
    blockedUntil = time + cooldownMs;
    return direction;
  };
}
