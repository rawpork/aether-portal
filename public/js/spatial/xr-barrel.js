// The headset lens barrel (PROJECT_STATE.md, radial controls): the thumb wheel's rings as a solid camera-lens barrel
// riding above the left wrist (or pinned at waist height), its front turned to face the user. Matte, opaque bands in
// the navy and teal system (no glass, blur or glow), lit by the scene like any solid object. The View rim is the
// outermost and furthest back; each ring inside it stands a step further forward, so in the Advanced mode the inner
// rings telescope out of the barrel, and in the Simple mode they slide back in until only the rim and the primary ring
// are left. The hub is the mode switch; a row of keys below holds the session actions.
//
// The right hand's ray grabs a ring with the trigger or the grip and turns it (dial.js does the physics; each stop
// clicks through the controller's haptics), or a quick click turns the ring to the stop under the ray. Every ring,
// the hub and the keys are pickable, so the page puts the barrel first in its ray picking.
//
// Barrel coordinates are metres in the dolly: the axis is +Z (towards the user), +Y is up, and angles run
// anticlockwise from +X as the user sees the front. Every ring reads its value at the index mark, straight up.

import { barrelRings, createDial, gearTurn } from './dial.js';

export const MARK_ANGLE = Math.PI / 2;
export const HUB_M = 0.021;
export const WIDTH_M = { view: 0.013, primary: 0.018, inner: 0.014 };
export const GAP_M = 0.0015;
// How far forward each ring stands of the one around it, and how deep the barrel runs behind the rim's front.
export const STEP_M = 0.005;
const BACK_M = 0.03;
// Label size (the text's em, metres) by role, and the free arc a label needs beyond its text.
const FONT_M = { view: 0.0058, primary: 0.0078, inner: 0.0064 };
const LABEL_PAD_M = 0.005;
// Labels further than this from the index mark (radians) are hidden: the barrel is round, but only its top reads.
const LABEL_ARC = 1.7;
// Above the wrist; where the pinned barrel sits; how it follows (as the dashboard did before it).
const WRIST_LIFT_M = 0.16;
const PINNED_DISTANCE_M = 0.5;
const PINNED_DROP_M = 0.3;
const FOLLOW_ANGLE = 0.6;
const FOLLOW_RATE = 4;
// Ring width tween (per second), and how far a ray may travel across a ring's face and still be a click (metres).
const EXTEND_RATE = 10;
const TAP_M = 0.005;
// Session keys under the barrel.
const KEY_W_M = 0.038;
const KEY_NARROW_M = 0.022;
const KEY_H_M = 0.017;
const KEY_D_M = 0.009;
const KEY_GAP_M = 0.005;
const KEY_DROP_M = 0.016;

const COLOR = {
  view: 0x0a111c,
  primary: 0x122033,
  inner: [0x0f1b2b, 0x0c1624],
  knurl: 'rgba(255,255,255,0.16)',
  accent: 0x00ffcc,
  hubText: '#041016',
  text: 0x8a93a6,
  key: 0x152032,
  keyText: '#dffdf7',
  exitText: '#ff8f8f',
  hover: 0x0b3b37
};
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// ---- Pure geometry (unit-tested) ----

// layers: innermost first, each { id, role, width (metres, 0 when retracted), full (its width when out) }. Returns
// each ring's inner and outer radius and the z of its front face, plus the hub's front and the barrel's outer radius.
// A ring stands STEP_M in front of each ring around it; one that is retracting slides back into the ring around it.
export function barrelLayout(layers) {
  const shown = layers.filter(layer => layer.width > 0.0002);
  let radius = HUB_M;
  const rings = shown.map((layer, i) => {
    const inner = radius + GAP_M;
    const outer = inner + layer.width;
    radius = outer;
    const outside = shown.length - 1 - i;
    const extend = layer.full ? Math.min(1, layer.width / layer.full) : 1;
    return { id: layer.id, role: layer.role, inner, outer, front: outside * STEP_M - (1 - extend) * STEP_M };
  });
  const hubFront = shown.length ? Math.max(...rings.map(ring => ring.front)) + STEP_M * 0.6 : 0;
  return { rings, hubFront, outer: radius };
}

