// Preview-card nodes (SPATIAL_ARCHITECTURE.md 4.3-4.4 and section 6): every node is a thin rounded card whose face is
// a canvas texture. The field owns card meshes, the texture budget, damped hover/focus/dim states, lazy turning toward
// the viewer, and the 180-degree gallery positions. The page sets targets; frame() animates. The graph library keeps
// running the force simulation on node.x/y/z; frame() places each card from those coordinates.
import { FACE_HEIGHT, FACE_WIDTH, drawDistantFace, drawFace, faceKey } from './card-faces.js';
import { galleryLayout, slotToWorld } from './layout-gallery.js';
import { smoothDamp } from './camera-rig.js';

export const CARD_WIDTH = 12;
export const CARD_HEIGHT = 7.5;
const CARD_DEPTH = 0.3;
// Corners that read as about 8px when the card is in focus.
const CARD_RADIUS = 0.66;
const TEAL = 0x00ffcc;
const WHITE = 0xffffff;
const HOVER_SCALE = 0.1;
const FOCUS_SCALE = 0.15;
// In the gallery a focused card grows 1.15 and slides up to 0.25 R toward the standpoint (section 6.3).
const GALLERY_FOCUS_SCALE = 0.075;
const GALLERY_SLIDE = 0.25;
const GALLERY_TIME = 0.45;
const STAGGER_SECONDS = 0.02;
// Face textures come in two resolutions of the same drawing: 'near' (512 x 320) for the closest and focused cards,
// 'far' (256 x 160) for the next ones, and only past both budgets the shared plain face. Moving between near and far
// shows the same content, so re-ranking as the camera moves is invisible; a margin on each budget stops cards at a
// cutoff from flipping back and forth. About 32 x 0.65 MB + 192 x 0.16 MB = 52 MB of GPU memory at most.
const NEAR_BUDGET = 32;
const FAR_BUDGET = 192;
const NEAR_MARGIN = 8;
const FAR_MARGIN = 24;
const TIER_SCALE = { near: 1, far: 0.5 };
// Faces are re-ranked every this many frames; at most this many faces are drawn per frame.
const RANK_EVERY = 20;
const DRAWS_PER_FRAME = 3;

const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
const smoothstep = t => t * t * (3 - 2 * t);

function roundedRectShape(THREE, w, h, r) {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

// Pushes overlapping cards apart. A grid hash keeps it close to linear; radius is a card's half diagonal.
export function createCollideForce(radius, strength = 0.7) {
  let nodes = [];
  const diameter = radius * 2;
  const force = () => {
    const grid = new Map();
    const cell = (x, y, z) => Math.floor(x / diameter) + ',' + Math.floor(y / diameter) + ',' + Math.floor(z / diameter);
    for (const node of nodes) {
      if (!Number.isFinite(node.x)) continue;
      const key = cell(node.x, node.y, node.z || 0);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(node);
    }
    for (const node of nodes) {
      if (!Number.isFinite(node.x)) continue;
      const cx = Math.floor(node.x / diameter);
      const cy = Math.floor(node.y / diameter);
      const cz = Math.floor((node.z || 0) / diameter);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const other of grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)) || []) {
          if (other === node || other.index < node.index) continue;
          const ox = other.x - node.x;
          const oy = other.y - node.y;
          const oz = (other.z || 0) - (node.z || 0);
          const distance = Math.hypot(ox, oy, oz) || 0.01;
          if (distance >= diameter) continue;
          const push = ((diameter - distance) / distance) * strength * 0.5;
          node.vx -= ox * push;
          node.vy -= oy * push;
          other.vx += ox * push;
          other.vy += oy * push;
          if (node.vz !== undefined) {
            node.vz -= oz * push;
            other.vz += oz * push;
          }
        }
      }
    }
  };
  force.initialize = initial => { nodes = initial; };
  return force;
}

