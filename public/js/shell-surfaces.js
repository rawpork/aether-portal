// The two Aether surfaces, defined once. Space (the 3D graph at "/") and Mission Control ("/mission-control") are separate
// pages, but they share one navigation: the same two-item switch sits in the same header slot on both, the page you are on
// is marked aria-current="page", and the same shortcuts and arrival announcement work from either side.
//
// The Worker renders the switch into both page templates (src/index.js, src/mission-control-page.js); public/js/shell-keys.js
// reads SURFACES in the browser. No dependencies, so both sides can import it.

export const SURFACES = [
  { id: 'space', href: '/', label: 'Space', title: 'Space: the 3D graph', shortcut: 'Alt+S', code: 'KeyS' },
  { id: 'mission-control', href: '/mission-control', label: 'Mission Control', title: 'Mission Control: agents, tasks and the safety cutoff', shortcut: 'Alt+M', code: 'KeyM' },
];

const ICONS = {
  space: '<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)"/>',
  'mission-control': '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
};

// The switch for `current` ('space' | 'mission-control'). Both items are always in the markup, so the header never changes
// shape between pages; on phones the current item is hidden (the page title already says where you are).
export function renderSurfaceSwitch(current) {
  const items = SURFACES.map((s) => {
    const here = s.id === current;
    return (
      '<a class="shell-item" data-surface="' + s.id + '" href="' + s.href + '"' +
      (here ? ' aria-current="page"' : '') +
      ' aria-label="' + s.label + '" aria-keyshortcuts="' + s.shortcut + '" title="' + s.title + ' (' + s.shortcut + ')">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' + ICONS[s.id] + '</svg>' +
      '<span class="shell-label">' + s.label + '</span></a>'
    );
  });
  return '<nav class="shell-switch" aria-label="Aether">' + items.join('') + '</nav>';
}

// Structure and motion for the switch. Each page sets the --shell-* variables to match its own look (see the page templates).
export const SHELL_SWITCH_CSS = `
    .shell-switch { flex: none; display: inline-flex; align-items: center; gap: 6px; view-transition-name: shell-switch; }
    .shell-item { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; min-width: var(--shell-h, 44px); height: var(--shell-h, 44px); padding: 0 12px; border: 1px solid var(--shell-line); border-radius: var(--shell-radius); background: var(--shell-bg); color: var(--shell-fg); font: inherit; font-size: var(--shell-font, 14px); font-weight: 600; text-decoration: none; white-space: nowrap; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .shell-item::after { content: ""; position: absolute; inset: min(0px, calc((var(--shell-h, 44px) - 44px) / 2 - 1px)) 0; }
    .shell-item svg { flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .shell-item[aria-current="page"] { border-color: var(--shell-active-line); background: var(--shell-active-bg); color: var(--shell-active-fg); cursor: default; }
    .shell-item:not([aria-current]):hover { border-color: var(--shell-active-line); color: var(--shell-active-fg); }
    .shell-item:not([aria-current]):active { transform: scale(0.98); }
    @media (max-width: 767.98px) {
      .shell-item { padding: 0; width: var(--shell-h, 44px); }
      .shell-item::after { inset: min(0px, calc((var(--shell-h, 44px) - 44px) / 2 - 1px)); }
      .shell-label { display: none; }
    }
    /* Moving between the two pages cross-fades instead of flashing, and the switch itself glides to its place on the other page. */
    @view-transition { navigation: auto; }
    @media (prefers-reduced-motion: reduce) {
      ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
    }
`;
