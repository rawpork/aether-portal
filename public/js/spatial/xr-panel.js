// The headset dashboard's face (PROJECT_STATE.md, spatial dashboard): layout, drawing and hit-testing of a flat panel
// painted on a 2D canvas, like the card faces. Pure apart from drawing into a given canvas context, so the layout and
// hit tests run in unit tests. xr-dashboard.js puts the canvas on a mesh on the wrist or pinned in front of the user.
//
// Panel coordinates are canvas pixels, origin top-left. A ray hit gives the mesh's uv (origin bottom-left).

export const PANEL_WIDTH = 1024;
export const PANEL_HEIGHT = 700;
// Physical size in the headset (metres). Buttons come out at 3-4 cm, easy targets for a controller ray.
export const PANEL_METRES_WIDE = 0.3;

const PAD = 28;
const GAP = 12;
const LABEL_WIDTH = 150;
const ROW_HEIGHT = 84;
const ROW_GAP = 22;

export const PANEL_VIEWS = [
  ['space', 'Space'],
  ['groups', 'Groups'],
  ['status', 'Status'],
  ['map', 'Map'],
  ['timeline', 'Timeline'],
  ['gallery', 'Gallery']
];
export const PANEL_DEPTHS = [['obvious', 'Obvious'], ['logical', 'Logical'], ['abstract', 'Abstract']];
export const PANEL_PLATFORMS = [
  ['all', 'All'],
  ['youtube', 'YouTube'],
  ['x', 'X'],
  ['facebook', 'Facebook'],
  ['links', 'Links'],
  ['notes', 'Notes'],
  ['images', 'Images']
];

// One row of equal buttons after a row label.
function row(items, y, label, activeId, prefix) {
  const left = PAD + LABEL_WIDTH;
  const width = PANEL_WIDTH - PAD - left;
  const each = (width - GAP * (items.length - 1)) / items.length;
  return {
    label: { text: label, x: PAD, y: y + ROW_HEIGHT / 2 },
    buttons: items.map(([id, text], i) => ({
      id: prefix + id,
      label: text,
      x: left + i * (each + GAP),
      y,
      w: each,
      h: ROW_HEIGHT,
      active: id === activeId
    }))
  };
}

// state: { view, scopeLabel, depth, platform, passthrough (true | false | null when not in mixed reality), pinned }.
// Returns { rows: [{ label, buttons }], buttons: flat list, text: extra text items }.
export function layoutPanel(state = {}) {
  const rows = [];
  let y = PAD + 56;
  rows.push(row(PANEL_VIEWS, y, 'VIEW', state.view, 'view:'));
  y += ROW_HEIGHT + ROW_GAP;
  // Time span: a stepper with the current span between its buttons.
  const left = PAD + LABEL_WIDTH;
  const stepWidth = 120;
  rows.push({
    label: { text: 'TIME', x: PAD, y: y + ROW_HEIGHT / 2 },
    buttons: [
      { id: 'scope:narrow', label: '−', x: left, y, w: stepWidth, h: ROW_HEIGHT, active: false },
      { id: 'scope:widen', label: '+', x: PANEL_WIDTH - PAD - stepWidth, y, w: stepWidth, h: ROW_HEIGHT, active: false }
    ],
    center: { text: state.scopeLabel || '', x: (left + stepWidth + PANEL_WIDTH - PAD - stepWidth) / 2, y: y + ROW_HEIGHT / 2 }
  });
  y += ROW_HEIGHT + ROW_GAP;
  rows.push(row(PANEL_DEPTHS, y, 'DEPTH', state.depth, 'depth:'));
  y += ROW_HEIGHT + ROW_GAP;
  rows.push(row(PANEL_PLATFORMS, y, 'SHOW', state.platform || 'all', 'platform:'));
  y += ROW_HEIGHT + ROW_GAP;
  const actions = [
    ['back', 'Back'],
    ['recenter', 'Recenter'],
    ['zoom-out', 'Zoom −'],
    ['zoom-in', 'Zoom +'],
    ...(state.passthrough === null || state.passthrough === undefined ? [] : [['passthrough', state.passthrough ? 'Room on' : 'Room off']]),
    ['pin', state.pinned ? 'Unpin' : 'Pin'],
    ['exit', 'Exit']
  ];
  const actionRow = row(actions, y, '', null, '');
  // Actions use the full width (no row label).
  const each = (PANEL_WIDTH - PAD * 2 - GAP * (actions.length - 1)) / actions.length;
  actionRow.buttons.forEach((button, i) => {
    button.x = PAD + i * (each + GAP);
    button.w = each;
    button.active = button.id === 'passthrough' ? Boolean(state.passthrough) : button.id === 'pin' ? Boolean(state.pinned) : false;
  });
  rows.push(actionRow);
  return { rows, buttons: rows.flatMap(r => r.buttons) };
}

// The button under a hit at uv (u, v in 0-1, v up), or null.
export function hitTest(layout, u, v) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  const x = u * PANEL_WIDTH;
  const y = (1 - v) * PANEL_HEIGHT;
  const button = layout.buttons.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  return button ? button.id : null;
}

const COLORS = {
  panel: '#0b1320',
  border: 'rgba(0,255,204,0.35)',
  raised: '#152032',
  hover: '#1f3148',
  activeFill: '#0f3b3a',
  accent: '#00ffcc',
  text: '#dffdf7',
  muted: '#8a93a6',
  danger: '#ff8f8f'
};
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Paints the panel. hoverId highlights the button a ray is on.
export function drawPanel(ctx, layout, state = {}, hoverId = null) {
  ctx.clearRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
  roundRect(ctx, 2, 2, PANEL_WIDTH - 4, PANEL_HEIGHT - 4, 24);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.border;
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = '700 34px ' + FONT;
  ctx.fillStyle = COLORS.accent;
  ctx.fillText('Aether', PAD, PAD + 22);
  ctx.font = '400 24px ' + FONT;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'right';
  ctx.fillText(state.pinned ? 'Pinned' : 'Press X to hide', PANEL_WIDTH - PAD, PAD + 22);

  layout.rows.forEach(r => {
    if (r.label && r.label.text) {
      ctx.textAlign = 'left';
      ctx.font = '700 22px ' + FONT;
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(r.label.text, r.label.x, r.label.y);
    }
    if (r.center) {
      ctx.textAlign = 'center';
      ctx.font = '600 30px ' + FONT;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(r.center.text, r.center.x, r.center.y);
    }
    r.buttons.forEach(button => {
      roundRect(ctx, button.x, button.y, button.w, button.h, 14);
      ctx.fillStyle = button.active ? COLORS.activeFill : button.id === hoverId ? COLORS.hover : COLORS.raised;
      ctx.fill();
      ctx.lineWidth = button.active || button.id === hoverId ? 3 : 1.5;
      ctx.strokeStyle = button.active || button.id === hoverId ? COLORS.accent : 'rgba(255,255,255,0.12)';
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = (button.active ? '700 ' : '600 ') + (button.label.length > 8 ? 24 : 28) + 'px ' + FONT;
      ctx.fillStyle = button.id === 'exit' ? COLORS.danger : button.active ? COLORS.accent : COLORS.text;
      ctx.fillText(button.label, button.x + button.w / 2, button.y + button.h / 2);
    });
  });
}
