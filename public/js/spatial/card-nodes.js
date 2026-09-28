// Preview-card nodes (SPATIAL_ARCHITECTURE.md 4.3-4.4 and section 6): every node is a thin rounded card whose face is
// a canvas texture. The field owns card meshes, the texture budget, damped hover/focus/dim states, lazy turning toward
// the viewer, and the 180-degree gallery positions. The page sets targets; frame() animates. The graph library keeps
// running the force simulation on node.x/y/z; frame() places each card from those coordinates.
import { FACE_HEIGHT, FACE_WIDTH, drawDistantFace, drawFace, faceKey } from './card-faces.js';
import { galleryLayout, slotToWorld } from './layout-gallery.js';
import { smoothDamp } from './camera-rig.js';
import { HUB_MAX_SCALE, OUTCOME_CATEGORY, OUTCOME_GOLD, glowOpacity, hubScale } from './hub-weights.js';
import { lodGoal } from './lod.js';

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
// Face textures come in resolutions of the same drawing: 'hero' (1536 x 960) for the focused card only, so its text
// stays sharp when it fills much of the screen on a high-density display; 'near' (512 x 320) for the closest cards,
// 'far' (256 x 160) for the next ones, and only past those budgets the shared plain face. Moving between tiers shows
// the same content, so re-ranking as the camera moves is invisible; a margin on each budget stops cards at a cutoff
// from flipping back and forth. About 5.9 MB + 32 x 0.65 MB + 192 x 0.16 MB = 58 MB of GPU memory at most.
const NEAR_BUDGET = 32;
const FAR_BUDGET = 192;
const NEAR_MARGIN = 8;
const FAR_MARGIN = 24;
const TIER_SCALE = { hero: 3, near: 1, far: 0.5 };
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

