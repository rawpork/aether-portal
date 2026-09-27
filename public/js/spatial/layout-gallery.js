// 180-degree spatial gallery (SPATIAL_ARCHITECTURE.md, section 6): a focused group's cards on a half cylinder around
// the viewer, at eye level, every card facing the viewer. Pure math with plain { x, y, z } objects: the same slots
// work on screens and in WebXR, because they are defined around the viewer pose, not the camera.

const HALF_PI = Math.PI / 2;

// Slots in the viewer's local frame (forward = -Z, right = +X, up = +Y). Returns { radius, perRow, rows, pageSize,
// pages, slots: [{ index, page, row, column, angle, local }] }. Columns sweep from -90 degrees (left) to +90 degrees
// (right); rows are centred on eye level; cards past rows × perRow go to further pages.
export function galleryLayout(count, {
  cardWidth,
  cardHeight,
  gapX = cardWidth * 0.15,
  gapY = cardHeight * 0.18,
  maxPerRow = 9,
  maxRows = 3,
  minRadius = 0,
  maxRadius = Infinity
}) {
  const perRow = Math.max(1, Math.min(count, maxPerRow));
  const rows = Math.max(1, Math.min(Math.ceil(count / perRow), maxRows));
  const pageSize = perRow * rows;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  // The arc per slot (pi R / perRow) must hold a card plus its gap.
  const radius = Math.min(maxRadius, Math.max(minRadius, (perRow * (cardWidth + gapX)) / Math.PI));
  const slots = [];
  for (let index = 0; index < count; index++) {
    const page = Math.floor(index / pageSize);
    const within = index % pageSize;
    const row = Math.floor(within / perRow);
    const column = within % perRow;
    // A partly filled last row is centred on the forward direction.
    const inRow = Math.min(perRow, (page === pages - 1 ? count - page * pageSize : pageSize) - row * perRow);
    const span = inRow / perRow;
    const angle = -HALF_PI * span + ((column + 0.5) * Math.PI * span) / inRow;
    const y = ((rows - 1) / 2 - row) * (cardHeight + gapY);
    slots.push({ index, page, row, column, angle, local: { x: radius * Math.sin(angle), y, z: -radius * Math.cos(angle) } });
  }
  return { radius, perRow, rows, pageSize, pages, slots };
}

// World position and facing of a slot for a viewer at `origin` looking along yaw (0 = -Z, positive turns right, in
// radians). pageYaw turns the whole ring for paging; the viewer never rotates (WebXR comfort rule). rotationY turns a
// card's +Z face toward the viewer.
export function slotToWorld(slot, origin, yaw, pageYaw = 0) {
  const turn = yaw + pageYaw;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const { x, y, z } = slot.local;
  // world = x · right − z · forward, with forward = (sin, 0, −cos) and right = (cos, 0, sin) of the turn.
  const world = { x: origin.x + x * c - z * s, y: origin.y + y, z: origin.z + x * s + z * c };
  return { position: world, rotationY: Math.atan2(origin.x - world.x, origin.z - world.z) };
}

// Viewer yaw (0 = looking along -Z) for a camera looking from `from` toward `to`, ignoring height.
export function yawToward(from, to) {
  return Math.atan2(to.x - from.x, -(to.z - from.z));
}
