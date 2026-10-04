// Mechanical dials (PROJECT_STATE.md, radial controls): the engine behind the concentric rings on phones (the thumb
// wheel), on desktop (the radial widget) and in the headset (the lens barrel). Pure math with plain objects, so it runs
// in unit tests as-is; each platform only draws the rings and feeds in input.
//
// A ring has `count` stops `pitch` radians apart. Its position is continuous, in stops: stop i sits `(i - position) *
// pitch` radians from the ring's index mark, so turning the ring by +delta radians moves the position by -delta / pitch.
// Dragging follows the finger or ray exactly; releasing coasts (a flick) and then springs into the nearest stop.
// Every stop that passes the index mark fires a 'tick' (the haptic click); coming to rest on a new stop fires 'change'.

// Coasting friction (per second), the speed under which a coasting ring springs into its stop (stops per second), how
// fast that spring closes (per second), and how far past the end stops a ring can be pulled (stops, rubber-banded).
const FRICTION = 5;
const SETTLE_SPEED = 1.5;
const SNAP_RATE = 14;
const OVERSHOOT = 0.45;
// Only the last VELOCITY_WINDOW_MS of a drag counts toward the flick speed.
const VELOCITY_WINDOW_MS = 90;
const REST = 0.002;

const clampIndex = (index, count) => Math.max(0, Math.min(count - 1, Math.round(index)));
const wrapAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// Detent feel for drawing: the ring sticks near each stop and snaps through the half-way point between two stops
// (continuous, and equal to the position at every stop and every half-way point).
export function detentPosition(position) {
  const nearest = Math.round(position);
  const offset = position - nearest;
  return nearest + 4 * offset * offset * offset;
}

export function createDial({ count, index = 0, pitch = 0.4 }) {
  let committed = clampIndex(index, count);
  let position = committed;
  let velocity = 0;
  let mode = 'rest';
  let target = committed;
  let lastTick = committed;
  let grabAngle = 0;
  let grabPosition = 0;
  let samples = [];

  // Past the ends the ring gives way less and less.
  const band = raw => {
    const max = count - 1;
    if (raw < 0) return -OVERSHOOT * (1 - Math.exp(raw / OVERSHOOT));
    if (raw > max) return max + OVERSHOOT * (1 - Math.exp(-(raw - max) / OVERSHOOT));
    return raw;
  };
  // A tick for every stop the position has crossed since the last one reported (each at most once per crossing).
  const ticks = events => {
    const nearest = clampIndex(position, count);
    if (nearest === lastTick) return events;
    const step = Math.sign(nearest - lastTick);
    for (let stop = lastTick + step; step > 0 ? stop <= nearest : stop >= nearest; stop += step) {
      events.push({ type: 'tick', index: stop, end: stop === 0 || stop === count - 1 });
    }
    lastTick = nearest;
    return events;
  };
  const settle = events => {
    position = target;
    velocity = 0;
    mode = 'rest';
    ticks(events);
    if (target !== committed) {
      committed = target;
      events.push({ type: 'change', index: committed });
    }
    return events;
  };

  return {
    get count() { return count; },
    get pitch() { return pitch; },
    // A ring drawn at a new radius keeps its stops, spaced to fit their labels there.
    setPitch(next) {
      if (next > 0) pitch = next;
    },
    get index() { return committed; },
    get position() { return position; },
    // Where to draw the ring (with the detent feel), in stops.
    get display() { return detentPosition(position); },
    // Dragging, coasting or springing.
    get moving() { return mode !== 'rest'; },
    get dragging() { return mode === 'drag'; },
    // The stop under the index mark right now (what a click would land on).
    get nearest() { return clampIndex(position, count); },

    // angle: the finger or ray's angle around the ring's centre (radians); time in ms.
    grab(angle, time) {
      mode = 'drag';
      velocity = 0;
      grabAngle = angle;
      grabPosition = position;
      samples = [{ time, position }];
    },
    move(angle, time) {
      if (mode !== 'drag') return [];
      const turned = wrapAngle(angle - grabAngle);
      position = band(grabPosition - turned / pitch);
      // A finger sweeping more than half a turn keeps going instead of flipping back.
      if (Math.abs(turned) > Math.PI / 2) {
        grabAngle = angle;
        grabPosition = position;
      }
      samples.push({ time, position });
      while (samples.length > 2 && time - samples[0].time > VELOCITY_WINDOW_MS) samples.shift();
      return ticks([]);
    },
    release(time) {
      if (mode !== 'drag') return [];
      const first = samples[0];
      const span = first ? (time - first.time) / 1000 : 0;
      velocity = span > 0.01 ? (position - first.position) / span : 0;
      mode = 'coast';
      return [];
    },
    // Turns to a stop: animated springs there (with ticks on the way), otherwise it jumps. silent leaves `index` as it
    // is reported by the caller (the view already moved there), so no 'change' fires.
    set(next, { animate = true, silent = false } = {}) {
      target = clampIndex(next, count);
      if (silent) committed = target;
      if (!animate) {
        lastTick = target;
        return settle([]);
      }
      mode = 'snap';
      velocity = 0;
      return [];
    },
    // One stop in a direction (a wheel flick or a stick push).
    step(delta) {
      return this.set((mode === 'snap' ? target : committed) + Math.sign(delta));
    },
    // Advances the physics by dt seconds. Returns the events that happened.
    update(dt) {
      const events = [];
      if (mode === 'coast') {
        position = band(position + velocity * dt);
        velocity *= Math.exp(-FRICTION * dt);
        if (position < 0 || position > count - 1) velocity *= Math.exp(-FRICTION * 4 * dt);
        ticks(events);
        if (Math.abs(velocity) < SETTLE_SPEED) {
          target = clampIndex(position, count);
          mode = 'snap';
        }
        return events;
      }
      if (mode === 'snap') {
        position += (target - position) * (1 - Math.exp(-SNAP_RATE * dt));
        ticks(events);
        if (Math.abs(target - position) < REST) settle(events);
        return events;
      }
      return events;
    }
  };
}