// Pushes overlapping cards apart. A grid hash keeps it close to linear; radius is a card's half diagonal, grown by
// the node's hub scale (node.__hub, set by the page) so big hubs keep their neighbours back.
export function createCollideForce(radius, strength = 0.7) {
  let nodes = [];
  const diameter = radius * 2 * HUB_MAX_SCALE;
  const radiusOf = node => radius * (node.__hub || 1);
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
          const reach = radiusOf(node) + radiusOf(other);
          if (distance >= reach) continue;
          const push = ((reach - distance) / distance) * strength * 0.5;
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
    texture.anisotropy = 8;
    return texture;
  };

  // One soft radial falloff shared by every glow sprite (DESIGN.md glow exception: hubs and Outcome Nodes only).
  let glowTexture = null;
  const getGlowTexture = () => {
    if (glowTexture) return glowTexture;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.12)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    glowTexture = makeTexture(canvas);
    return glowTexture;
  };
  // The glow sprite is created the first time a card needs one and hidden when it no longer does.
  const ensureGlow = card => {
    if (card.glow) return card.glow;
    const material = new THREE.SpriteMaterial({ map: getGlowTexture(), color: WHITE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.position.z = -CARD_DEPTH;
    sprite.renderOrder = -1;
    // The halo is decoration and reaches well past the card: it must never take a click, or taps on the empty space
    // around a glowing card (a double tap to leave the gallery, for one) land on that card instead.
    sprite.raycast = () => {};
    card.root.add(sprite);
    card.glow = sprite;
    return sprite;
  };
  const glowColor = new THREE.Color();
  let clock = 0;

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
      heat: 0, heatGoal: 0, dim: 0, dimGoal: 0, weight: 0, weightGoal: 0, lod: 0, hidden: false,
      lean: { x: ((seed % 100) / 100 - 0.5) * 0.25, y: (((seed >> 7) % 100) / 100 - 0.5) * 0.35 },
      gallery: { goal: 0, weight: 0, velocity: 0, delay: 0, position: null, rotationY: 0 },
      oriented: false
    };
    cards.set(id, card);
    return root;
  }

  function dispose(card) {
    if (card.glow) card.glow.material.dispose();
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

  // heat: 0 rest, 0.5 hover, 1 focus. dim: 0 normal, 1 receded. weight: hub weight 0..1 (section 2.9).
  function setTargets(id, { heat = 0, dim = 0, weight }) {
    const card = cards.get(String(id));
    if (!card) return;
    card.heatGoal = heat;
    card.dimGoal = dim;
    if (Number.isFinite(weight)) card.weightGoal = weight;
  }

  // Near faces go to the hot card, gallery cards and then the nearest cards; far faces to the next ones. Each card
  // keeps its tier until it is clearly past the cutoff.
  function rankTextures(viewer) {
    const ranked = [...cards.values()].map(card => {
      const p = card.root.position;
      const distance = Math.hypot(p.x - viewer.x, p.y - viewer.y, p.z - viewer.z);
      const boost = (card.gallery.goal ? 1e6 : 0) + (card.heatGoal ? 2e6 : 0) + (proxyTops.has(card.id) ? 5e5 : 0) - (card.lod > 0.98 ? 1e5 : 0);
      return { card, score: boost - distance };
    }).sort((a, b) => b.score - a.score);
    ranked.forEach(({ card }, index) => {
      // heat 1 is the focused card (at most one).
      if (card.heatGoal >= 1) {
        setTier(card, 'hero');
        return;
      }
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

  // ---- Group proxies and level of detail (sections 2.4-2.5) ----
  // The page reports its clusters (centre, radius, members, label, colour, newest member). Each frame every cluster
  // gets a damped LOD value: 0 shows its cards, 1 its proxy, a stack of three cards fronted by the newest member's
  // face with a caption of name and count. Cards fully collapsed into a proxy move to a hidden layer, so they are
  // neither drawn nor hit by clicks, and taps reach the proxy.
  const HIDDEN_LAYER = 5;
  const proxyRoot = new THREE.Group();
  proxyRoot.name = 'aether-group-proxies';
  const proxies = new Map();
  const lodState = new Map();
  const proxyTops = new Set();
  let clusters = new Map();
  let clusterOfCard = new Map();
  let lodMode = 'auto';

  // three.js raycasts ignore .visible, and 3d-force-graph treats the nearest hit of any kind as the click target, so
  // anything not meant to be clicked (collapsed cards, faded or hidden proxies) must also leave the default layer.
  const setClickable = (object, clickable) => {
    object.traverse(child => child.layers.set(clickable ? 0 : HIDDEN_LAYER));
  };
  const setCardHidden = (card, hidden) => {
    if (card.hidden === hidden) return;
    card.hidden = hidden;
    card.root.visible = !hidden;
    setClickable(card.root, !hidden);
  };

  const captionCanvas = (label, count, color) => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.font = '700 34px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color || '#dffdf7';
    let name = String(label || '').toUpperCase();
    while (ctx.measureText(name).width > 330 && name.length > 1) name = name.slice(0, -2) + '…';
    ctx.fillText(name, 12, 48);
    ctx.font = '500 28px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#8a93a6';
    ctx.textAlign = 'right';
    ctx.fillText(count + (count === 1 ? ' card' : ' cards'), 500, 50);
    return canvas;
  };

  const buildProxy = cluster => {
    const group = new THREE.Group();
    const backMaterial = () => new THREE.MeshBasicMaterial({ color: 0x111a28, transparent: true, opacity: 0, depthWrite: false });
    const backs = [backMaterial(), backMaterial()];
    const back2 = new THREE.Mesh(faceGeometry, backs[0]);
    back2.position.set(1.4, 1.1, -0.8);
    const back1 = new THREE.Mesh(faceGeometry, backs[1]);
    back1.position.set(0.7, 0.55, -0.4);
    const frontMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const front = new THREE.Mesh(faceGeometry, frontMaterial);
    front.userData.cluster = cluster.key;
    const edgeMaterial = new THREE.LineBasicMaterial({ color: WHITE, transparent: true, opacity: 0, depthWrite: false });
    const edge = new THREE.LineLoop(edgeGeometry, edgeMaterial);
    edge.position.z = 0.05;
    const captionMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const caption = new THREE.Mesh(new THREE.PlaneGeometry(CARD_WIDTH * 1.5, CARD_WIDTH * 1.5 * 96 / 512), captionMaterial);
    caption.position.set(0, -CARD_HEIGHT / 2 - 2, 0);
    caption.userData.cluster = cluster.key;
    group.add(back2, back1, front, edge, caption);
    proxyRoot.add(group);
    return { group, backs, frontMaterial, edgeMaterial, captionMaterial, captionKey: null, front, caption };
  };

  const disposeProxy = proxy => {
    proxyRoot.remove(proxy.group);
    proxy.backs.forEach(material => material.dispose());
    proxy.frontMaterial.dispose();
    proxy.edgeMaterial.dispose();
    if (proxy.captionMaterial.map) proxy.captionMaterial.map.dispose();
    proxy.captionMaterial.dispose();
    proxy.caption.geometry.dispose();
  };

  // list: [{ key, center, radius, ids, label, color, count, topId }]
  function setClusters(list) {
    clusters = new Map(list.map(cluster => [cluster.key, cluster]));
    clusterOfCard = new Map();
    proxyTops.clear();
    clusters.forEach(cluster => {
      cluster.ids.forEach(id => clusterOfCard.set(String(id), cluster.key));
      if (cluster.topId) proxyTops.add(String(cluster.topId));
    });
    proxies.forEach((proxy, key) => {
      if (clusters.has(key)) return;
      disposeProxy(proxy);
      proxies.delete(key);
      lodState.delete(key);
    });
  }

  // 'cards', 'auto' or 'groups' (lod.js); the page sets it from the time scope.
  function setLodMode(mode) {
    lodMode = mode;
  }

  const updateLod = (viewer, step) => {
    const lambda = reducedMotion ? 40 : 6;
    clusters.forEach((cluster, key) => {
      const distance = Math.hypot(cluster.center.x - viewer.x, cluster.center.y - viewer.y, cluster.center.z - viewer.z);
      const active = [...cluster.ids].some(id => {
        const card = cards.get(String(id));
        return card && (card.heatGoal > 0 || card.gallery.goal > 0);
      });
      const goal = lodGoal({ distance, radius: cluster.radius, mode: lodMode, active });
      const value = damp(lodState.get(key) ?? goal, goal, lambda, step);
      lodState.set(key, value);
      let proxy = proxies.get(key);
      if (value < 0.01) {
        if (proxy && proxy.group.visible) {
          proxy.group.visible = false;
          setClickable(proxy.group, false);
          proxy.clickable = false;
        }
        return;
      }
      if (!proxy) {
        proxy = buildProxy(cluster);
        proxy.clickable = true;
        setClickable(proxy.group, false);
        proxy.clickable = false;
        proxies.set(key, proxy);
      }
      // A proxy only takes clicks once it is mostly faded in; before that, clicks go to the cards around it.
      const clickable = value >= 0.5;
      if (proxy.clickable !== clickable) {
        setClickable(proxy.group, clickable);
        proxy.clickable = clickable;
      }
      const captionKey = cluster.label + '|' + cluster.count + '|' + cluster.color;
      if (proxy.captionKey !== captionKey) {
        if (proxy.captionMaterial.map) proxy.captionMaterial.map.dispose();
        proxy.captionMaterial.map = makeTexture(captionCanvas(cluster.label, cluster.count, cluster.color));
        proxy.captionMaterial.needsUpdate = true;
        proxy.captionKey = captionKey;
      }
      const top = cards.get(String(cluster.topId));
      if (top && proxy.frontMaterial.map !== top.faceMaterial.map) {
        proxy.frontMaterial.map = top.faceMaterial.map;
        proxy.frontMaterial.needsUpdate = true;
      }
      proxy.group.visible = true;
      // Legible from afar: grows with viewing distance (roughly constant on screen), never smaller than two cards.
      const size = Math.min(6, Math.max(2.2, distance / 150));
      proxy.group.scale.setScalar(size);
      proxy.group.position.set(cluster.center.x, cluster.center.y, cluster.center.z);
      temp.matrix.lookAt(viewer, proxy.group.position, temp.up);
      proxy.group.quaternion.setFromRotationMatrix(temp.matrix);
      proxy.backs[0].opacity = 0.7 * value;
      proxy.backs[1].opacity = 0.85 * value;
      proxy.frontMaterial.opacity = value;
      proxy.edgeMaterial.color.set(cluster.color || WHITE);
      proxy.edgeMaterial.opacity = 0.5 * value;
      proxy.captionMaterial.opacity = value;
    });
  };

  // Proxy meshes a click can land on (front card and caption), for the page's raycast.
  const proxyTargets = () => [...proxies.values()].filter(proxy => proxy.group.visible && (lodState.get(proxy.front.userData.cluster) || 0) >= 0.5)
    .flatMap(proxy => [proxy.front, proxy.caption]);

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
    clock += step;
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

    updateLod(viewer, step);

    cards.forEach(card => {
      const node = card.node;
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      const cluster = clusterOfCard.get(card.id);
      card.lod = cluster ? lodState.get(cluster) || 0 : 0;
      setCardHidden(card, card.lod > 0.98);
      if (card.hidden) return;
      card.heat = damp(card.heat, card.heatGoal, heatLambda, step);
      card.dim = damp(card.dim, card.dimGoal, dimLambda, step);
      card.weight = damp(card.weight, card.weightGoal, dimLambda, step);

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
      // Hubs are bigger in the cloud; on the gallery wall every card is the same size so the arc stays even.
      const hub = 1 + (hubScale(card.weight) - 1) * (1 - w);
      card.root.scale.setScalar(hub * (1 + card.heat * grow * 2));
      const shade = 1 - card.dim * 0.6;
      const present = 1 - card.lod;
      card.faceMaterial.color.setScalar(shade);
      card.faceMaterial.opacity = (1 - card.dim * 0.55) * present;
      card.bodyMaterial.opacity = (1 - card.dim * 0.55) * present;
      card.bodyMaterial.emissiveIntensity = card.heat * 0.3;
      // Outcome Nodes keep a gold outline at rest; focus still turns it teal.
      const isOutcome = card.face.type === 'outcome';
      card.edgeMaterial.color.copy(temp.color.set(isOutcome ? OUTCOME_GOLD : WHITE).lerp(teal, Math.min(1, card.heat * 1.5)));
      card.edgeMaterial.opacity = ((isOutcome ? 0.6 : 0.14) + card.heat * 0.8) * (1 - card.dim * 0.7) * present;

      // Glow: hubs in their category colour, Outcome Nodes in Outcome Gold with a slow breathing pulse. It fades out
      // with dimming, and the card's own scale carries it (the sprite is a child of the card).
      const outcome = String(node.category || '').toLowerCase() === OUTCOME_CATEGORY;
      const pulse = reducedMotion ? 0.85 : 0.75 + 0.25 * Math.sin((clock * Math.PI * 2) / 4);
      const glow = (outcome ? 0.7 * pulse : glowOpacity(card.weight)) * (1 - card.dim) * present;
      if (glow > 0.005 || card.glow) {
        const sprite = ensureGlow(card);
        sprite.visible = glow > 0.005;
        if (sprite.visible) {
          try {
            glowColor.set(outcome ? OUTCOME_GOLD : card.face.color);
          } catch {
            glowColor.set(WHITE);
          }
          sprite.material.color.copy(glowColor);
          sprite.material.opacity = glow;
          const spread = outcome ? 2 : 1.4 + 0.5 * Math.min(1, card.weight);
          sprite.scale.set(CARD_WIDTH * spread, CARD_HEIGHT * spread * 1.25, 1);
        }
      }
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
    proxyRoot,
    hiddenLayer: HIDDEN_LAYER,
    setClusters,
    setLodMode,
    proxyTargets,
    clusterLod: key => lodState.get(key) || 0,
    has: id => cards.has(String(id)),
    stats: () => {
      const tiers = { hero: 0, near: 0, far: 0, plain: 0 };
      cards.forEach(card => { tiers[card.tier]++; });
      return { ...stats, cards: cards.size, ...tiers };
    }
  };
}
