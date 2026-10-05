// Far-zoom label chips (semantic level of detail): once a card is too small on screen to read (Space, and Cluster from
// far off), it is labelled with a crisp chip of a category dot and its title, a fixed size on screen. Chips that would
// overlap are left out, the most important first (the focused card, hubs, cards not receded), so the graph reads as
// labelled islands instead of a heap of specks or a pile of overlapping text. Pure helpers; card-nodes.js draws them.

// A card narrower than this on screen (CSS px) gets a chip; it gives the chip up again above CHIP_HIDE_PX.
export const CHIP_SHOW_PX = 64;
export const CHIP_HIDE_PX = 80;
export const CHIP_HEIGHT = 24;
export const CHIP_MAX_TEXT = 200;
// Gap kept between placed chips (CSS px).
export const CHIP_GAP = 4;

const FONT = '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';

// The chip's title: one line, cut with an ellipsis to fit maxWidth (measure(text) gives a width in CSS px).
export function fitTitle(title, measure, maxWidth = CHIP_MAX_TEXT) {
  const text = String(title || '').replace(/\s+/g, ' ').trim() || 'Untitled';
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid).trimEnd() + '…') <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

// Draws a chip onto a canvas at `scale` device pixels per CSS pixel and returns its CSS size { width, height }.
export function drawChip(canvas, { title, color }, scale = 2) {
  const probe = canvas.getContext('2d');
  probe.font = FONT;
  const text = fitTitle(title, (value) => probe.measureText(value).width);
  const width = Math.ceil(probe.measureText(text).width) + 30;
  const height = CHIP_HEIGHT;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const r = height / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0.5);
  ctx.lineTo(width - r, 0.5);
  ctx.arc(width - r, r, r - 0.5, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(r, height - 0.5);
  ctx.arc(r, r, r - 0.5, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(11,19,32,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(12, r, 4, 0, Math.PI * 2);
  ctx.fillStyle = color || '#8a93a6';
  ctx.fill();
  ctx.font = FONT;
  ctx.fillStyle = '#dffdf7';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 22, r + 0.5);
  return { width, height };
}

// Greedy decluttering: candidates [{ id, x, y, width, height, priority }] (centre and size in CSS px), highest priority
// first, each kept when its box (plus CHIP_GAP) meets no box already kept. Returns the Set of kept ids.
export function placeChips(candidates, gap = CHIP_GAP) {
  const kept = [];
  const ids = new Set();
  candidates
    .slice()
    .sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)))
    .forEach((c) => {
      const box = { l: c.x - c.width / 2 - gap, r: c.x + c.width / 2 + gap, t: c.y - c.height / 2 - gap, b: c.y + c.height / 2 + gap };
      if (kept.some((k) => box.l < k.r && box.r > k.l && box.t < k.b && box.b > k.t)) return;
      kept.push(box);
      ids.add(c.id);
    });
  return ids;
}

// Whether a card of this on-screen width wants a chip, with hysteresis so it doesn't flicker at the threshold.
export function wantsChip(pixelWidth, hadChip) {
  return hadChip ? pixelWidth < CHIP_HIDE_PX : pixelWidth < CHIP_SHOW_PX;
}