// ---- The wheel's rings, outer to inner ----
// The View rim is outermost; inside it the primary ring for that view (the Scale in 3D Space, the Layout on the Board,
// Time elsewhere); then the rings the current stop needs. Space opens Time, Cluster opens Depth, Horizon opens Filters
// and Atomic opens Card (the focused card's cluster, one stop per card). In 3D Space a Filter ring (All, then the
// graph's categories and top tags) sits just inside the Scale ring, so it shows only in Advanced. Idle, only the rim and the primary ring show. The Simple mode (for getting started)
// never shows more than those two; Advanced telescopes the inner rings out.
export const WHEEL_VIEWS = ['space', 'list', 'timeline', 'board', 'carousel'];
export const WHEEL_MODES = ['simple', 'advanced'];
const INNER_BY_SCALE = { space: ['time'], cluster: ['depth'], horizon: ['filters'], atomic: ['node'] };

export function wheelRings({ view = 'space', scale = 'horizon', collapsed = false, simple = false } = {}) {
  let rings;
  if (view === 'space') rings = ['view', 'scale', 'filter', ...(INNER_BY_SCALE[scale] || [])];
  else if (view === 'board') rings = ['view', 'layout', 'filters', 'time'];
  else rings = ['view', 'time', 'filters'];
  return collapsed || simple ? rings.slice(0, 2) : rings;
}

// The headset lens barrel's rings, outer to inner. A headset has no web page views, so its View rim holds the spatial
// ones: Space (the whole cloud), Gallery (a group's wall around the viewer) and Board (the flat wall, whose primary
// ring is its Layout). Scale stops wait for the headset's own placements, so Space and Gallery lead with Time.
export const BARREL_VIEWS = ['space', 'gallery', 'board'];
export function barrelRings({ view = 'space', simple = false } = {}) {
  let rings;
  if (view === 'board') rings = ['view', 'layout', 'filters', 'time'];
  else if (view === 'gallery') rings = ['view', 'time', 'filters'];
  else rings = ['view', 'time', 'depth', 'filters'];
  return simple ? rings.slice(0, 2) : rings;
}

// Scroll input for a ring under the mouse: a mouse wheel's notch (a large pixel step) turns one stop; a trackpad's
// smooth scroll adds up to one stop per `threshold` pixels, with anything left over dropped after `idleMs`. Returns a
// function of (deltaY in pixels, time in ms) giving how many stops to turn (positive = down the list).
export function createScrollTurner({ threshold = 60, notch = 50, idleMs = 200 } = {}) {
  let travel = 0;
  let last = -Infinity;
  return (deltaY, time) => {
    if (time - last > idleMs) travel = 0;
    last = time;
    if (Math.abs(deltaY) >= notch) {
      travel = 0;
      return Math.sign(deltaY);
    }
    travel += deltaY;
    const stops = Math.trunc(travel / threshold);
    travel -= stops * threshold;
    return stops;
  };
}

// Gearing: inner rings turn against the primary ring at a fixed ratio (their knurling only; their labels stay put, so
// what they read never changes on its own). Returns the knurling's turn, in radians, for an inner ring at `depth`
// (1 = next to the primary ring) when the primary ring is at `position` stops with `pitch`. Neighbouring rings turn
// opposite ways, like meshed gears.
export const GEAR_RATIO = 1.6;
export function gearTurn(position, pitch, depth = 1) {
  return -position * pitch * Math.pow(GEAR_RATIO, depth) * (depth % 2 ? 1 : -1);
}
