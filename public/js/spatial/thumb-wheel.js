// Thumb wheel (PROJECT_STATE.md, radial controls): the concentric rings, a quarter wheel pivoting on the bottom-right
// corner of the screen. On phones it is thumb-sized; on desktop the same wheel is drawn larger (everything scales with
// the mount, which is BASE_PX square on a phone) and also turns under the mouse wheel. Solid, matte bands in the navy and teal system: no glass, blur or glow. Each ring
// turns like a dial under the thumb (dial.js does the physics), clicks into every stop with a short vibration (or, where
// the browser cannot vibrate, as on iPhone, a visual click and an optional soft tick sound), and reads its value at the
// index mark on the diagonal. The + Add button is the hub. Idle, the wheel folds to the View rim and the primary ring;
// a tap opens it again. In the Simple mode it never shows more than those two rings.
//
// The page gives it the rings' stops and a state() function, and hears back through onChange(ringId, value).

import { createDial, createScrollTurner, gearTurn, wheelRings } from './dial.js';

const SVG = 'http://www.w3.org/2000/svg';
// Where the value is read: the diagonal, up and left of the corner (screen angles, y down, 0 to 2 pi: the quarter the
// wheel shows runs from pi, straight left, to 1.5 pi, straight up).
const MARK = (5 * Math.PI) / 4;
// The phone's mount size; sizes below are at this size and scale with the mount.
const BASE_PX = 164;
// Band widths (px) by role, the gap between bands, and the hub. Inner rings are nearly as wide as the primary ring, so
// with three or four rings out the bands stay as roomy as the two-ring wheel instead of pinching together.
const WIDTH = { view: 26, primary: 32, inner: 30 };
const GAP = 3;
const HUB = 34;
const HUB_COLLAPSED = 30;
// The wheel folds after this long without a touch.
const IDLE_MS = 2500;
// Radius and band tweens (per second) and how far a press may move and still be a tap.
const FOLD_RATE = 14;
const TAP_PX = 8;
// Label sizes by role (px, never under the 12px type floor) and the space a label needs along the arc.
const FONT = { view: 12, primary: 12, inner: 12 };
const LABEL_PAD = 12;
// Room kept outside the rim for the index mark, at the base size.
const RIM_ROOM = 10;
// Matte fills, darkest outermost.
const FILL = { view: '#0a111c', primary: '#122033', inner: ['#0f1b2b', '#0c1624'] };
const EDGE = 'rgba(255,255,255,0.07)';
const TEXT = '#8a93a6';
const ACCENT = '#00ffcc';
const HUB_TEXT = '#041016';
// Exported so the contrast of the wheel's text on its bands is checked by a test, not by eye.
export const WHEEL_COLORS = { TEXT, ACCENT, HUB_TEXT, FILL, EDGE };

const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};
// Each label runs along its own arc (a textPath), so the text bends with the ring; the arcs need document-unique ids.
let arcIds = 0;
// A clockwise arc of radius r around (cx, cy) from angle a0 to a1 (screen, y down): the direction the labels read in,
// with the tops of the letters facing out from the centre.
const arcPath = (cx, cy, r, a0, a1) => {
  const p = a => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
  return 'M' + p(a0) + ' A' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + p(a1);
};
// An annulus sector around (cx, cy) from angle a0 to a1 (radians, screen, y down).
const bandPath = (cx, cy, inner, outer, a0, a1) => {
  const p = (r, a) => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return 'M' + p(outer, a0) + ' A' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + p(outer, a1)
    + ' L' + p(inner, a1) + ' A' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + p(inner, a0) + ' Z';
};

// One short, soft tick from the Web Audio API (only used where vibration is not available).
let audio = null;
const tickSound = strong => {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    const length = Math.floor(audio.sampleRate * 0.004);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    const filter = audio.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2400;
    const gain = audio.createGain();
    gain.gain.value = strong ? 0.22 : 0.12;
    source.connect(filter).connect(gain).connect(audio.destination);
    source.start();
  } catch (err) {}
};

// A label whose letters would run past the quarter's edge (the screen edge, where the ring continues off-screen) fades out
// instead of showing half a word: fully drawn while it fits, gone once the overhang is most of its half-width.
// `a` is the label's centre angle and `half` its half-width in radians.
export function labelOpacity(a, half) {
  const room = Math.min(a - half - Math.PI, Math.PI * 1.5 - (a + half));
  if (room >= 0) return 1;
  return Math.max(0, Math.min(1, 1 + room / Math.max(half * 0.8, 1e-6)));
}

