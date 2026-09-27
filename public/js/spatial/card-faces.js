// Preview card faces (SPATIAL_ARCHITECTURE.md 4.3, D5): what a node looks like in the 3D view, drawn on a canvas so
// text stays crisp. The layout follows mockups/mockup-cards-3d.html. faceFromNode() is pure; drawFace() needs a 2D
// canvas context.

export const FACE_WIDTH = 512;
export const FACE_HEIGHT = 320;
const PAD = 24;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif';

// Card surfaces from the main portal palette (DESIGN.md, System 2).
export const SURFACES = { video: '#111a28', image: '#111a28', link: '#15213a', note: '#101722' };
const TEXT = 'rgba(255,255,255,0.94)';
const MUTED = '#8a93a6';
const BODY = '#aab3c5';

const hostOf = url => {
  try {
    return new URL(url).hostname.replace(/^www[.]/, '');
  } catch {
    return '';
  }
};

// Everything a face shows, from a portal node. categoryColor and categoryLabel come from the portal (legend colours);
// group is { name, color, source } or null.
export function faceFromNode(node, { categoryColor = MUTED, categoryLabel = '', group = null } = {}) {
  const category = String(node.category || 'note').toLowerCase();
  const url = String(node.url || '');
  const isLink = /^https?:/i.test(url);
  const type = category === 'video' ? 'video' : category === 'image' ? 'image' : isLink ? 'link' : 'note';
  const title = String(node.title || node.name || (isLink ? hostOf(url) : url) || 'Saved entry').replace(/\s+/g, ' ').trim();
  // Notes keep their text in url; links show the description, then the user's note.
  const text = type === 'note'
    ? [url !== title ? url : '', node.user_note].filter(Boolean).join(' · ')
    : [node.description, node.user_note].filter(Boolean).join(' · ');
  const created = node.created_at ? new Date(node.created_at) : null;
  return {
    id: String(node.id),
    type,
    title,
    text: String(text || '').replace(/\s+/g, ' ').trim(),
    site: isLink ? (node.site_name || hostOf(url)) : '',
    date: created && !Number.isNaN(created.getTime()) ? created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '',
    thumbUrl: typeof node.image_url === 'string' && (/^https?:/i.test(node.image_url) || node.image_url.startsWith('/api/node-image/')) ? node.image_url : null,
    color: categoryColor,
    label: String(categoryLabel || category).replace(/_/g, ' ').toUpperCase(),
    group: group ? { name: group.name, color: group.color, source: group.source } : null
  };
}

// A cheap fingerprint of what the face shows, so textures are only redrawn when something visible changed.
export function faceKey(face, imageReady) {
  return [face.type, face.title, face.text, face.site, face.date, face.color, face.label, face.group ? face.group.name + face.group.color : '', imageReady ? 1 : 0].join('|');
}