export function createCardField({ THREE, reducedMotion = false }) {
  const shape = roundedRectShape(THREE, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS);
  const bodyGeometry = new THREE.ExtrudeGeometry(shape, { depth: CARD_DEPTH, bevelEnabled: false, curveSegments: 6 });
  bodyGeometry.translate(0, 0, -CARD_DEPTH / 2);
  const faceGeometry = new THREE.ShapeGeometry(shape, 6);
  {
    const position = faceGeometry.attributes.position;
    const uv = faceGeometry.attributes.uv;
    for (let i = 0; i < position.count; i++) uv.setXY(i, (position.getX(i) + CARD_WIDTH / 2) / CARD_WIDTH, (position.getY(i) + CARD_HEIGHT / 2) / CARD_HEIGHT);
    uv.needsUpdate = true;
  }
  const edgeGeometry = new THREE.BufferGeometry().setFromPoints(shape.getPoints(8).map(p => new THREE.Vector3(p.x, p.y, 0)));
  const teal = new THREE.Color(TEAL);
  const white = new THREE.Color(WHITE);

  const cards = new Map();
  const distantTextures = new Map();
  const images = new Map();
  const drawQueue = [];
  // Counters for debugging texture churn: faces drawn, and cards that went to or came back from the plain face.
  const stats = { draws: 0, toPlain: 0, fromPlain: 0 };
  let frameCount = 0;
  let gallery = null;
  // World units a focused gallery card slides forward; the page lowers it when open panels leave little room.
  let gallerySlide = null;

  const makeTexture = canvas => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  };

  const distantTexture = face => {
    const key = face.type + '|' + face.color;
    if (!distantTextures.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.width = FACE_WIDTH;
      canvas.height = FACE_HEIGHT;
      drawDistantFace(canvas.getContext('2d'), face);
      distantTextures.set(key, makeTexture(canvas));
    }
    return distantTextures.get(key);
  };

  // Thumbnails load with CORS so the canvas stays usable in WebGL; a host without CORS gets the placeholder art.
  const imageFor = url => {
    if (!url) return null;
    let entry = images.get(url);
    if (!entry) {
      entry = { state: 'loading', image: new Image() };
      images.set(url, entry);
      entry.image.crossOrigin = 'anonymous';
      entry.image.decoding = 'async';
      entry.image.onload = () => {
        entry.state = 'ready';
        cards.forEach(card => { if (card.face.thumbUrl === url && card.tier !== 'plain') queueDraw(card); });
      };
      entry.image.onerror = () => { entry.state = 'failed'; };
      entry.image.src = url;
    }
    return entry.state === 'ready' ? entry.image : null;
  };

  const queueDraw = card => {
    if (!drawQueue.includes(card)) drawQueue.push(card);
  };

  // Draws the card's face at its tier's resolution. A tier change gets a new canvas and texture, and the old texture
  // stays on the card until the new one is ready, so the face never blanks in between.
  const drawDetailed = card => {
    if (card.tier === 'plain') return;
    const scale = TIER_SCALE[card.tier];
    const image = imageFor(card.face.thumbUrl);
    const key = card.tier + '|' + faceKey(card.face, Boolean(image));
    if (card.texture && card.drawnKey === key) return;
    const width = Math.round(FACE_WIDTH * scale);
    const height = Math.round(FACE_HEIGHT * scale);
    let previous = null;
    if (!card.canvas || card.canvas.width !== width) {
      previous = card.texture;
      card.canvas = document.createElement('canvas');
      card.canvas.width = width;
      card.canvas.height = height;
      card.texture = null;
    }
    const ctx = card.canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFace(ctx, card.face, image);
    stats.draws++;
    if (!card.texture) card.texture = makeTexture(card.canvas);
    else card.texture.needsUpdate = true;
    card.drawnKey = key;
    card.faceMaterial.map = card.texture;
    card.faceMaterial.needsUpdate = true;
    if (previous) previous.dispose();
  };

  const setTier = (card, tier) => {
    if (card.tier === tier) return;
    const wasPlain = card.tier === 'plain';
    card.tier = tier;
    if (tier === 'plain') {
      if (card.texture) card.texture.dispose();
      card.texture = null;
      card.canvas = null;
      card.drawnKey = null;
      card.faceMaterial.map = distantTexture(card.face);
      card.faceMaterial.needsUpdate = true;
      stats.toPlain++;
      return;
    }
    if (wasPlain) stats.fromPlain++;
    queueDraw(card);
  };

  function build(node, face) {
    const id = String(node.id);
    const previous = cards.get(id);
    if (previous) dispose(previous);
    const root = new THREE.Group();
    // The face, outline and body are only fractions of a unit apart, far below what the depth buffer can separate at
    // a distance (the graph camera's far plane is 125000). Polygon offsets push the face and, further, the body back
    // by fixed depth steps, so outline over face over body holds at any distance instead of flickering.
    const faceMaterial = new THREE.MeshBasicMaterial({ map: distantTexture(face), transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    const bodyMaterial = new THREE.MeshLambertMaterial({ color: 0x0b1320, emissive: TEAL, emissiveIntensity: 0, transparent: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
    const edgeMaterial = new THREE.LineBasicMaterial({ color: WHITE, transparent: true, opacity: 0.14, depthWrite: false });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    const faceMesh = new THREE.Mesh(faceGeometry, faceMaterial);
    faceMesh.position.z = CARD_DEPTH / 2 + 0.02;
    const edge = new THREE.LineLoop(edgeGeometry, edgeMaterial);
    edge.position.z = CARD_DEPTH / 2 + 0.04;
    root.add(body, faceMesh, edge);
    const seed = [...id].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const card = {
      id, node, root, face, faceMaterial, bodyMaterial, edgeMaterial,
      texture: null, canvas: null, drawnKey: null, tier: 'plain',
      heat: 0, heatGoal: 0, dim: 0, dimGoal: 0,
      lean: { x: ((seed % 100) / 100 - 0.5) * 0.25, y: (((seed >> 7) % 100) / 100 - 0.5) * 0.35 },
      gallery: { goal: 0, weight: 0, velocity: 0, delay: 0, position: null, rotationY: 0 },
      oriented: false
    };
    cards.set(id, card);
    return root;
  }

  function dispose(card) {
    if (card.texture) card.texture.dispose();
    card.faceMaterial.dispose();
    card.bodyMaterial.dispose();
    card.edgeMaterial.dispose();
    cards.delete(card.id);
  }

  // Keeps only cards for the given node ids (the rest were filtered out and their objects dropped by the graph).
  function retain(ids) {
    cards.forEach(card => { if (!ids.has(card.id)) dispose(card); });
  }

  function setFace(id, face) {
    const card = cards.get(String(id));
    if (!card) return;
    const changedLook = card.face.type !== face.type || card.face.color !== face.color;
    card.face = face;
    if (card.tier !== 'plain') queueDraw(card);
    else if (changedLook) {
      card.faceMaterial.map = distantTexture(face);
      card.faceMaterial.needsUpdate = true;
    }
  }

  // heat: 0 rest, 0.5 hover, 1 focus. dim: 0 normal, 1 receded.
  function setTargets(id, { heat = 0, dim = 0 }) {
    const card = cards.get(String(id));
    if (!card) return;
    card.heatGoal = heat;
    card.dimGoal = dim;
  }

  // Near faces go to the hot card, gallery cards and then the nearest cards; far faces to the next ones. Each card
  // keeps its tier until it is clearly past the cutoff.
  function rankTextures(viewer) {
    const ranked = [...cards.values()].map(card => {
      const p = card.root.position;
      const distance = Math.hypot(p.x - viewer.x, p.y - viewer.y, p.z - viewer.z);
      const boost = (card.gallery.goal ? 1e6 : 0) + (card.heatGoal ? 2e6 : 0);
      return { card, score: boost - distance };
    }).sort((a, b) => b.score - a.score);
    ranked.forEach(({ card }, index) => {
      let tier = index < NEAR_BUDGET ? 'near' : index < NEAR_BUDGET + FAR_BUDGET ? 'far' : 'plain';
      if (card.tier === 'near' && tier !== 'near' && index < NEAR_BUDGET + NEAR_MARGIN) tier = 'near';
      if (card.tier === 'far' && tier === 'plain' && index < NEAR_BUDGET + FAR_BUDGET + FAR_MARGIN) tier = 'far';
      setTier(card, tier);
    });
  }

  // ---- 180-degree gallery ----

  // ids in display order; origin is the gallery centre (the viewer's standpoint) and yaw its facing (0 = -Z).
  // centerId, when given, takes the slot straight ahead on the middle row (swapping with whoever had it).
  function enterGallery(ids, { origin, yaw, minRadius = 18, centerId = null }) {
    const members = ids.map(id => cards.get(String(id))).filter(Boolean);
    const layout = galleryLayout(members.length, { cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT, minRadius });
    const centerIndex = centerId === null ? -1 : members.findIndex(card => card.id === String(centerId));
    if (centerIndex >= 0) {
      const front = layout.slots
        .filter(slot => slot.page === 0)
        .reduce((best, slot) => (Math.abs(slot.angle) + Math.abs(slot.local.y) * 0.01 < Math.abs(best.angle) + Math.abs(best.local.y) * 0.01 ? slot : best));
      [members[centerIndex], members[front.index]] = [members[front.index], members[centerIndex]];
    }
    const order = layout.slots.map((slot, index) => ({ index, spread: Math.abs(slot.angle) })).sort((a, b) => a.spread - b.spread);
    const rank = new Map(order.map((item, position) => [item.index, position]));
    cards.forEach(card => { card.gallery.goal = 0; });
    members.forEach((card, index) => {
      const placed = slotToWorld(layout.slots[index], origin, yaw);
      Object.assign(card.gallery, { goal: 1, position: placed.position, rotationY: placed.rotationY, delay: reducedMotion ? 0 : rank.get(index) * STAGGER_SECONDS });
    });
    gallery = { origin, yaw, radius: layout.radius, ids: new Set(members.map(card => card.id)), layout };
    gallerySlide = null;
    return gallery;
  }

  function exitGallery() {
    cards.forEach(card => {
      card.gallery.goal = 0;
      card.gallery.delay = 0;
    });
    gallery = null;
  }

  function galleryPosition(id) {
    const card = cards.get(String(id));
    return card && card.gallery.goal && card.gallery.position ? { ...card.gallery.position } : null;
  }

  // ---- Per-frame animation ----
  const temp = {
    matrix: new THREE.Matrix4(),
    look: new THREE.Quaternion(),
    lean: new THREE.Quaternion(),
    wall: new THREE.Quaternion(),
    euler: new THREE.Euler(),
    up: new THREE.Vector3(0, 1, 0),
    viewer: new THREE.Vector3(),
    at: new THREE.Vector3(),
    color: new THREE.Color()
  };

  function frame(dt, camera) {
    const step = Math.min(Math.max(dt, 0), 0.05);
    camera.getWorldPosition(temp.viewer);
    const viewer = temp.viewer;
    if (frameCount++ % RANK_EVERY === 0) rankTextures(viewer);
    for (let i = 0; i < DRAWS_PER_FRAME && drawQueue.length; i++) {
      const card = drawQueue.shift();
      if (cards.has(card.id)) drawDetailed(card);
    }
    const heatLambda = reducedMotion ? 40 : 7;
    const dimLambda = reducedMotion ? 40 : 4;
    const turnRate = reducedMotion ? 30 : 2.2;

    cards.forEach(card => {
      const node = card.node;
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      card.heat = damp(card.heat, card.heatGoal, heatLambda, step);
      card.dim = damp(card.dim, card.dimGoal, dimLambda, step);

      // Gallery weight follows the same critically damped spring as the camera, after its stagger delay.
      const g = card.gallery;
      if (g.delay > 0 && g.goal) g.delay -= step;
      else {
        const next = smoothDamp(g.weight, g.goal, g.velocity, reducedMotion ? 0.05 : GALLERY_TIME, step);
        g.weight = Math.min(1, Math.max(0, next.value));
        g.velocity = next.velocity;
      }
      const w = smoothstep(g.weight);
      const sim = { x: node.x, y: node.y, z: node.z || 0 };
      const target = g.position || sim;
      const at = temp.at.set(sim.x + (target.x - sim.x) * w, sim.y + (target.y - sim.y) * w, sim.z + (target.z - sim.z) * w);

      // Hot cards slide toward the viewer: a little in the cloud, toward the standpoint in the gallery.
      const inGallery = Boolean(gallery && gallery.ids.has(card.id) && w > 0.5);
      const slideGoal = inGallery ? gallery.origin : viewer;
      const slide = card.heat * (inGallery ? (gallerySlide ?? gallery.radius * GALLERY_SLIDE) : CARD_WIDTH * 0.35);
      if (slide > 0.001) {
        const dx = slideGoal.x - at.x;
        const dy = slideGoal.y - at.y;
        const dz = slideGoal.z - at.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        const k = Math.min(slide, length * 0.8) / length;
        at.x += dx * k;
        at.y += dy * k;
        at.z += dz * k;
      }
      card.root.position.copy(at);

      // Lazy turn toward the viewer with a slight lean (straight when hot); in the gallery, face the centre.
      temp.matrix.lookAt(viewer, at, temp.up);
      temp.look.setFromRotationMatrix(temp.matrix);
      const leanAmount = 1 - card.heat;
      temp.lean.setFromEuler(temp.euler.set(card.lean.x * leanAmount, card.lean.y * leanAmount, 0));
      temp.look.multiply(temp.lean);
      if (w > 0) {
        temp.wall.setFromEuler(temp.euler.set(0, g.rotationY, 0));
        temp.look.slerp(temp.wall, w);
      }
      if (!card.oriented) {
        card.root.quaternion.copy(temp.look);
        card.oriented = true;
      } else {
        card.root.quaternion.slerp(temp.look, 1 - Math.exp(-(turnRate + card.heat * 6 + w * 6) * step));
      }

      const grow = inGallery ? GALLERY_FOCUS_SCALE : card.heatGoal >= 1 ? FOCUS_SCALE : HOVER_SCALE;
      card.root.scale.setScalar(1 + card.heat * grow * 2);
      const shade = 1 - card.dim * 0.6;
      card.faceMaterial.color.setScalar(shade);
      card.faceMaterial.opacity = 1 - card.dim * 0.55;
      card.bodyMaterial.opacity = 1 - card.dim * 0.55;
      card.bodyMaterial.emissiveIntensity = card.heat * 0.3;
      card.edgeMaterial.color.copy(temp.color.copy(white).lerp(teal, Math.min(1, card.heat * 1.5)));
      card.edgeMaterial.opacity = (0.14 + card.heat * 0.8) * (1 - card.dim * 0.7);
    });
  }

  return {
    build,
    retain,
    setFace,
    setTargets,
    frame,
    enterGallery,
    exitGallery,
    galleryPosition,
    getGallery: () => gallery,
    setGallerySlide: units => { gallerySlide = Number.isFinite(units) ? Math.max(0, units) : null; },
    size: () => cards.size,
    has: id => cards.has(String(id)),
    stats: () => {
      const tiers = { near: 0, far: 0, plain: 0 };
      cards.forEach(card => { tiers[card.tier]++; });
      return { ...stats, cards: cards.size, ...tiers };
    }
  };
}