// How much larger than its base size the mount must be to hold rings of these roles (outer to inner, as wheelRings
// lists them) at full width, at the base scale: 1 while they fit, more for a wheel with many rings out. The rings keep
// their widths and the mount grows (--wheel-grow), rather than the rings being squeezed into the same corner.
export function wheelGrowth(roles, { collapsed = false } = {}) {
  const radius = roles.reduce((sum, role) => sum + GAP + WIDTH[role], collapsed ? HUB_COLLAPSED : HUB) + RIM_ROOM;
  return Math.max(1, radius / BASE_PX);
}

// rings: { id: { name, stops: [{ value, label }] } }. state(): { view, scale, layout, time, depth, filters } (values).
// onChange(ringId, value) when a ring comes to rest on a new stop; onAdd() for the hub. sound(): whether to tick
// audibly where the device cannot vibrate. simple(): whether the wheel is in the Simple mode.
export function createThumbWheel({ mount, rings, state, onChange, onAdd, sound = () => true, simple = () => false }) {
  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const size = { w: 0, h: 0 };
  // The mount's size over the phone's: every width, gap and font is multiplied by it.
  let k = 1;
  const svg = el('svg', { class: 'thumb-wheel-svg', role: 'group', 'aria-label': 'Controls wheel' });
  const bandsLayer = el('g');
  const hub = el('g', { class: 'thumb-wheel-hub', role: 'button', tabindex: '0', 'aria-label': 'Add node' });
  const hubShape = el('path', { fill: ACCENT });
  const hubLabel = el('text', { fill: HUB_TEXT, 'font-size': '24', 'font-weight': '600', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  hubLabel.textContent = '+';
  hub.append(hubShape, hubLabel);
  // One index mark for every ring, like a camera dial's: a small teal wedge just outside the rim, on the diagonal.
  const mark = el('path', { fill: ACCENT, class: 'thumb-wheel-mark' });
  // The labels' arcs (never drawn themselves).
  const defs = el('defs');
  svg.append(defs, bandsLayer, hub, mark);
  mount.append(svg);

  // Per ring: its dial and drawing, created when the ring first shows. Each layer's band width tweens, so rings fold in
  // and out; radii are summed from the hub outward every frame.
  const layers = new Map();
  let order = [];
  let collapsed = true;
  let hubRadius = HUB_COLLAPSED;
  let frame = 0;
  let lastTime = 0;
  let idleTimer = null;
  let press = null;
  // The mount's size over its base size (wheelGrowth), applied as --wheel-grow; k is measured against the grown base.
  let grow = 1;

  const roleOf = (id, list) => (id === 'view' ? 'view' : list.indexOf(id) === 1 ? 'primary' : 'inner');
  const indexOfValue = (id, value) => Math.max(0, rings[id].stops.findIndex(stop => stop.value === value));

  const makeLayer = id => {
    const values = state();
    const dial = createDial({ count: rings[id].stops.length, index: indexOfValue(id, values[id]) });
    const group = el('g', { class: 'thumb-wheel-ring', role: 'slider', tabindex: '0', 'aria-label': rings[id].name });
    const band = el('path', { stroke: EDGE, 'stroke-width': '1' });
    const ticks = el('path', { stroke: 'rgba(255,255,255,0.14)', 'stroke-width': '1', fill: 'none' });
    // Each label is a textPath centred on its own arc, which draw() moves around the ring.
    const labels = rings[id].stops.map(stop => {
      const arcId = 'thumb-wheel-arc-' + (++arcIds);
      const arc = el('path', { id: arcId, fill: 'none' });
      defs.append(arc);
      const text = el('text', { 'text-anchor': 'middle' });
      const run = el('textPath', { href: '#' + arcId, startOffset: '50%' });
      // Older Safari only follows the xlink form.
      run.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + arcId);
      run.textContent = stop.label;
      text.append(run);
      return { text, arc, run };
    });
    group.append(band, ticks, ...labels.map(label => label.text));
    group.addEventListener('keydown', event => {
      const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      layer.dial.step(delta);
      wake();
      kick();
    });
    const layer = { id, dial, group, band, ticks, labels, width: 0, target: 0, inner: 0, outer: 0, role: 'inner', quiet: false };
    layers.set(id, layer);
    bandsLayer.append(group);
    return layer;
  };

  // The rings to show now, and the band width each is heading for.
  const arrange = () => {
    const values = state();
    const list = wheelRings({ view: values.view, scale: values.scale, collapsed, simple: simple() });
    list.forEach(id => { if (!layers.has(id)) makeLayer(id); });
    // Inside-out order: the rings on the list innermost first, and rings folding away kept where they were.
    const next = list.slice().reverse();
    order.filter(id => !list.includes(id)).forEach(id => {
      const at = order.indexOf(id);
      next.splice(Math.min(at, next.length), 0, id);
    });
    order = next;
    layers.forEach(layer => {
      layer.role = roleOf(layer.id, list);
      layer.target = list.includes(layer.id) ? WIDTH[layer.role] * k : 0;
    });
    updateRoom();
    kick();
  };
  // Grows the mount for the rings that are out or still folding away; it shrinks back once they have folded.
  const updateRoom = () => {
    const roles = order.map(id => layers.get(id)).filter(layer => layer.target > 0 || layer.width > 0.5).map(layer => layer.role);
    const next = wheelGrowth(roles, { collapsed });
    if (Math.abs(next - grow) < 0.005) return;
    grow = next;
    if (mount.style && mount.style.setProperty) mount.style.setProperty('--wheel-grow', grow.toFixed(3));
  };

  const haptic = strong => {
    if (canVibrate) {
      try { navigator.vibrate(strong ? 18 : 9); } catch (err) {}
    } else if (sound()) {
      tickSound(strong);
    }
    svg.classList.remove('clicked');
    // Restart the click flash (a reflow between removing and adding the class).
    void svg.getBoundingClientRect();
    svg.classList.add('clicked');
  };
  // A ring turning to follow the view (sync) is quiet: no clicks for a move the user did not make.
  const handle = (layer, events) => {
    events.forEach(event => {
      if (event.type === 'tick' && !layer.quiet) haptic(event.end);
      if (event.type === 'change') onChange(layer.id, rings[layer.id].stops[event.index].value);
    });
  };

  const draw = () => {
    const cx = size.w;
    const cy = size.h;
    let radius = hubRadius;
    const primary = order.map(id => layers.get(id)).find(layer => layer.role === 'primary' && layer.target > 0);
    let depth = 0;
    order.forEach(id => {
      const layer = layers.get(id);
      layer.inner = radius + (layer.width > 0.5 ? GAP * k : 0);
      layer.outer = layer.inner + layer.width;
      radius = layer.outer;
      const visible = layer.width > 0.5;
      layer.group.style.display = visible ? '' : 'none';
      if (!visible) return;
      const role = layer.role;
      const mid = (layer.inner + layer.outer) / 2;
      const font = FONT[role] * k;
      // Stops spaced so the longest label fits along the arc at this radius.
      const longest = Math.max(...rings[id].stops.map(stop => stop.label.length));
      layer.dial.setPitch(Math.max(0.36, (longest * font * 0.6 + LABEL_PAD * k) / Math.max(mid, 1)));
      const pitch = layer.dial.pitch;
      const display = layer.dial.display;
      const fill = role === 'inner' ? FILL.inner[depth % 2] : FILL[role];
      if (role === 'inner') depth += 1;
      layer.band.setAttribute('fill', fill);
      layer.band.setAttribute('d', bandPath(cx, cy, layer.inner, layer.outer, Math.PI * 0.98, Math.PI * 1.52));
      // Knurling: fine ticks on the outer edge, turning with the ring (inner rings also geared to the primary ring).
      const gear = role === 'inner' && primary ? gearTurn(primary.dial.display, primary.dial.pitch, depth) : 0;
      let ticks = '';
      const tickStep = pitch / 3;
      const phase = -display * pitch + gear;
      const first = Math.ceil((Math.PI - MARK - phase) / tickStep);
      for (let n = first; ; n++) {
        const a = MARK + phase + n * tickStep;
        if (a > Math.PI * 1.5) break;
        const r0 = layer.outer - 3 * k;
        ticks += 'M' + (cx + r0 * Math.cos(a)).toFixed(1) + ' ' + (cy + r0 * Math.sin(a)).toFixed(1)
          + 'L' + (cx + layer.outer * Math.cos(a)).toFixed(1) + ' ' + (cy + layer.outer * Math.sin(a)).toFixed(1);
      }
      layer.ticks.setAttribute('d', ticks);
      const selected = layer.dial.nearest;
      layer.labels.forEach(({ text, arc, run }, index) => {
        const a = MARK + (index - display) * pitch;
        // Off the quarter: skip drawing (the screen edges would clip it anyway).
        if (a < Math.PI * 0.9 || a > Math.PI * 1.6) {
          text.style.display = 'none';
          return;
        }
        text.style.display = '';
        const size = font * Math.min(1, layer.width / (WIDTH[role] * k));
        // The arc is the label's baseline, a little inside the band's middle so the letters sit centred on it (no
        // dominant-baseline, which Safari ignores on a textPath). It spans a whole pitch either side of the stop,
        // longer than any label, so the text is never cut off at the arc's ends.
        arc.setAttribute('d', arcPath(cx, cy, Math.max(1, mid - size * 0.34), a - pitch, a + pitch));
        text.setAttribute('font-size', String(size));
        text.setAttribute('font-weight', index === selected ? '700' : role === 'view' ? '600' : '500');
        text.setAttribute('fill', index === selected ? ACCENT : TEXT);
        text.setAttribute('opacity', String(labelOpacity(a, rings[id].stops[index].label.length * size * 0.6 / 2 / Math.max(mid, 1))));
        text.setAttribute('letter-spacing', role === 'view' ? '0.06em' : '0');
        run.textContent = role === 'view' ? rings[id].stops[index].label.toUpperCase() : rings[id].stops[index].label;
      });
      layer.group.setAttribute('aria-valuetext', rings[id].stops[selected].label);
    });
    // The wedge points in at the rim from just outside it.
    const tip = radius + 1.5 * k;
    const base = radius + 8 * k;
    const spread = (4.5 * k) / Math.max(base, 1);
    const point = (r, a) => (cx + r * Math.cos(a)).toFixed(1) + ' ' + (cy + r * Math.sin(a)).toFixed(1);
    mark.setAttribute('d', 'M' + point(tip, MARK) + ' L' + point(base, MARK - spread) + ' L' + point(base, MARK + spread) + ' Z');
    hubShape.setAttribute('d', bandPath(cx, cy, 0.01, hubRadius, Math.PI * 0.98, Math.PI * 1.52));
    hubLabel.setAttribute('x', (cx - hubRadius * 0.52).toFixed(1));
    hubLabel.setAttribute('y', (cy - hubRadius * 0.52).toFixed(1));
    hubLabel.setAttribute('font-size', String(Math.round(hubRadius * 0.62)));
  };

  const step = time => {
    frame = 0;
    const dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 1 / 60;
    lastTime = time;
    let busy = false;
    layers.forEach(layer => {
      handle(layer, layer.dial.update(dt));
      if (!layer.dial.moving) layer.quiet = false;
      layer.width += (layer.target - layer.width) * (1 - Math.exp(-FOLD_RATE * dt));
      if (Math.abs(layer.target - layer.width) < 0.3) layer.width = layer.target;
      if (layer.dial.moving || layer.width !== layer.target) busy = true;
    });
    const hubTarget = (collapsed ? HUB_COLLAPSED : HUB) * k;
    hubRadius += (hubTarget - hubRadius) * (1 - Math.exp(-FOLD_RATE * dt));
    if (Math.abs(hubTarget - hubRadius) < 0.2) hubRadius = hubTarget;
    else busy = true;
    // Rings that have folded away and are no longer wanted leave the order.
    order = order.filter(id => layers.get(id).width > 0 || layers.get(id).target > 0);
    draw();
    if (busy || press) frame = requestAnimationFrame(step);
    else {
      lastTime = 0;
      updateRoom();
    }
  };
  const kick = () => {
    if (!frame) frame = requestAnimationFrame(step);
  };

  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (press) return scheduleIdle();
      collapsed = true;
      arrange();
    }, IDLE_MS);
  };
  const wake = () => {
    if (collapsed) {
      collapsed = false;
      arrange();
    }
    scheduleIdle();
  };

  // ---- Input: one pointer at a time; the ring under the press turns with it ----
  const local = event => {
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  // In the same 0 to 2 pi range as the drawing.
  const angleOf = point => {
    const a = Math.atan2(point.y - size.h, point.x - size.w);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const ringAt = point => {
    const r = Math.hypot(point.x - size.w, point.y - size.h);
    if (r <= hubRadius + (GAP * k) / 2) return 'hub';
    const layer = order.map(id => layers.get(id)).find(item => item.width > 4 && r >= item.inner - GAP * k && r <= item.outer + GAP * k);
    return layer || null;
  };
  svg.addEventListener('pointerdown', event => {
    if (press || !event.isPrimary) return;
    const point = local(event);
    const target = ringAt(point);
    if (!target) return;
    event.preventDefault();
    // The svg itself lets touches through to the 3D view (only the bands and hub take them), so the band captures.
    try { event.target.setPointerCapture(event.pointerId); } catch (err) {}
    press = { id: event.pointerId, start: point, target, moved: false, wasCollapsed: collapsed };
    if (target !== 'hub') target.dial.grab(angleOf(point), event.timeStamp);
    clearTimeout(idleTimer);
    kick();
  });
  svg.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.id || press.target === 'hub') return;
    const point = local(event);
    if (!press.moved && Math.hypot(point.x - press.start.x, point.y - press.start.y) < TAP_PX * k) return;
    press.moved = true;
    handle(press.target, press.target.dial.move(angleOf(point), event.timeStamp));
    kick();
  });
  const endPress = (event, cancelled = false) => {
    if (!press || event.pointerId !== press.id) return;
    const current = press;
    press = null;
    if (current.target === 'hub') {
      if (!cancelled) onAdd();
      scheduleIdle();
      return;
    }
    const layer = current.target;
    if (current.moved) {
      layer.dial.release(event.timeStamp);
    } else {
      layer.dial.release(event.timeStamp);
      // A tap on a folded wheel only opens it; on an open one it turns the ring to the stop that was tapped.
      if (!current.wasCollapsed && !cancelled) {
        const offset = (angleOf(local(event)) - MARK) / layer.dial.pitch;
        layer.dial.set(Math.round(layer.dial.position + offset));
      }
    }
    wake();
    kick();
  };
  svg.addEventListener('pointerup', event => endPress(event));
  svg.addEventListener('pointercancel', event => endPress(event, true));
  // The mouse wheel (desktop): over a ring it turns that ring (down = the next stop, like turning a dial toward you);
  // over the hub or between rings it does nothing, and the page does not scroll either way.
  const turners = new Map();
  svg.addEventListener('wheel', event => {
    const target = ringAt(local(event));
    if (!target) return;
    event.preventDefault();
    if (target === 'hub' || press) return;
    const pixels = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    if (!turners.has(target.id)) turners.set(target.id, createScrollTurner());
    const stops = turners.get(target.id)(pixels, event.timeStamp);
    if (!stops) return;
    wake();
    target.dial.set((target.dial.dragging ? target.dial.nearest : target.dial.index) + stops);
    kick();
  }, { passive: false });
  hub.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onAdd();
    }
  });

  const resize = () => {
    const rect = mount.getBoundingClientRect();
    size.w = rect.width;
    size.h = rect.height;
    const nextK = Math.max(1, Math.min(rect.width, rect.height) / (BASE_PX * grow));
    if (Math.abs(nextK - k) > 0.001) {
      k = nextK;
      hubRadius = (collapsed ? HUB_COLLAPSED : HUB) * k;
      layers.forEach(layer => { layer.width = layer.target ? WIDTH[layer.role] * k : 0; });
      arrange();
    }
    svg.setAttribute('width', String(rect.width));
    svg.setAttribute('height', String(rect.height));
    svg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
    draw();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (observer) observer.observe(mount);

  arrange();
  resize();

  return {
    // The view moved on its own (a camera flight, a filter elsewhere): turn the rings to match, without a 'change'.
    sync() {
      const values = state();
      arrange();
      layers.forEach(layer => {
        if (layer.dial.dragging || (press && press.target === layer)) return;
        const index = indexOfValue(layer.id, values[layer.id]);
        if (index !== layer.dial.index) {
          layer.quiet = true;
          layer.dial.set(index, { silent: true });
        }
      });
      kick();
    },
    // Opens the wheel, as a tap would.
    wake,
    isOpen: () => !collapsed,
    // For tests and probes: the rings shown, outer to inner, with the stop each reads.
    read: () => order.slice().reverse().filter(id => layers.get(id).target > 0).map(id => {
      const layer = layers.get(id);
      return { id, value: rings[id].stops[layer.dial.nearest].value, inner: Math.round(layer.inner), outer: Math.round(layer.outer) };
    }),
    // Turns a ring one stop (tests, the keyboard).
    step: (id, delta) => {
      const layer = layers.get(id);
      if (!layer) return;
      layer.dial.step(delta);
      wake();
      kick();
    },
    destroy() {
      cancelAnimationFrame(frame);
      clearTimeout(idleTimer);
      if (observer) observer.disconnect();
      svg.remove();
    }
  };
}