// Word-wraps into at most maxLines, ending with an ellipsis when text is cut.
export function wrapText(measure, text, maxWidth, maxLines) {
  const words = String(text || '').split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (measure(test) <= maxWidth || !line) {
      line = test;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1];
      while (measure(last + '…') > maxWidth && last.length) last = last.slice(0, -1);
      lines[maxLines - 1] = last.trimEnd() + '…';
      return lines;
    }
  }
  if (line) lines.push(line);
  // A single word longer than the line is cut to fit.
  return lines.map(item => {
    let fitted = item;
    while (measure(fitted) > maxWidth && fitted.length > 1) fitted = fitted.slice(0, -2) + '…';
    return fitted;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function seeded(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.codePointAt(0)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Placeholder when a thumbnail is missing or cannot be used: a soft gradient in the category colour with faint shapes.
function drawPlaceholder(ctx, x, y, w, h, face) {
  const rand = seeded(face.id);
  const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
  gradient.addColorStop(0, '#0d1626');
  gradient.addColorStop(1, '#16223a');
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = face.color;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(x + rand() * w, y + rand() * h, 10 + rand() * h * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawImageCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

function drawBadge(ctx, x, y, text, color) {
  ctx.font = '700 12px ' + FONT;
  const w = ctx.measureText(text).width + 14;
  roundRect(ctx, x, y, w, 20, 4);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 7, y + 10.5);
  ctx.textBaseline = 'alphabetic';
  return w;
}

// The group chip in the top-right corner, in the group's colour (a spark marks AI suggestions).
function drawGroupChip(ctx, face, rightEdge, y) {
  if (!face.group) return;
  ctx.font = '600 12px ' + FONT;
  const name = (face.group.source === 'ai' ? '✦ ' : '') + face.group.name;
  const text = wrapText(value => ctx.measureText(value).width, name, 170, 1)[0] || '';
  const w = ctx.measureText(text).width + 24;
  const x = rightEdge - w;
  roundRect(ctx, x, y, w, 20, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 9, y + 10, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = face.group.color || MUTED;
  ctx.fill();
  ctx.fillStyle = TEXT;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 17, y + 10.5);
  ctx.textBaseline = 'alphabetic';
}

function drawTitle(ctx, face, y, maxLines, size) {
  ctx.font = '600 ' + size + 'px ' + FONT;
  ctx.fillStyle = TEXT;
  const lines = wrapText(value => ctx.measureText(value).width, face.title, FACE_WIDTH - PAD * 2, maxLines);
  lines.forEach(line => {
    ctx.fillText(line, PAD, y);
    y += size * 1.2;
  });
  return y;
}

function drawMedia(ctx, face, image) {
  // Thumbnail band across the top, with a play badge on videos.
  const x = PAD;
  const y = PAD;
  const w = FACE_WIDTH - PAD * 2;
  const h = 150;
  ctx.save();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();
  if (image) drawImageCover(ctx, image, x, y, w, h);
  else drawPlaceholder(ctx, x, y, w, h, face);
  const shade = ctx.createLinearGradient(0, y + h * 0.55, 0, y + h);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  if (face.type === 'video') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,12,20,0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy - 10);
    ctx.lineTo(cx + 11, cy);
    ctx.lineTo(cx - 6, cy + 10);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  const top = y + h + 14;
  const bw = drawBadge(ctx, PAD, top, face.label, face.color);
  ctx.font = '400 13px ' + FONT;
  ctx.fillStyle = MUTED;
  ctx.textBaseline = 'middle';
  const meta = [face.site, face.date].filter(Boolean).join(' · ');
  ctx.fillText(wrapText(value => ctx.measureText(value).width, meta, FACE_WIDTH - PAD * 2 - bw - 10, 1)[0] || '', PAD + bw + 10, top + 10.5);
  ctx.textBaseline = 'alphabetic';
  drawTitle(ctx, face, top + 50, 2, 21);
}

function drawLink(ctx, face) {
  // Muted inset border, then source row, headline and excerpt.
  roundRect(ctx, 6, 6, FACE_WIDTH - 12, FACE_HEIGHT - 12, 22);
  ctx.strokeStyle = 'rgba(159,180,216,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const bw = drawBadge(ctx, PAD, PAD, face.label, face.color);
  ctx.font = '500 14px ' + FONT;
  ctx.fillStyle = '#9fb4d8';
  ctx.textBaseline = 'middle';
  ctx.fillText(wrapText(value => ctx.measureText(value).width, face.site, 200, 1)[0] || '', PAD + bw + 10, PAD + 10.5);
  ctx.textBaseline = 'alphabetic';
  let y = drawTitle(ctx, face, PAD + 62, 2, 26);
  ctx.fillStyle = 'rgba(159,180,216,0.3)';
  ctx.fillRect(PAD, y - 12, 36, 2);
  ctx.font = '400 15px ' + FONT;
  ctx.fillStyle = BODY;
  y += 12;
  wrapText(value => ctx.measureText(value).width, face.text, FACE_WIDTH - PAD * 2, 3).forEach(line => {
    ctx.fillText(line, PAD, y);
    y += 21;
  });
  if (face.date) {
    ctx.font = '400 12px ' + FONT;
    ctx.fillStyle = MUTED;
    ctx.fillText(face.date, PAD, FACE_HEIGHT - PAD + 4);
  }
}

function drawNote(ctx, face) {
  // Page icon, then title and ruled lines with the note's text on them.
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(PAD, PAD);
  ctx.lineTo(PAD + 11, PAD);
  ctx.lineTo(PAD + 16, PAD + 5);
  ctx.lineTo(PAD + 16, PAD + 20);
  ctx.lineTo(PAD, PAD + 20);
  ctx.closePath();
  ctx.stroke();
  const bw = drawBadge(ctx, PAD + 26, PAD, face.label, face.color);
  if (face.date) {
    ctx.font = '400 12px ' + FONT;
    ctx.fillStyle = MUTED;
    ctx.textBaseline = 'middle';
    ctx.fillText(face.date, PAD + 26 + bw + 10, PAD + 10.5);
    ctx.textBaseline = 'alphabetic';
  }
  drawTitle(ctx, face, PAD + 58, 1, 23);
  ctx.font = '400 16px ' + FONT;
  const lines = wrapText(value => ctx.measureText(value).width, face.text, FACE_WIDTH - PAD * 2, 6);
  for (let i = 0, y = PAD + 100; y < FACE_HEIGHT - PAD + 6; i++, y += 31) {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(PAD, y + 8, FACE_WIDTH - PAD * 2, 1);
    if (lines[i]) {
      ctx.fillStyle = 'rgba(235,240,248,0.66)';
      ctx.fillText(lines[i], PAD, y);
    }
  }
}

// Draws the whole face into a FACE_WIDTH × FACE_HEIGHT canvas. image is a loaded, CORS-clean image or null.
export function drawFace(ctx, face, image = null) {
  ctx.clearRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  ctx.fillStyle = SURFACES[face.type] || SURFACES.note;
  ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  if (face.type === 'video' || face.type === 'image') drawMedia(ctx, face, image);
  else if (face.type === 'link') drawLink(ctx, face);
  else drawNote(ctx, face);
  drawGroupChip(ctx, face, FACE_WIDTH - PAD, face.type === 'video' || face.type === 'image' ? PAD + 8 : PAD);
}

// Low-detail face for cards beyond the texture budget: surface, category strip and badge, no text.
export function drawDistantFace(ctx, face) {
  ctx.fillStyle = SURFACES[face.type] || SURFACES.note;
  ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
  ctx.fillStyle = face.color;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(PAD, PAD, 120, 10);
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 4; i++) ctx.fillRect(PAD, 90 + i * 44, i === 3 ? 260 : FACE_WIDTH - PAD * 2, 12);
  ctx.globalAlpha = 1;
}