// Where stop `index` sits on its ring (radians) with the ring turned to `display` stops: the current stop at the mark,
// later stops clockwise of it.
export function labelAngle(index, display, pitch) {
  return MARK_ANGLE - (index - display) * pitch;
}

// Bends a point of a flat label (x along the text, y up, origin at its middle) onto a ring of `radius` whose centre is
// straight below the label, so the text follows the ring's curve: x becomes a distance along the arc, y a distance
// out from it.
export function bendPoint(x, y, radius) {
  if (!(radius > 0)) return { x, y };
  const angle = x / radius;
  const r = radius + y;
  return { x: r * Math.sin(angle), y: r * Math.cos(angle) - radius };
}

// The angle the dial engine turns by for a point on a ring's face: the engine's positive turn runs clockwise here.
export function dialAngle(x, y) {
  return -Math.atan2(y, x);
}

// A click on a ring's face at (x, y): how many stops that point is from the mark (positive = later stops).
export function tapOffset(x, y, pitch) {
  return wrap(MARK_ANGLE - Math.atan2(y, x)) / pitch;
}

// The spacing that fits a ring's longest label along its arc at the ring's middle radius.
export function ringPitch(longestLabel, role, midRadius) {
  return Math.max(0.3, (longestLabel * FONT_M[role] * 0.62 + LABEL_PAD_M) / Math.max(midRadius, 0.001));
}

// ---- The barrel ----

// rings: { id: { name, stops: [{ value, label }] } } (view, layout, time, depth, filters). state(): { view, layout,
// time, depth, filters, simple, passthrough (true | false | null outside mixed reality) }. onChange(ringId, value) when a
// ring comes to rest on a new stop; onAction(id) for the hub ('mode') and the keys ('back', 'recenter', 'passthrough',
// 'pin', 'exit'); onTick(hand, end) for every stop a ring clicks through (hand: the controller turning it, or null).
export function createBarrel({ THREE, dolly, camera, rings, state, onChange, onAction, onTick }) {
  const root = new THREE.Group();
  root.name = 'aether-barrel';
  root.visible = false;
  dolly.add(root);

  const disposables = [];
  const keep = thing => {
    disposables.push(thing);
    return thing;
  };
  const matte = color => keep(new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));

  // Text on a transparent canvas, as a flat label facing +Z. Returns the mesh and its aspect; its colour is the tint.
  const textTexture = (text, { weight = 600, color = '#ffffff', background = null, width = 256, height = 64 } = {}) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = height * 0.62;
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    while (ctx.measureText(text).width > width * 0.94 && size > 8) {
      size -= 2;
      ctx.font = weight + ' ' + size + 'px ' + FONT;
    }
    ctx.fillText(text, width / 2, height / 2);
    const texture = keep(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  };
  const labelMesh = (text, em, options = {}) => {
    // The canvas's em is 0.62 of its height, so the plane is sized to give the wanted em.
    const height = em / 0.62;
    // Enough columns for ring labels to bend smoothly along their ring (bendLabel).
    const mesh = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(height * 4, height, 24, 1)),
      keep(new THREE.MeshBasicMaterial({ map: textTexture(text, options), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
    );
    mesh.raycast = () => {};
    mesh.renderOrder = 2;
    return mesh;
  };
  // Curves a ring label along a ring of `radius` (in the label's own units): its flat shape is kept, and it is only
  // re-bent when the radius has changed by more than 1% (rings telescope and fold).
  const bendLabel = (mesh, radius) => {
    const position = mesh.geometry.attributes.position;
    if (!mesh.userData.flat) mesh.userData.flat = Float32Array.from(position.array);
    if (mesh.userData.bent && Math.abs(mesh.userData.bent - radius) < radius * 0.01) return;
    mesh.userData.bent = radius;
    const flat = mesh.userData.flat;
    for (let i = 0; i < position.count; i++) {
      const point = bendPoint(flat[i * 3], flat[i * 3 + 1], radius);
      position.setXY(i, point.x, point.y);
    }
    position.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  };

  // Knurling for a ring's front face: fine radial ridges near its outer edge, drawn once per fill (RingGeometry maps
  // its outer edge to the texture's inscribed circle).
  const knurls = new Map();
  const knurlTexture = fill => {
    if (knurls.has(fill)) return knurls.get(fill);
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#' + fill.toString(16).padStart(6, '0');
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = COLOR.knurl;
    ctx.lineWidth = 2;
    const c = size / 2;
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * c * 0.955, c + Math.sin(a) * c * 0.955);
      ctx.lineTo(c + Math.cos(a) * c * 0.998, c + Math.sin(a) * c * 0.998);
      ctx.stroke();
    }
    const texture = keep(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    knurls.set(fill, texture);
    return texture;
  };

  // ---- Rings ----
  const layers = new Map();
  let order = [];
  let simple = false;
  let hoverKey = null;
  let grab = null;

  const indexOfValue = (id, value) => Math.max(0, rings[id].stops.findIndex(stop => stop.value === value));
  const roleOf = (id, list) => (id === 'view' ? 'view' : list.indexOf(id) === 1 ? 'primary' : 'inner');

  const makeLayer = id => {
    const values = state();
    const dial = createDial({ count: rings[id].stops.length, index: indexOfValue(id, values[id]) });
    const group = new THREE.Group();
    // The turning part (face and knurling) and the fixed drum around it.
    const drumMaterial = matte(COLOR.inner[0]);
    const faceMaterial = keep(new THREE.MeshLambertMaterial({ color: 0xffffff, map: knurlTexture(COLOR.inner[0]) }));
    const drum = new THREE.Mesh(new THREE.BufferGeometry(), drumMaterial);
    const face = new THREE.Mesh(new THREE.BufferGeometry(), faceMaterial);
    const labels = rings[id].stops.map(() => null);
    const target = { kind: 'ring', id };
    drum.userData.barrel = target;
    face.userData.barrel = target;
    group.add(drum, face);
    root.add(group);
    const layer = { id, dial, group, drum, face, labels, labelRole: null, role: 'inner', width: 0, target: 0, full: 0, geometryKey: '', inner: 0, outer: 0, front: 0, quiet: false, fill: null };
    layers.set(id, layer);
    return layer;
  };

  // Labels are drawn for the role's size (the View rim is set in capitals), so they are rebuilt if the role changes.
  const buildLabels = layer => {
    if (layer.labelRole === layer.role) return;
    layer.labels.forEach(label => { if (label) layer.group.remove(label); });
    layer.labels = rings[layer.id].stops.map(stop => {
      const text = layer.role === 'view' ? stop.label.toUpperCase() : stop.label;
      const label = labelMesh(text, FONT_M[layer.role], { weight: layer.role === 'view' ? 700 : 600 });
      layer.group.add(label);
      return label;
    });
    layer.labelRole = layer.role;
  };

  const arrange = () => {
    const values = state();
    simple = Boolean(values.simple);
    const list = barrelRings({ view: values.view, simple });
    list.forEach(id => { if (!layers.has(id)) makeLayer(id); });
    // Innermost first; rings retracting keep their place until they are gone.
    const next = list.slice().reverse();
    order.filter(id => !list.includes(id)).forEach(id => {
      const at = order.indexOf(id);
      next.splice(Math.min(at, next.length), 0, id);
    });
    order = next;
    layers.forEach(layer => {
      if (list.includes(layer.id)) layer.role = roleOf(layer.id, list);
      layer.full = WIDTH_M[layer.role];
      layer.target = list.includes(layer.id) ? layer.full : 0;
      buildLabels(layer);
    });
  };

  // ---- Hub (the Simple / Advanced switch) and the index mark ----
  const hubMaterial = matte(COLOR.accent);
  const hub = new THREE.Mesh(new THREE.BufferGeometry(), hubMaterial);
  hub.userData.barrel = { kind: 'hub', id: 'mode' };
  root.add(hub);
  const hubLabels = {
    simple: labelMesh('SIMPLE', 0.0042, { weight: 800, color: COLOR.hubText }),
    advanced: labelMesh('ADVANCED', 0.0042, { weight: 800, color: COLOR.hubText })
  };
  const hubCaption = labelMesh('MODE', 0.0028, { weight: 700, color: COLOR.hubText });
  Object.values(hubLabels).forEach(label => root.add(label));
  root.add(hubCaption);
  let hubKey = '';

  const markMaterial = matte(COLOR.accent);
  const mark = new THREE.Mesh(keep(new THREE.ConeGeometry(0.0045, 0.009, 16)), markMaterial);
  mark.rotation.z = Math.PI;
  mark.raycast = () => {};
  root.add(mark);

  // ---- Keys ----
  // Zoom keys are narrow (a sign each); they matter with tracked hands, which have no thumbstick to zoom with.
  const KEYS = [
    ['back', 'Back'],
    ['recenter', 'Recenter'],
    ['zoom-out', '−', KEY_NARROW_M],
    ['zoom-in', '+', KEY_NARROW_M],
    ['passthrough', 'Room'],
    ['pin', 'Pin'],
    ['exit', 'Exit']
  ];
  const keys = KEYS.map(([id, text, width = KEY_W_M]) => {
    const material = matte(COLOR.key);
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(width, KEY_H_M, KEY_D_M)), material);
    mesh.userData.barrel = { kind: 'key', id };
    const labels = {};
    const variants = id === 'passthrough' ? { on: 'Room on', off: 'Room off' } : id === 'pin' ? { on: 'Unpin', off: 'Pin' } : { on: text };
    Object.entries(variants).forEach(([name, label]) => {
      const mesh2 = labelMesh(label, 0.0046, { weight: 700, color: id === 'exit' ? COLOR.exitText : COLOR.keyText });
      mesh2.position.z = KEY_D_M / 2 + 0.0005;
      mesh2.visible = false;
      mesh.add(mesh2);
      labels[name] = mesh2;
    });
    root.add(mesh);
    return { id, mesh, material, labels, width };
  });

  // ---- Geometry, rebuilt only when a ring's size or place changes (while it telescopes) ----
  const setGeometry = (mesh, geometry) => {
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  };
  const drumGeometry = (inner, outer, front) => {
    const back = -BACK_M;
    const profile = [
      new THREE.Vector2(inner, front),
      new THREE.Vector2(inner, back),
      new THREE.Vector2(outer, back),
      new THREE.Vector2(outer, front)
    ];
    // Lathe turns around +Y; the barrel's axis is +Z.
    return new THREE.LatheGeometry(profile, 96).rotateX(Math.PI / 2);
  };

  let lastLayout = null;
  const draw = () => {
    const layout = barrelLayout(order.map(id => {
      const layer = layers.get(id);
      return { id, role: layer.role, width: layer.width, full: layer.full };
    }));
    lastLayout = layout;
    const primary = layers.get(order.find(id => layers.get(id).role === 'primary' && layers.get(id).target > 0));
    const placed = new Map(layout.rings.map(ring => [ring.id, ring]));
    // Inner rings take turns between two fills, counting outward from the primary ring.
    const innerOrder = order.slice().reverse().filter(id => layers.get(id).role === 'inner');
    layers.forEach(layer => {
      const ring = placed.get(layer.id);
      layer.group.visible = Boolean(ring);
      if (!ring) return;
      layer.inner = ring.inner;
      layer.outer = ring.outer;
      layer.front = ring.front;
      const fill = layer.role === 'inner' ? COLOR.inner[innerOrder.indexOf(layer.id) % 2] : COLOR[layer.role];
      if (fill !== layer.fill) {
        layer.fill = fill;
        layer.drum.material.color.setHex(fill);
        layer.face.material.map = knurlTexture(fill);
        layer.face.material.needsUpdate = true;
      }
      const key = [ring.inner, ring.outer, ring.front].map(v => v.toFixed(4)).join(',');
      if (key !== layer.geometryKey) {
        layer.geometryKey = key;
        setGeometry(layer.drum, drumGeometry(ring.inner, ring.outer, ring.front));
        const face = new THREE.RingGeometry(ring.inner, ring.outer, 96, 1);
        face.translate(0, 0, ring.front + 0.0004);
        setGeometry(layer.face, face);
      }
      // The face turns with the ring; inner rings' knurling is also geared to the primary ring.
      const depth = innerOrder.indexOf(layer.id) + 1;
      const mid = (ring.inner + ring.outer) / 2;
      const longest = Math.max(...rings[layer.id].stops.map(stop => stop.label.length));
      layer.dial.setPitch(ringPitch(longest, layer.role, mid));
      const pitch = layer.dial.pitch;
      const display = layer.dial.display;
      const gear = layer.role === 'inner' && primary ? gearTurn(primary.dial.display, primary.dial.pitch, depth) : 0;
      layer.face.rotation.z = display * pitch - gear;
      const selected = layer.dial.nearest;
      const scale = Math.min(1, layer.width / (layer.full || 1));
      layer.labels.forEach((label, index) => {
        const a = labelAngle(index, display, pitch);
        const off = Math.abs(wrap(a - MARK_ANGLE));
        label.visible = off < LABEL_ARC && scale > 0.35;
        if (!label.visible) return;
        label.position.set(mid * Math.cos(a), mid * Math.sin(a), ring.front + 0.0012);
        label.rotation.z = a - MARK_ANGLE;
        label.scale.setScalar(scale);
        bendLabel(label, mid / scale);
        label.material.color.setHex(index === selected ? COLOR.accent : COLOR.text);
        // Labels fade toward the edge of the readable arc.
        label.material.opacity = Math.min(1, (LABEL_ARC - off) / 0.4);
      });
      const hovered = hoverKey === 'ring:' + layer.id || (grab && grab.layer === layer);
      layer.drum.material.emissive.setHex(hovered ? COLOR.hover : 0x000000);
      layer.face.material.emissive.setHex(hovered ? COLOR.hover : 0x000000);
    });
    // Hub: a solid cap standing out of the innermost ring.
    const hubKeyNow = layout.hubFront.toFixed(4);
    if (hubKeyNow !== hubKey) {
      hubKey = hubKeyNow;
      const depthM = layout.hubFront + BACK_M;
      const geometry = new THREE.CylinderGeometry(HUB_M, HUB_M, depthM, 48).rotateX(Math.PI / 2);
      geometry.translate(0, 0, layout.hubFront - depthM / 2);
      setGeometry(hub, geometry);
    }
    hubLabels.simple.visible = simple;
    hubLabels.advanced.visible = !simple;
    Object.values(hubLabels).forEach(label => label.position.set(0, -0.001, layout.hubFront + 0.0008));
    hubCaption.position.set(0, 0.0085, layout.hubFront + 0.0008);
    hubMaterial.emissive.setHex(hoverKey === 'hub:mode' ? 0x0a3a33 : 0x000000);
    // The mark points in at the rim, straight up, at the rim's front.
    const rim = layout.rings[layout.rings.length - 1];
    mark.position.set(0, layout.outer + 0.0055, rim ? rim.front + 0.002 : 0);
    // Keys: one row under the barrel.
    const values = state();
    const shownKeys = keys.filter(key => key.id !== 'passthrough' || (values.passthrough !== null && values.passthrough !== undefined));
    const rowWidth = shownKeys.reduce((sum, key) => sum + key.width, 0) + (shownKeys.length - 1) * KEY_GAP_M;
    let x = -rowWidth / 2;
    keys.forEach(key => {
      key.mesh.visible = shownKeys.includes(key);
      if (!key.mesh.visible) return;
      key.mesh.position.set(x + key.width / 2, -(layout.outer + KEY_DROP_M + KEY_H_M / 2), -KEY_D_M / 2);
      x += key.width + KEY_GAP_M;
      const on = key.id === 'passthrough' ? Boolean(values.passthrough) : key.id === 'pin' ? pinned : true;
      if (key.labels.off) {
        key.labels.on.visible = on;
        key.labels.off.visible = !on;
      } else {
        key.labels.on.visible = true;
      }
      const active = (key.id === 'passthrough' && values.passthrough) || (key.id === 'pin' && pinned);
      key.material.color.setHex(active ? 0x0f3b3a : COLOR.key);
      key.material.emissive.setHex(hoverKey === 'key:' + key.id ? COLOR.hover : 0x000000);
    });
  };

  // ---- Placement (wrist or pinned), as the flat dashboard did ----
  const temp = {
    matrix: new THREE.Matrix4(),
    up: new THREE.Vector3(0, 1, 0),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    inverse: new THREE.Matrix4(),
    ray: new THREE.Ray(),
    plane: new THREE.Plane(),
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 0, 1)
  };
  let shown = true;
  let pinned = false;
  let pinnedYaw = null;
  let following = false;
  let lastTime = 0;
  const headYaw = () => {
    temp.euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return temp.euler.y;
  };
  // Turns the barrel's front (+Z) to the head, upright.
  const face = () => {
    temp.matrix.lookAt(camera.position, root.position, temp.up);
    root.quaternion.setFromRotationMatrix(temp.matrix);
  };

  // A ray (world) where it crosses the plane of a ring's face, in barrel coordinates, or null.
  const onFace = (raycaster, layer) => {
    root.updateMatrixWorld(true);
    temp.inverse.copy(root.matrixWorld).invert();
    temp.ray.copy(raycaster.ray).applyMatrix4(temp.inverse);
    temp.plane.setFromNormalAndCoplanarPoint(temp.normal, temp.point.set(0, 0, layer.front));
    const hit = temp.ray.intersectPlane(temp.plane, new THREE.Vector3());
    return hit ? { x: hit.x, y: hit.y } : null;
  };

  const handle = (layer, events, hand) => {
    events.forEach(event => {
      if (event.type === 'tick' && !layer.quiet && onTick) onTick(hand, event.end);
      if (event.type === 'change') onChange(layer.id, rings[layer.id].stops[event.index].value);
    });
  };

  const pickables = () => {
    const list = [hub];
    layers.forEach(layer => { if (layer.group.visible && layer.width > 0.004) list.push(layer.drum, layer.face); });
    keys.forEach(key => { if (key.mesh.visible) list.push(key.mesh); });
    return list;
  };

  arrange();
  layers.forEach(layer => { layer.width = layer.target; });
  draw();

  // The hand a stop turned by a click belongs to, for its haptic clicks.
  let lastHand = null;

  return {
    group: root,
    // The part under a ray (a THREE.Raycaster already set): { distance, kind, id } or null.
    pick(raycaster) {
      if (!root.visible) return null;
      root.updateMatrixWorld(true);
      const hit = raycaster.intersectObjects(pickables(), false)[0];
      if (!hit) return null;
      return { distance: hit.distance, ...hit.object.userData.barrel };
    },
    setHover(part) {
      hoverKey = part ? part.kind + ':' + part.id : null;
    },
    // The trigger or grip went down with the ray on the barrel: a ring is taken hold of. Returns whether it was.
    grab(raycaster, hand, time = performance.now()) {
      if (grab) return false;
      const part = this.pick(raycaster);
      if (!part || part.kind !== 'ring') return false;
      const layer = layers.get(part.id);
      const point = layer && onFace(raycaster, layer);
      if (!point) return false;
      grab = { hand, layer, start: point, moved: false, last: point };
      layer.quiet = false;
      layer.dial.grab(dialAngle(point.x, point.y), time);
      return true;
    },
    // Every frame while held: the ray's new crossing of the ring's face turns it.
    drag(raycaster, hand, time = performance.now()) {
      if (!grab || grab.hand !== hand) return;
      const point = onFace(raycaster, grab.layer);
      if (!point) return;
      grab.last = point;
      if (!grab.moved && Math.hypot(point.x - grab.start.x, point.y - grab.start.y) < TAP_M) return;
      grab.moved = true;
      handle(grab.layer, grab.layer.dial.move(dialAngle(point.x, point.y), time), hand);
    },
    release(hand, time = performance.now()) {
      if (!grab || grab.hand !== hand) return;
      const { layer, moved, last } = grab;
      grab = null;
      lastHand = hand;
      layer.dial.release(time);
      // A click turns the ring to the stop the ray was on.
      if (!moved) layer.dial.set(Math.round(layer.dial.position + tapOffset(last.x, last.y, layer.dial.pitch)));
    },
    isGrabbing: hand => Boolean(grab && (hand === undefined || grab.hand === hand)),
    // The view moved on its own: turn the rings to match, quietly, and telescope rings in or out for the mode.
    sync() {
      const values = state();
      arrange();
      layers.forEach(layer => {
        if (grab && grab.layer === layer) return;
        const index = indexOfValue(layer.id, values[layer.id]);
        if (index !== layer.dial.index && !layer.dial.moving) {
          layer.quiet = true;
          layer.dial.set(index, { silent: true });
        }
      });
    },
    isShown: () => root.visible,
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
    },
    // For tests and probes: the rings shown, outer to inner, with the stop each reads and its size.
    read: () => order.slice().reverse().filter(id => layers.get(id).target > 0).map(id => {
      const layer = layers.get(id);
      return { id, value: rings[id].stops[layer.dial.nearest].value, inner: layer.inner, outer: layer.outer, front: layer.front };
    }),
    // Every XR frame: wristGrip is the left grip (or null when that hand is not tracked).
    frame(wristGrip, time = performance.now()) {
      const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0;
      lastTime = time;
      root.visible = shown && (pinned || Boolean(wristGrip));
      layers.forEach(layer => {
        handle(layer, layer.dial.update(dt), grab && grab.layer === layer ? grab.hand : lastHand);
        if (!layer.dial.moving) layer.quiet = false;
        layer.width += (layer.target - layer.width) * (1 - Math.exp(-EXTEND_RATE * dt));
        if (Math.abs(layer.target - layer.width) < 0.0002) layer.width = layer.target;
      });
      order = order.filter(id => layers.get(id).width > 0 || layers.get(id).target > 0);
      if (!root.visible) return;
      if (pinned) {
        const yaw = headYaw();
        const delta = wrap(yaw - pinnedYaw);
        if (Math.abs(delta) > FOLLOW_ANGLE || following) {
          following = Math.abs(delta) > 0.02;
          pinnedYaw += delta * Math.min(1, FOLLOW_RATE * dt);
        }
        root.position.set(
          camera.position.x - Math.sin(pinnedYaw) * PINNED_DISTANCE_M,
          camera.position.y - PINNED_DROP_M,
          camera.position.z - Math.cos(pinnedYaw) * PINNED_DISTANCE_M
        );
      } else {
        root.position.set(wristGrip.position.x, wristGrip.position.y + WRIST_LIFT_M, wristGrip.position.z);
      }
      face();
      draw();
    },
    layout: () => lastLayout,
    dispose() {
      dolly.remove(root);
      root.traverse(object => { if (object.geometry) object.geometry.dispose(); });
      disposables.forEach(thing => thing.dispose());
    }
  };
}
