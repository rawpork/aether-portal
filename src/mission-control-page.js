// /mission-control: the one place the portal talks to the local Aether_Engine. Laid out per DESIGN_SYSTEM.md and the
// Figma references in images/: a dark sidebar rail switches between the overview (operations summary, agent workforce
// cards with per-agent breakers, the selected agent's detail panel), Elarion's chat and voice dock, Projects
// (blueprint ingestion and the artifact dashboard), Run history (the task loop monitor) and Settings (engine
// connection). The master breaker sits in the canvas header. All behaviour lives in public/js/engine/mission-control.js;
// this template is markup and styles only, so it carries no inline script (and, being a template literal, avoids
// backslashes). The user's name, tier and the optional upgrade URL reach the script as meta tags.

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const icon = (paths, extra = '') =>
	'<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
	extra +
	'>' +
	paths +
	'</svg>';

const ICONS = {
	grid: icon('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
	pulse: icon('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'),
	layers: icon('<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
	flag: icon('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
	clock: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
	mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
	menu: icon('<path d="M4 7h16M4 12h16M4 17h16"/>'),
	console: icon('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15H17"/>'),
	nodes: icon('<rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="3" y="15" width="6" height="5" rx="1.5"/><rect x="15" y="9.5" width="6" height="5" rx="1.5"/><path d="M9 6.5c3 0 3 5.5 6 5.5M9 17.5c3 0 3-5.5 6-5.5"/>'),
	back: icon('<path d="M10 6 4 12l6 6"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>'),
	space: icon('<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)"/>'),
	home: icon('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>'),
	gear: icon('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>'),
	plus: icon('<path d="M12 5v14M5 12h14"/>', ' stroke-width="2.2"'),
	engine: icon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M9 1.5V4M15 1.5V4M9 20v2.5M15 20v2.5M1.5 9H4M1.5 15H4M20 9h2.5M20 15h2.5"/>'),
	theme: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>'),
	star: '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2.5c.7 5 2.5 6.8 7.5 7.5-5 .7-6.8 2.5-7.5 7.5-.7-5-2.5-6.8-7.5-7.5 5-.7 6.8-2.5 7.5-7.5z"/></svg>',
};

export function initialsOf(name) {
	const parts = String(name || '')
		.replace(/[._-]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!parts.length) return 'A';
	return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// 'light' / 'dark' from ?theme= or the aether_theme cookie (UNIFIED_BRAND.md); anything else follows the system.
export const parseTheme = (value) => (value === 'light' || value === 'dark' ? value : '');

export function renderMissionControlPage({ assetVersion = 'dev', tier = 'free', upgradeUrl = '', userName = '', role = '', theme = '', enginePublicUrl = '' } = {}) {
	const v = encodeURIComponent(assetVersion);
	const safeUpgradeUrl = /^https:[/][/]/i.test(upgradeUrl) ? upgradeUrl : '';
	const displayName = userName ? userName.charAt(0).toUpperCase() + userName.slice(1) : '';
	return `<!DOCTYPE html>
<html lang="en"${parseTheme(theme) ? ' data-theme="' + parseTheme(theme) + '"' : ''}>
<head>
  <meta charset="utf-8">
  <title>Mission Control - Aether Portal</title>
  <!-- Same viewport as the main portal page (no cover fit): iOS then keeps the page below the status bar, also in
       the home-screen app with the translucent status bar, so the header never sits under the clock. -->
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#18181B">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <meta name="aether-version" content="${escapeAttr(assetVersion)}">
  <meta name="aether-tier" content="${escapeAttr(tier)}">
  <meta name="aether-upgrade-url" content="${escapeAttr(safeUpgradeUrl)}">
  <meta name="aether-user" content="${escapeAttr(displayName)}">
  <meta name="aether-engine-relay" content="${enginePublicUrl ? '1' : ''}">
  <meta name="aether-engine-public" content="${escapeAttr(enginePublicUrl)}">
  <style>
    /* One visual system with the portal and the 3D viewer (DESIGN.md, System 2: the teal accent hybrid): navy rail,
       solid panels with hairlines, 6 / 8px corners, system fonts, teal only for selection, primary actions and focus.
       The light theme keeps light panels with a deeper teal so text on white stays readable. Red stays reserved for
       breakers. No blur, no glow. */
    :root {
      --rail: #0b1320;
      --rail-raised: rgba(255,255,255,0.06);
      --rail-line: rgba(255,255,255,0.10);
      --rail-text: #8a93a6;
      --rail-strong: #dffdf7;
      --canvas: #F4F5F7;
      --surface: #FFFFFF;
      --surface-soft: #F8FAFC;
      --line: #E4E4E7;
      --line-strong: #D4D4D8;
      --text: #18181B;
      --text-2: #3F3F46;
      --muted: #71717A;
      --faint: #A1A1AA;
      --accent: #00796B;
      --accent-soft: #E3F6F2;
      --accent-line: #7FCFC0;
      --on-accent: #FFFFFF;
      --lime: #00ffcc;
      --on-lime: #041016;
      --ok-bg: #DCFCE7; --ok: #15803D; --ok-dot: #22C55E;
      --alert-bg: #FFEDD5; --alert: #C2410C; --alert-dot: #F97316;
      --queued-bg: #F4F4F5; --queued: #52525B; --queued-dot: #71717A;
      --off-bg: #FEE2E2; --off: #991B1B; --off-dot: #EF4444;
      --switch-on: #1F5A43;
      --danger: #DC2626;
      --danger-soft: #FEF6F6;
      --terminal: #1B201D;
      --terminal-text: #D7E8DE;
      --radius-s: 6px;
      --radius-m: 8px;
      --radius-l: 8px;
      --shadow: 0 1px 2px rgba(24,24,27,0.04);
      --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif;
      --rail-edge: transparent;
      --ink: #18181B; --on-ink: #FFFFFF; --ink-hover: #2E2E33;
      --accent-tint: #CDEFE8;
      --ok-strong: #14532D;
      --alert-soft: #FFF7ED; --alert-line: #FED7AA;
      --danger-line: #F3B4B4;
      --danger-text: #B91C1C;
      /* Data-flow colours (specs/ui/README.md): data, not accents. The Studio canvas draws bridges in --flow-mcp. */
      --flow-mcp: #16A34A; --flow-a2a: #2563EB; --flow-action: #EA580C;
      color-scheme: light;
    }
    /* Dark theme (UNIFIED_BRAND.md, identical to the Engine status page): data-theme="dark", or the system setting
       unless the user picked light. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --rail: #060a11;
        --rail-edge: rgba(255,255,255,0.08);
        --canvas: #080c14;
        --surface: #0b1320;
        --surface-soft: #0f1928;
        --line: rgba(255,255,255,0.08);
        --line-strong: rgba(255,255,255,0.14);
        --text: #dffdf7;
        --text-2: #c2d3cf;
        --muted: #8a93a6;
        --faint: #5f6879;
        --ink: #dffdf7; --on-ink: #080c14; --ink-hover: #b9f7ea;
        --accent: #00ffcc;
        --on-accent: #041016;
        --accent-soft: rgba(0,255,204,0.14);
        --accent-line: rgba(0,255,204,0.55);
        --accent-tint: rgba(0,255,204,0.22);
        --ok-bg: #052E16; --ok: #86EFAC; --ok-strong: #BBF7D0;
        --alert-bg: #451A03; --alert: #FDBA74; --alert-soft: #2A1606; --alert-line: #7C2D12;
        --queued-bg: #27272A; --queued: #D4D4D8;
        --off-bg: #450A0A; --off: #FCA5A5;
        --switch-on: #2F855A;
        --danger: #EF4444;
        --danger-soft: #1F0F0F;
        --danger-line: #7F1D1D;
        --danger-text: #FCA5A5;
        --terminal: #05080e;
        --shadow: none;
        --flow-mcp: #4ADE80; --flow-a2a: #60A5FA; --flow-action: #FB923C;
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --rail: #060a11;
      --rail-edge: rgba(255,255,255,0.08);
      --canvas: #080c14;
      --surface: #0b1320;
      --surface-soft: #0f1928;
      --line: rgba(255,255,255,0.08);
      --line-strong: rgba(255,255,255,0.14);
      --text: #dffdf7;
      --text-2: #c2d3cf;
      --muted: #8a93a6;
      --faint: #5f6879;
      --ink: #dffdf7; --on-ink: #080c14; --ink-hover: #b9f7ea;
      --accent: #00ffcc;
      --on-accent: #041016;
      --accent-soft: rgba(0,255,204,0.14);
      --accent-line: rgba(0,255,204,0.55);
      --accent-tint: rgba(0,255,204,0.22);
      --ok-bg: #052E16; --ok: #86EFAC; --ok-strong: #BBF7D0;
      --alert-bg: #451A03; --alert: #FDBA74; --alert-soft: #2A1606; --alert-line: #7C2D12;
      --queued-bg: #27272A; --queued: #D4D4D8;
      --off-bg: #450A0A; --off: #FCA5A5;
      --switch-on: #2F855A;
      --danger: #EF4444;
      --danger-soft: #1F0F0F;
      --danger-line: #7F1D1D;
      --danger-text: #FCA5A5;
      --terminal: #05080e;
      --shadow: none;
      --flow-mcp: #4ADE80; --flow-a2a: #60A5FA; --flow-action: #FB923C;
    }
    * { box-sizing: border-box; }
    /* Author display rules (flex rows, buttons) would otherwise override the hidden attribute. */
    [hidden] { display: none !important; }
    /* The document never scrolls (like the main portal page): only the canvas below the header does. In the iOS
       home-screen app the status bar is see-through, and a scrolling document would slide under the clock. */
    html { height: 100%; background: var(--rail); }
    body { height: 100%; margin: 0; display: flex; overflow: hidden; background: var(--canvas); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.4; -webkit-font-smoothing: antialiased; }
    button { font: inherit; color: inherit; }
    a { color: inherit; }
    h1, h2, h3, p { margin: 0; }
    .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .ico { flex: none; display: block; }
    .mc-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* ---------- Sidebar rail */
    .mc-rail { flex: none; width: 248px; display: flex; flex-direction: column; gap: 6px; padding: calc(24px + env(safe-area-inset-top, 0px)) 14px calc(14px + env(safe-area-inset-bottom, 0px)) calc(14px + env(safe-area-inset-left, 0px)); background: var(--rail); color: var(--rail-text); border-right: 1px solid var(--rail-edge); overflow-y: auto; }
    .rail-brand { display: flex; align-items: center; gap: 12px; padding: 0 10px 22px; color: var(--rail-strong); font-weight: 800; letter-spacing: 0.14em; font-size: 15px; text-decoration: none; }
    .rail-logo { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: var(--radius-m); background: var(--lime); color: var(--on-lime); }
    .rail-nav { display: flex; flex-direction: column; gap: 4px; }
    .rail-item { appearance: none; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0 14px; border: 1px solid transparent; border-radius: var(--radius-m); background: none; color: var(--rail-text); font-size: 15px; font-weight: 500; text-align: left; text-decoration: none; cursor: pointer; }
    .rail-item:hover { color: var(--rail-strong); background: rgba(255,255,255,0.04); }
    .rail-item[aria-current="page"] { color: var(--rail-strong); font-weight: 600; background: var(--rail-raised); border-color: var(--rail-line); }
    .rail-label { flex: 1; min-width: 0; }
    .rail-count { min-width: 24px; height: 24px; padding: 0 7px; border-radius: 12px; background: var(--rail-raised); color: var(--rail-text); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }
    .rail-item[aria-current="page"] .rail-count { background: var(--rail-line); }
    .rail-spacer { flex: 1; min-height: 16px; }
    .rail-compute { margin: 0 2px 10px; padding: 16px; border: 1px solid var(--rail-line); border-radius: var(--radius-l); }
    .rail-compute-head { display: flex; justify-content: space-between; align-items: baseline; color: var(--rail-strong); }
    .rail-compute-head strong { font-weight: 700; }
    .rail-compute-bar { height: 5px; margin: 12px 0 10px; border-radius: 3px; background: var(--rail-line); overflow: hidden; }
    .rail-compute-bar span { display: block; height: 100%; width: 0; background: var(--lime); transition: width 0.3s; }
    .rail-compute-sub { font-size: 12px; }
    .rail-user { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding: 16px 8px 4px; border-top: 1px solid var(--rail-line); }
    .rail-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 50%; background: #3B4A40; color: var(--rail-strong); font-weight: 700; font-size: 14px; }
    .rail-user-text { min-width: 0; display: flex; flex-direction: column; }
    .rail-user-name { color: var(--rail-strong); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-user-role { font-size: 12px; }

    /* ---------- Canvas */
    .mc-canvas { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .mc-top { flex: none; position: sticky; top: 0; z-index: 100; isolation: isolate; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 14px; padding: calc(22px + env(safe-area-inset-top, 0px)) calc(40px + env(safe-area-inset-right, 0px)) 20px 40px; border-bottom: 1px solid var(--line); background: var(--surface); }
    /* The heading keeps at least 220px (or the full row); when the actions don't fit beside it they wrap to a second
       row instead of squeezing the greeting or spilling past the edge. */
    .mc-heading { flex: 1 1 260px; min-width: min(220px, 100%); display: flex; flex-direction: column; gap: 6px; }
    .mc-crumbs { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
    .mc-title { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-greeting { margin: 0; color: var(--muted); font-size: 14px; }
    .mc-greeting:empty, body:not([data-view="overview"]) .mc-greeting { display: none; }
    .mc-actions { flex: 0 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 10px; margin-left: auto; }
    /* Phones and small tablets: the rail's Portal link is hidden there, so the header carries the way back. */
    .menu-toggle { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); color: var(--text); cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .menu-toggle:hover { background: var(--surface-soft); }
    .menu-toggle:active { transform: scale(0.98); }
    .surface-link { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 44px; height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font-size: 14px; font-weight: 600; text-decoration: none; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .surface-link:hover { background: var(--surface-soft); }
    .surface-link:active { transform: scale(0.98); }
    .btn-primary { appearance: none; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px; border: 1px solid var(--ink); border-radius: var(--radius-m); background: var(--ink); color: var(--on-ink); font-weight: 600; white-space: nowrap; cursor: pointer; }
    .btn-primary:hover { background: var(--ink-hover); }
    .mc-main { position: relative; z-index: 0; isolation: isolate; flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 28px calc(40px + env(safe-area-inset-right, 0px)) calc(32px + env(safe-area-inset-bottom, 0px)) 40px; }
    .mc-view { max-width: 1240px; margin: 0 auto; }
    body[data-view="elaron"] .mc-main { display: flex; flex-direction: column; }
    #mc-view-elaron:not([hidden]) { flex: 1; min-height: 460px; width: 100%; display: flex; }

    /* ---------- Shared pieces */
    .surface { border: 1px solid var(--line); border-radius: var(--radius-l); background: var(--surface); box-shadow: var(--shadow); }
    .eyebrow { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
    .eyebrow-accent { color: var(--accent); }
    .mini-label { color: var(--muted); font-size: 11px; }
    .empty { padding: 20px; border: 1px dashed var(--line-strong); border-radius: var(--radius-m); color: var(--muted); font-size: 13px; text-align: center; }
    .empty p + p { margin-top: 6px; }
    .wf-grow { flex: 1; }
    .pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--queued-bg); color: var(--queued); }
    .pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--queued-dot); }
    .pill[data-kind="running"] { background: var(--ok-bg); color: var(--ok); }
    .pill[data-kind="running"] .pill-dot { background: var(--ok-dot); }
    .pill[data-kind="alert"] { background: var(--alert-bg); color: var(--alert); }
    .pill[data-kind="alert"] .pill-dot { background: var(--alert-dot); }
    .pill[data-kind="off"] { background: var(--off-bg); color: var(--off); }
    .pill[data-kind="off"] .pill-dot { background: var(--off-dot); }
    .btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font-weight: 600; white-space: nowrap; cursor: pointer; }
    .btn:hover:not(:disabled) { background: var(--surface-soft); }
    .btn:disabled { opacity: 0.5; cursor: progress; }
    .btn-small { height: 32px; padding: 0 12px; font-size: 12px; border-radius: 10px; }
    .btn-ghost { border-color: var(--line); }
    .btn-icon { font-size: 10px; letter-spacing: -1px; }
    .icon-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); color: var(--muted); font-size: 18px; cursor: pointer; }
    .icon-btn:hover { color: var(--text); }
    /* Switches: dark green when on, red when a breaker is off. */
    .switch { appearance: none; position: relative; flex: none; width: 34px; height: 20px; padding: 0; border: none; border-radius: 10px; background: var(--off-dot); cursor: pointer; transition: background 0.15s; }
    .switch[aria-checked="true"] { background: var(--switch-on); }
    .switch-knob { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
    .switch[aria-checked="true"] .switch-knob { transform: translateX(14px); }
    .switch:disabled { cursor: default; opacity: 0.9; }
    .switch:disabled:not([aria-checked="true"]) { background: var(--line-strong); }
    .switch-row { display: inline-flex; align-items: center; gap: 8px; }
    .switch-text { font-size: 12px; color: var(--switch-on); font-weight: 600; min-width: 20px; }
    .avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; color: var(--on-accent); font-weight: 700; font-size: 14px; background: var(--accent); }
    .avatar-lg { width: 54px; height: 54px; border-radius: 13px; font-size: 18px; }
    [data-tone="violet"] { --tone: #7C5CFC; }
    [data-tone="blue"] { --tone: #3B7DDD; }
    [data-tone="amber"] { --tone: #D9822B; }
    [data-tone="teal"] { --tone: #0F9488; }
    [data-tone="rose"] { --tone: #E25563; }
    [data-tone="slate"] { --tone: #7C8784; }
    .avatar[data-tone] { background: var(--tone); }

    /* ---------- Overview */
    #mc-workforce { display: flex; flex-direction: column; gap: 20px; }
    .wf-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 16px; border: 1px solid var(--alert-line); border-radius: var(--radius-m); background: var(--alert-soft); color: var(--alert); font-size: 13px; }
    /* Decision center (decision-center.js): the banner slot on every view and the numbered choice popups. */
    #mc-next { max-width: 1240px; margin: 0 auto 16px; }
    body[data-view="elaron"] #mc-next { width: 100%; }
    .dc-scrim { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: rgba(4, 8, 14, 0.62); }
    .dc-modal { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 20px; border: 1px solid var(--line-strong); border-radius: var(--radius-l); background: var(--surface); color: var(--text); }
    .dc-modal[data-kind="alert"], .dc-modal[data-kind="go"] { border-color: var(--accent-line); }
    .dc-modal[data-kind="warn"] { border-color: var(--danger-line); }
    .dc-title { margin: 0 0 8px; font-size: 18px; }
    .dc-body { margin: 0 0 14px; color: var(--text-2); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
    .dc-working::after { content: " …"; }
    .dc-options { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .dc-option { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .dc-option:hover, .dc-option:focus-visible { border-color: var(--accent); outline: none; }
    .dc-num { flex: none; display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-s); background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 13px; }
    .dc-option-text { display: flex; flex-direction: column; min-width: 0; }
    .dc-option-label { font-size: 14px; font-weight: 600; }
    .dc-option-hint { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .dc-keys { margin: 12px 0 0; color: var(--muted); font-size: 12px; }
    .dc-preview { margin: 0 0 12px; padding: 10px 12px; max-height: 40vh; overflow: auto; border-radius: var(--radius-s); background: var(--surface-soft); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .dc-editor { width: 100%; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--surface-soft); color: var(--text); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize: vertical; }
    .dc-warn { margin: 0 0 12px; color: var(--off); font-size: 13px; }
    .dc-steps { margin: 0 0 14px; padding-left: 20px; color: var(--text-2); font-size: 14px; line-height: 1.5; }
    .dc-steps li { margin-bottom: 6px; }
    .oc-build { margin: 8px 0; display: flex; flex-direction: column; gap: 4px; }
    .oc-build-line { margin: 0; font-size: 13px; font-weight: 600; color: var(--ok); }
    .oc-build[data-status="failed"] .oc-build-line { color: var(--danger-text); }
    .oc-build[data-status="skipped"] .oc-build-line { color: var(--muted); font-weight: 500; }
    .oc-build p.mc-muted { margin: 0; font-size: 12px; }
    /* "Do this next" (workforce.js nextAction) and the live pulse card. */
    .wf-next { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-bottom: 16px; padding: 16px 20px; border: 1px solid var(--accent-line); border-left: 4px solid var(--accent); border-radius: var(--radius-m); background: var(--surface); }
    .wf-next[data-kind="warn"] { border-color: var(--alert-line); border-left-color: var(--alert); }
    .wf-next[data-kind="alert"] { border-left-color: var(--alert); }
    .wf-next-text { flex: 1 1 320px; min-width: 0; }
    .wf-next-text .eyebrow { margin: 0 0 2px; }
    .wf-next-title { margin: 0; font-size: 17px; font-weight: 600; }
    .wf-next-sub { margin: 4px 0 0; color: var(--text-2); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .wf-next-go { flex: none; }
    .pulse { margin: 4px 0 18px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .pulse[data-state="working"], .pulse[data-state="waiting"] { border-color: var(--accent-line); }
    .pulse[data-state="failed"], .pulse[data-state="halted"] { border-color: var(--danger-line); }
    .pulse .eyebrow { margin: 0; }
    .pulse-step { margin: 4px 0 2px; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
    .pulse-since { margin: 0 0 8px; color: var(--muted); font-size: 12px; }
    .pulse-error { margin: 6px 0; color: var(--off); font-size: 13px; overflow-wrap: anywhere; }
    .pulse-bar { height: 4px; margin: 8px 0 10px; border-radius: 999px; background: var(--line); overflow: hidden; }
    .pulse-bar span { display: block; height: 100%; background: var(--accent); }
    .pulse details { margin-top: 8px; }
    .pulse summary, .tl-more summary { cursor: pointer; color: var(--accent); font-size: 12px; font-weight: 600; }
    .pulse-text { margin: 6px 0 0; padding: 10px 12px; max-height: 320px; overflow: auto; border-radius: var(--radius-s); background: var(--surface); color: var(--text-2); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .tl-more { margin-top: 4px; }
    .wf-banner[data-kind="error"] { border-color: var(--danger-line); background: var(--danger-soft); color: var(--off); }
    .wf-overview { padding: 24px 28px 4px; }
    .wf-overview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
    .wf-project-name { margin-top: 10px; font-size: 21px; font-weight: 500; }
    .wf-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .metric { display: flex; flex-direction: column; gap: 14px; padding: 22px 24px 22px 0; }
    .metric + .metric { padding-left: 24px; border-left: 1px solid var(--line); }
    .metric-label { color: var(--text-2); font-size: 13px; }
    .metric-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .metric-value { font-size: 25px; font-weight: 500; font-variant-numeric: tabular-nums; }
    .metric[data-key="eta"] .metric-value { letter-spacing: 0.04em; }
    .metric-sub { color: var(--muted); font-size: 12px; text-align: right; }
    .wf-split { display: grid; grid-template-columns: minmax(330px, 388px) minmax(0, 1fr); gap: 20px; align-items: start; }
    .wf-workforce { padding: 20px 14px 14px; }
    .wf-section-head { display: flex; align-items: center; gap: 10px; padding: 0 10px 16px; }
    .wf-section-head h2 { font-size: 16px; font-weight: 600; }
    .wf-count { color: var(--muted); font-size: 12px; }
    .wf-cards { display: flex; flex-direction: column; gap: 10px; }
    .agent-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid transparent; border-radius: var(--radius-m); background: #F6F6F4; cursor: pointer; }
    .agent-card:hover { border-color: var(--line); }
    .agent-card[data-selected="true"] { background: var(--surface); border-color: var(--accent-line); box-shadow: inset 3px 0 0 var(--accent), 0 1px 3px rgba(124,92,252,0.08); }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-select { appearance: none; flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 0; border: none; background: none; text-align: left; cursor: pointer; }
    .card-title { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .card-name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-code { color: var(--faint); font-size: 12px; }
    .card-head .btn-small { height: 28px; padding: 0 10px; }
    .card-objective { color: var(--text-2); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card-progress { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
    .bar { grid-column: 1 / -1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 2px; background: var(--tone, var(--accent)); transition: width 0.3s; }
    .card-foot { display: flex; align-items: flex-end; gap: 30px; }
    .foot-cell { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
    .foot-breaker { align-items: flex-end; }

    /* Detail panel */
    .wf-detail { position: sticky; top: 0; overflow: hidden; }
    .detail-head { display: flex; align-items: center; gap: 16px; padding: 26px 28px 18px; }
    .detail-title { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .detail-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .detail-name-row h2 { font-size: 21px; font-weight: 500; }
    .detail-sub { color: var(--muted); font-size: 12px; }
    .objective { display: flex; gap: 16px; margin: 0 28px; padding: 18px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); background: var(--accent-soft); }
    .objective-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 9px; background: var(--accent-tint); color: var(--accent); font-family: var(--mono); font-size: 12px; font-weight: 700; }
    .objective-title { margin-top: 6px; font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
    .objective-text { margin-top: 6px; color: var(--text-2); font-size: 12.5px; overflow-wrap: anywhere; }
    .detail-stats { display: flex; align-items: center; gap: 0; margin: 20px 28px 10px; }
    .dstat { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 14px; }
    .dstat + .dstat { padding-left: 14px; border-left: 1px solid var(--line); }
    .dstat-value { font-size: 14px; font-weight: 600; }
    .btn-pause { height: 42px; }
    .subtabs { display: flex; gap: 6px; margin-top: 14px; padding: 0 28px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
    .subtabs [role="tab"] { appearance: none; flex: none; display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 4px; margin-right: 16px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer; }
    .subtabs [role="tab"][aria-selected="true"] { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
    .tab-count { min-width: 22px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--queued-bg); color: var(--muted); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
    .pane { padding: 20px 28px 24px; min-height: 220px; }
    .pane-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; }
    .pane-head h3 { font-size: 14px; font-weight: 600; }
    .live-note { display: inline-flex; align-items: center; gap: 6px; color: var(--ok); font-size: 11px; }
    .live-note .pill-dot { width: 8px; height: 8px; background: var(--ok-dot); box-shadow: 0 0 0 3px var(--ok-bg); }
    .timeline { margin: 0; padding: 0; list-style: none; }
    .tl-item { position: relative; display: grid; grid-template-columns: 24px 72px minmax(0, 1fr); gap: 10px; padding-bottom: 18px; }
    .tl-item:not(:last-child)::before { content: ""; position: absolute; left: 11px; top: 26px; bottom: 0; width: 1px; background: var(--line-strong); }
    .tl-mark { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--ok-bg); color: var(--ok); font-size: 12px; font-weight: 700; }
    .tl-item[data-kind="spark"] .tl-mark { background: var(--accent-soft); color: var(--accent); }
    .tl-item[data-kind="bad"] .tl-mark { background: var(--off-bg); color: var(--off); }
    .tl-time { padding-top: 5px; color: var(--muted); font-size: 11px; }
    .tl-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 3px; }
    .tl-title { font-weight: 600; font-size: 13px; }
    .tl-detail { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .checklist { margin: 0; padding: 0; list-style: none; }
    .check-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto; align-items: center; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .check-mark { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-strong); color: #fff; font-size: 11px; font-weight: 700; }
    .check-row[data-state="complete"] .check-mark { border-color: var(--switch-on); background: var(--switch-on); }
    .check-row[data-state="running"] .check-mark { border-color: var(--accent); box-shadow: inset 0 0 0 4px var(--surface); background: var(--accent); }
    .check-row[data-state="tripped"], .check-row[data-state="failed"] { background: var(--danger-soft); border-radius: var(--radius-s); }
    .check-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .check-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check-sub { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check-label { color: var(--muted); font-size: 11.5px; text-align: right; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check-row[data-state="tripped"] .check-label, .check-row[data-state="failed"] .check-label { color: var(--danger-text); font-weight: 600; }
    .check-row[data-state="running"] .check-label { color: var(--accent); font-weight: 600; }
    .terminal { border-radius: var(--radius-m); background: var(--terminal); color: var(--terminal-text); overflow: hidden; }
    .terminal-head { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); color: #9AA7A0; font-family: var(--mono); font-size: 11.5px; }
    .terminal-body { margin: 0; padding: 16px; max-height: 360px; overflow: auto; font-family: var(--mono); font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    .skills { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .skill details { border: 1px solid var(--line); border-radius: var(--radius-m); }
    .skill summary { display: flex; gap: 12px; padding: 12px 14px; cursor: pointer; list-style: none; }
    .skill summary::-webkit-details-marker { display: none; }
    .skill-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    .skill-text { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .skill-name { font-weight: 600; font-size: 13px; }
    .skill-desc { color: var(--text-2); font-size: 12px; }
    .skill-path { color: var(--faint); font-size: 10.5px; overflow-wrap: anywhere; }
    .skill-body { margin: 0; padding: 14px; max-height: 320px; overflow: auto; border-top: 1px solid var(--line); background: var(--surface-soft); font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .bridge-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0 0 16px; font-size: 12.5px; }
    .bridge-facts dt { color: var(--muted); }
    .bridge-facts dd { margin: 0; overflow-wrap: anywhere; }
    .endpoints { margin: 0 0 16px; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: var(--radius-m); }
    .endpoints li { display: grid; grid-template-columns: 52px minmax(0, auto) minmax(0, 1fr); align-items: center; gap: 12px; padding: 9px 12px; font-size: 12px; }
    .endpoints li + li { border-top: 1px solid var(--line); }
    .endpoints code { overflow-wrap: anywhere; font-size: 11.5px; }
    .endpoint-what { color: var(--muted); text-align: right; }
    .method { display: inline-flex; justify-content: center; padding: 2px 0; border-radius: 6px; background: var(--ok-bg); color: var(--ok); font-family: var(--mono); font-size: 10.5px; font-weight: 700; }
    .method[data-method="POST"] { background: var(--accent-soft); color: var(--accent); }
    .bridge-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .bridge-results { margin: 0 0 14px; padding: 0; list-style: none; font-family: var(--mono); font-size: 11.5px; }
    .bridge-results li { padding: 4px 0; color: var(--muted); overflow-wrap: anywhere; }
    .bridge-results li[data-ok="true"] { color: var(--ok); }
    .bridge-results li[data-ok="false"] { color: var(--off); }
    .emergency { display: flex; align-items: center; gap: 16px; padding: 20px 28px; border-top: 1px solid var(--danger-line); background: var(--danger-soft); }
    .emergency-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; background: var(--off-bg); }
    .emergency-icon span { width: 12px; height: 12px; border: 1.8px solid var(--danger); border-radius: 2px; }
    .emergency-text { flex: 1; min-width: 0; }
    .emergency-title { font-weight: 600; font-size: 13px; }
    .emergency-sub { margin-top: 4px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .btn-danger { gap: 10px; height: 42px; border-color: var(--danger-line); color: var(--danger-text); background: var(--surface); }
    .btn-danger .switch { background: var(--off-dot); pointer-events: none; }
    .btn-danger[aria-checked="true"] .switch { background: var(--line-strong); }
    .btn-danger .switch .switch-knob { transform: translateX(14px); }
    .btn-danger[aria-checked="true"] .switch .switch-knob { transform: none; }

    /* ---------- Master breaker in the header (public/js/engine/breaker-bar.js). HALTED pulses, static under reduced motion. */
    .mc-breaker { display: flex; flex: none; align-items: center; gap: 8px; }
    .engine-badge { appearance: none; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; white-space: nowrap; cursor: pointer; }
    .engine-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
    .engine-badge[data-state="ACTIVE"] { color: var(--ok); }
    .engine-badge[data-state="HALTED"] { color: #fff; border-color: var(--danger); background: var(--danger); animation: engine-pulse 1.1s ease-in-out infinite; }
    .engine-badge[data-state="AUTH"], .engine-badge[data-state="ERROR"], .engine-badge[data-state="OFFLINE"] { color: var(--alert); border-color: var(--alert-line); background: var(--alert-soft); }
    @keyframes engine-pulse { 0%, 100% { background-color: #DC2626; } 50% { background-color: #F87171; } }
    .bar-btn { appearance: none; display: inline-flex; align-items: center; height: 42px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; }
    .engine-trip, .engine-trip-confirm { border-color: var(--danger-line); background: var(--surface); color: var(--danger-text); font-weight: 800; letter-spacing: 0.04em; }
    .engine-trip-confirm { border-color: var(--danger); background: var(--danger); color: #fff; }
    .engine-trip:hover:not(:disabled) { background: var(--danger-soft); }
    .engine-trip:disabled { opacity: 0.4; cursor: default; }
    .engine-trip-short { display: none; }
    .engine-reset { border-color: var(--switch-on); background: var(--switch-on); color: #fff; font-weight: 800; letter-spacing: 0.04em; }
    .engine-reset:disabled { opacity: 0.5; cursor: progress; }

    /* ---------- Status pill (public/js/engine/status-pill.js): one worded state in the header, detail and the stop controls in its popover. */
    .mc-status { position: relative; flex: none; }
    .status-pill { appearance: none; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface-soft); color: var(--text); font-size: 14px; font-weight: 700; white-space: nowrap; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .status-pill:active { transform: scale(0.98); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
    .status-pill[data-kind="running"] { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
    .status-pill[data-kind="running"] .status-dot { background: var(--ok-dot); }
    .status-pill[data-kind="alert"] { background: var(--alert-bg); color: var(--alert); border-color: var(--alert-line); }
    .status-pill[data-kind="alert"] .status-dot { background: var(--alert-dot); }
    .status-pill[data-kind="halted"] { background: var(--danger); color: #fff; border-color: var(--danger); animation: engine-pulse 1.1s ease-in-out infinite; }
    .status-pill[data-kind="halted"] .status-dot { background: #fff; }
    .status-panel { position: fixed; z-index: 150; top: var(--status-top, 72px); right: calc(14px + env(safe-area-inset-right, 0px)); width: min(380px, calc(100vw - 28px)); max-height: calc(100vh - var(--status-top, 72px) - 16px); overflow-y: auto; box-sizing: border-box; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); color: var(--text); box-shadow: 0 6px 16px rgba(15, 23, 42, 0.14); }
    .status-panel:focus { outline: none; }
    .status-title { margin: 0 0 12px; font-size: 15px; font-weight: 700; }
    .status-rows { margin: 0 0 16px; }
    .status-row { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 4px 12px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; line-height: 1.45; }
    .status-row:first-child { border-top: 0; padding-top: 0; }
    .status-row dt { color: var(--muted); }
    .status-row dd { margin: 0; overflow-wrap: anywhere; }
    .status-row:has(#mc-ready[hidden]) { display: none; }
    .status-link { appearance: none; min-height: 44px; margin-left: 4px; padding: 0 8px; border: 0; background: none; color: var(--accent); font: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
    .status-panel .mc-breaker { flex-wrap: wrap; }
    .status-panel .mc-breaker .engine-badge { display: none; }
    .status-panel .mc-breaker .bar-btn { min-height: 44px; font-size: 13px; }
    .status-panel .mc-breaker .engine-trip-long { display: inline; }
    .status-panel .mc-breaker .engine-trip-short { display: none; }
    .status-panel .ready-pill { width: auto; height: auto; min-height: 36px; padding: 0 12px; }
    .status-help { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }

    /* Dialogs */
    .modal-backdrop { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(24,24,27,0.45); }
    .modal-backdrop[hidden] { display: none; }
    .modal-panel { width: min(440px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 22px; border: 1px solid var(--line); border-radius: var(--radius-l); background: var(--surface); box-shadow: 0 20px 50px rgba(24,24,27,0.18); }
    .modal-panel h3 { margin: 0 0 2px; font-size: 17px; font-weight: 600; }
    .engine-danger-title { color: var(--danger-text) !important; }
    .engine-modal-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); overflow-wrap: anywhere; }
    .modal-error { margin: 0; min-height: 1em; font-size: 12px; color: var(--danger-text); }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .toggle-button { appearance: none; height: 40px; padding: 0 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font-weight: 600; cursor: pointer; }

    /* ---------- Views hosting the existing modules */
    .mc-panel { display: flex; flex-direction: column; }
    .mc-panel-head { display: flex; align-items: baseline; gap: 12px; padding: 22px 24px 8px; }
    .mc-panel-head h2 { font-size: 17px; font-weight: 600; }
    /* Operator Console (public/js/engine/operator-console.js): activity log beside the choices waiting on you. */
    .oc-panes { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; padding: 8px 24px 24px; }
    .oc-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .oc-pane-title { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
    .oc-count { padding: 1px 7px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: 11px; letter-spacing: 0; }
    .oc-empty { margin: 0; padding: 14px; border: 1px dashed var(--line); border-radius: var(--radius-m); color: var(--muted); font-size: 13px; }
    .oc-log { list-style: none; margin: 0; padding: 10px 12px; height: min(60vh, 560px); overflow-y: auto; border-radius: var(--radius-m); background: var(--terminal); color: var(--terminal-text); font-family: var(--mono); font-size: 12px; line-height: 1.55; }
    .oc-log:empty { display: none; }
    .oc-line { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; overflow-wrap: anywhere; }
    .oc-time { opacity: 0.55; }
    .oc-line[data-kind="done"] .oc-text, .oc-line[data-kind="complete"] .oc-text { color: var(--ok-dot); }
    .oc-line[data-kind="fail"] .oc-text, .oc-line[data-kind="halt"] .oc-text { color: var(--alert-dot); }
    .oc-line[data-kind="ask"] .oc-text, .oc-line[data-kind="answer"] .oc-text { color: var(--accent-line); }
    .oc-prompts { display: flex; flex-direction: column; gap: 12px; outline: none; }
    .oc-prompts:empty { display: none; }
    .oc-prompt { padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); background: var(--accent-soft); }
    .oc-prompt-who { margin: 0 0 4px; font-size: 11px; color: var(--muted); font-family: var(--mono); }
    .oc-prompt-question { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--text); }
    .oc-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .oc-chip { min-height: 40px; padding: 8px 14px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
    .oc-chip:hover:not(:disabled), .oc-chip:focus-visible { border-color: var(--accent); outline: none; }
    .oc-chip:disabled { cursor: default; opacity: 0.55; }
    .oc-chip.chosen { border-color: var(--accent); background: var(--accent); color: var(--on-accent); opacity: 1; }
    .oc-chip-num { font-family: var(--mono); font-weight: 600; }
    .oc-prompt-message { margin: 8px 0 0; min-height: 1em; font-size: 12px; color: var(--muted); }
    .oc-tabs { padding: 0 24px; }
    /* "Ready to run?" preflight (blueprints.js) and Outcomes & Deliverables (outcomes.js). */
    .bp-preflight { flex-direction: column; align-items: stretch; gap: 8px; padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); background: var(--accent-soft); }
    .bp-preflight-title { margin: 0; font-size: 15px; }
    .bp-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .bp-check { display: flex; gap: 8px; align-items: baseline; font-size: 13px; line-height: 1.45; }
    .bp-check-mark { flex: none; width: 16px; font-weight: 700; text-align: center; }
    .bp-check[data-ok="yes"] .bp-check-mark { color: var(--ok); }
    .bp-check[data-ok="no"] .bp-check-mark, .bp-check[data-ok="no"] strong { color: var(--danger-text); }
    .bp-check[data-ok="note"] .bp-check-mark { color: var(--muted); }
    .bp-preflight-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .bp-website { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0 2px; border-top: 1px solid var(--accent-line); font-size: 13px; line-height: 1.45; cursor: pointer; }
    .bp-website-box { flex: none; width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--accent); }
    #mc-outcomes { margin-top: 20px; }
    .oc-outcomes-body { padding: 4px 24px 24px; }
    .oc-runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .oc-run { padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .oc-run-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .oc-run-meta { margin: 4px 0 8px; font-size: 12px; }
    .oc-links { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .oc-link { padding: 4px 10px; border: 1px solid var(--accent-line); border-radius: 999px; color: var(--accent); font-size: 12px; text-decoration: none; }
    .oc-phase { margin: 4px 0; font-size: 13px; }
    .oc-phase summary { cursor: pointer; font-weight: 600; }
    .oc-phase p { margin: 6px 0 0; white-space: pre-wrap; color: var(--text-2); }
    .oc-run-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
    .oc-open-space { text-decoration: none; }
    /* Quick-choice chips (choice-chips.js): numbered options in an agent's question, one tap to answer. */
    .qc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .qc-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; max-width: 100%; padding: 6px 12px; border: 1px solid var(--accent-line); border-radius: 999px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .qc-chip:hover:not(:disabled) { background: var(--accent-soft); }
    .qc-chip:disabled { cursor: default; opacity: 0.55; }
    .qc-chip.chosen { opacity: 1; border-color: var(--accent); background: var(--accent-soft); }
    .qc-chip-num { color: var(--accent); font-weight: 700; }
    /* Claude ⇄ Gemini (dual-agents.js). */
    .da { padding: 4px 24px 24px; }
    .da-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .da-pane { display: flex; flex-direction: column; min-width: 0; height: min(68vh, 680px); border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); transition: border-color 0.3s; }
    .da-pane[data-agent="claude"] { --agent: var(--accent); }
    .da-pane[data-agent="gemini"] { --agent: #ffb627; }
    .da-pane.da-pasted { border-color: var(--agent); }
    .da-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .da-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--agent); }
    .da-role { font-size: 12px; }
    .da-model { margin-left: auto; font-size: 11px; }
    .da-model[data-mismatch="true"] { color: var(--danger-text); }
    .da-feed { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .da-empty, .da-typing { color: var(--muted); font-size: 13px; }
    .da-msg { font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
    .da-msg p { margin: 0 0 6px; white-space: pre-wrap; }
    .da-user { align-self: flex-end; max-width: 85%; padding: 8px 12px; border-radius: var(--radius-m); background: var(--accent-soft); }
    .da-agent, .da-run { padding-left: 10px; border-left: 2px solid var(--agent); }
    .da-run summary { cursor: pointer; font-size: 12px; color: var(--muted); }
    .da-error { color: var(--danger-text); }
    .da-fallback { margin: 4px 0 6px; padding: 6px 10px; border-left: 2px solid #ffb627; border-radius: 0 var(--radius-s) var(--radius-s) 0; background: var(--surface); color: var(--text-2); font-size: 12px; white-space: normal; }
    .da-code { margin: 6px 0; padding: 10px; max-height: 320px; overflow: auto; border-radius: var(--radius-s); background: var(--surface); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
    .da-meta { display: block; font-size: 11px; color: var(--muted); }
    .da-actions { margin-top: 6px; }
    .da-paste { min-height: 32px; font-size: 12px; }
    .da-compose { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
    .da-input { flex: 1; min-width: 0; resize: vertical; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--surface); color: var(--text); font: inherit; font-size: 16px; }
    .da-send { align-self: flex-end; }
    .da-status { min-height: 18px; margin: 10px 0 0; font-size: 12px; }
    .da-relay { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
    .da-relay-label { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
    .da-seg { display: inline-flex; padding: 3px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); }
    .da-seg-btn { appearance: none; min-height: 34px; padding: 0 14px; border: none; border-radius: 999px; background: none; color: var(--muted); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .da-seg-btn[aria-pressed="true"] { background: var(--accent-soft); color: var(--text); box-shadow: inset 0 0 0 1px var(--accent-line); }
    .da-relay-hint { flex: 1 1 240px; font-size: 12px; }
    .da-wrappers { margin-bottom: 12px; font-size: 13px; }
    .da-wrappers summary { cursor: pointer; color: var(--muted); font-weight: 600; }
    .da-wrap-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
    .da-wrap-field { display: flex; flex-direction: column; gap: 4px; }
    .da-wrap-label { font-size: 12px; color: var(--muted); }
    .da-wrap-input { resize: vertical; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--surface); color: var(--text); font: inherit; font-size: 16px; }
    .da-gate { border-left-color: var(--accent); }
    @media (max-width: 760px) { .da { padding: 4px 14px 18px; } .da-grid, .da-wrap-grid { grid-template-columns: 1fr; } .da-pane { height: 62vh; } }
    .tp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
    .tp-card { appearance: none; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; width: 100%; height: 100%; min-height: 150px; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .tp-card:hover, .tp-card:focus-visible { border-color: var(--accent-line); }
    .tp-blank { border-style: dashed; background: none; }
    .tp-name { font-size: 15px; font-weight: 600; }
    .tp-summary { flex: 1; font-size: 13px; line-height: 1.45; color: var(--text-2); }
    .tp-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .tp-status { min-height: 18px; margin: 0; font-size: 12px; }
    .tp-shelf { padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-l); background: var(--accent-soft); }
    .tp-shelf .tp-card { background: var(--surface); }
    .tp-section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 14px; font-weight: 600; }
    .tp-groups { display: flex; flex-direction: column; gap: 10px; }
    .tp-group { border: 1px solid var(--line); border-radius: var(--radius-l); padding: 0 14px; }
    .tp-group summary { min-height: 48px; margin: 0; cursor: pointer; list-style: none; }
    .tp-group summary::-webkit-details-marker { display: none; }
    .tp-group summary::before { content: '▸'; color: var(--muted); transition: transform 0.15s; }
    .tp-group[open] summary::before { transform: rotate(90deg); }
    .tp-group[open] { padding-bottom: 14px; }
    .tp-count { margin-left: auto; min-width: 22px; padding: 1px 7px; border-radius: 999px; background: var(--surface-soft); color: var(--muted); font-size: 12px; text-align: center; }
    .tp-skill { background: var(--accent-soft); color: var(--accent); }
    .tp-brief-category { margin-top: -8px; }
    .tp-brief { display: flex; flex-direction: column; gap: 14px; width: min(620px, 100%); }
    .tp-q { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: none; min-width: 0; }
    .tp-q legend, .tp-q-title { padding: 0; margin-bottom: 6px; font-size: 14px; font-weight: 600; }
    .tp-input { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid var(--line-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--text); font: inherit; font-size: 16px; }
    textarea.tp-input { resize: vertical; }
    .tp-note { margin: 0; font-size: 12px; color: var(--muted); }
    .tp-note[data-ok="no"] { color: var(--danger-text); }
    .tp-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .tp-option { position: relative; display: flex; flex-direction: column; gap: 2px; min-height: 44px; padding: 9px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); cursor: pointer; }
    .tp-option input { position: absolute; opacity: 0; pointer-events: none; }
    .tp-option:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
    .tp-option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
    .tp-option-label { font-size: 14px; font-weight: 600; }
    .tp-option-hint { font-size: 12px; color: var(--muted); }
    .tp-error { margin: 0; color: var(--danger-text); font-size: 13px; }
    @media (max-width: 680px) { .tp-options { grid-template-columns: 1fr; } }
    /* Roadmap (roadmap.js). */
    .rm-body { padding: 4px 24px 24px; }
    .rm-head-actions { display: flex; align-items: center; gap: 10px; }
    .rm-overall { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
    .rm-overall-text { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; }
    .rm-percent { font-size: 28px; }
    .rm-bar { height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
    .rm-bar-fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .rm-sub { margin: 22px 0 8px; font-size: 14px; }
    .rm-goals, .rm-sessions, .rm-memory, .rm-phase-goals { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .rm-goal, .rm-session { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .rm-goal-text, .rm-session-title { font-size: 14px; font-weight: 600; }
    .rm-goal-phase, .rm-session-meta { font-size: 12px; }
    .rm-session[data-active="true"] { border-color: var(--accent-line); }
    .rm-phases { display: flex; flex-direction: column; gap: 6px; }
    .rm-phase summary { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; padding: 8px 0; cursor: pointer; list-style: none; }
    .rm-phase summary .rm-bar { grid-column: 1 / -1; }
    .rm-phase-title { font-size: 13px; font-weight: 600; }
    .rm-phase-count { font-size: 12px; }
    .rm-phase-goals { padding: 4px 0 10px; gap: 4px; font-size: 13px; }
    .rm-phase-goals li { display: flex; gap: 8px; }
    .rm-phase-goals li[data-done="true"] { color: var(--muted); }
    .rm-check { flex: none; width: 14px; color: var(--accent); }
    .rm-memory { font-size: 13px; gap: 4px; }
    .rm-error { color: var(--danger-text); }
    @media (max-width: 680px) { .rm-body { padding: 4px 14px 18px; } }
    .oc-plan ul, .oc-plan ol { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }
    .oc-gaps-title { margin: 10px 0 0; font-size: 13px; font-weight: 600; }
    .oc-finish { margin: 8px 0; font-size: 13px; font-weight: 600; color: var(--ok); }
    .oc-finish[data-ok="false"] { color: var(--danger-text); }
    .oc-files { margin: 8px 0; }
    .oc-files-title { display: block; margin-bottom: 6px; font-size: 13px; }
    .oc-files ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
    .oc-file { padding: 4px 10px; border: 1px solid var(--line); border-radius: var(--radius-s, 6px); background: transparent; color: var(--text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; cursor: pointer; }
    .oc-file:hover { border-color: var(--accent-line); color: var(--accent); }
    .oc-preview { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; }
    .oc-site-confirm { flex-basis: 100%; padding: 12px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); background: var(--accent-soft); }
    .oc-site-confirm p { margin: 0 0 8px; overflow-wrap: anywhere; }
    @media (max-width: 680px) { .oc-outcomes-body { padding: 4px 14px 18px; } }
    /* Agent dialogue (public/js/engine/agent-dialogue.js): one thread per run, a coloured badge per agent. */
    .ad { padding: 8px 24px 24px; }
    .ad-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .ad-picker { min-height: 40px; max-width: 100%; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; }
    .ad-thread { list-style: none; margin: 0; padding: 4px 2px; display: flex; flex-direction: column; gap: 12px; max-height: min(64vh, 640px); overflow-y: auto; }
    .ad-thread:empty { display: none; }
    .ad-turn { --agent: var(--accent); padding: 12px 14px; border: 1px solid var(--line); border-left: 3px solid var(--agent); border-radius: var(--radius-m); background: var(--surface-soft); }
    .ad-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .ad-badge { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-s); background: var(--agent); color: #041016; font-size: 11px; font-weight: 700; }
    .ad-name { font-size: 14px; }
    .ad-meta { margin-left: auto; color: var(--muted); font-size: 11px; font-family: var(--mono); }
    .ad-brief { margin: 0 0 6px; color: var(--muted); font-size: 12px; }
    .ad-brief summary { cursor: pointer; }
    .ad-brief p { margin: 6px 0 0; white-space: pre-wrap; }
    .ad-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.55; }
    .ad-handoff { margin-top: 8px; padding: 8px 10px; border: 1px dashed var(--agent); border-radius: var(--radius-s); font-size: 13px; white-space: pre-wrap; }
    .ad-handoff-label { display: block; margin-bottom: 2px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .ad-typing .ad-meta::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--agent); animation: ad-pulse 1.2s ease-in-out infinite; }
    @keyframes ad-pulse { 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { .ad-typing .ad-meta::after { animation: none; } }
    .ad-choice { list-style: none; }
    .ad-chosen { color: var(--accent); font-size: 13px; font-weight: 600; }
    .ad-pending { padding: 4px 14px; color: var(--faint); font-size: 12px; }
    .ad-system { padding: 4px 14px; color: var(--muted); font-size: 12px; text-align: center; }
    .ad-system[data-tone="alert"] { color: var(--alert); }
    .ad-system[data-tone="ok"] { color: var(--ok); }
    /* Command bar (public/js/engine/command-bar.js): ask Elarion from any view; the mic types by voice. */
    .mc-command { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px calc(40px + env(safe-area-inset-right, 0px)) calc(10px + env(safe-area-inset-bottom, 0px)) 40px; border-top: 1px solid var(--line); background: var(--surface); }
    /* Elarion has its own message box, Studio its command bar and Projects its blueprint editor: one input per page. */
    body[data-view="elaron"] .mc-command, body[data-view="studio"] .mc-command, body[data-view="blueprints"] .mc-command { display: none; }
    .mc-command input { flex: 1; min-width: 0; min-height: 44px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--canvas); color: var(--text); font: inherit; font-size: 16px; }
    .mc-command input:focus { outline: none; border-color: var(--accent-line); }
    .mc-command .mc-command-skill { color: var(--accent); border-color: var(--accent-line); white-space: nowrap; }
    .mc-command button { flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 44px; height: 44px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
    .mc-command button[type="submit"] { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
    .mc-command button:active { transform: scale(0.98); }
    .mc-command .mic[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    @media (max-width: 680px) {
      .mc-command { padding: 8px calc(12px + env(safe-area-inset-right, 0px)) calc(8px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px)); }
      .oc-tabs, .ad { padding-left: 14px; padding-right: 14px; }
    }
    @media (max-width: 900px) {
      .oc-panes { grid-template-columns: 1fr; padding: 8px 14px 18px; }
      .oc-pane-prompts { order: -1; }
      .oc-log { height: 50vh; }
    }
    .mc-muted { color: var(--muted); font-size: 12px; }
    .mc-section { padding: 8px 24px 18px; }
    .mc-section h2 { margin: 10px 0; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }

    /* Run history: task monitor (public/js/engine/task-monitor.js) */
    .mc-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 8px 24px 12px; }
    .mc-stat { padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .mc-stat-value { display: block; font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; }
    .mc-stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .mc-stat[data-kind="running"] .mc-stat-value { color: var(--accent); }
    .mc-stat[data-kind="completed"] .mc-stat-value { color: var(--ok); }
    .mc-stat[data-kind="halted"] .mc-stat-value, .mc-stat[data-kind="failed"] .mc-stat-value { color: var(--danger-text); }
    .mc-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .mc-empty { padding: 20px; border: 1px dashed var(--line-strong); border-radius: var(--radius-m); color: var(--muted); font-size: 13px; text-align: center; }
    .mc-task { border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); }
    .mc-task[data-status="RUNNING"] { border-color: var(--accent-line); }
    .mc-task[data-status="HALTED"], .mc-task[data-status="FAILED"] { border-color: var(--danger-line); }
    .mc-task-head { appearance: none; width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px 10px; padding: 12px 14px; border: none; background: none; text-align: left; cursor: pointer; }
    .mc-task-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .mc-task-agent { color: var(--muted); font-weight: 400; }
    .mc-task-time { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .mc-task-line { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 12px; }
    .mc-chip { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 11px; font-size: 12px; font-weight: 700; background: var(--queued-bg); color: var(--queued); }
    .mc-chip[data-status="RUNNING"], .mc-chip[data-status="EXECUTING"] { background: var(--ok-bg); color: var(--ok); }
    .mc-chip[data-status="COMPLETED"], .mc-chip[data-status="APPROVED_FOR_EXECUTION"] { background: var(--accent-soft); color: var(--accent); }
    .mc-chip[data-status="HALTED"], .mc-chip[data-status="FAILED"] { background: var(--off-bg); color: var(--off); }
    .mc-progress { grid-column: 1 / -1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
    .mc-progress-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.3s; }
    .mc-task[data-status="COMPLETED"] .mc-progress-fill { background: var(--switch-on); }
    .mc-task[data-status="HALTED"] .mc-progress-fill, .mc-task[data-status="FAILED"] .mc-progress-fill { background: var(--danger); }
    .mc-steps { margin: 0; padding: 0 14px 14px; list-style: none; display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
    .mc-step { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; color: var(--muted); }
    .mc-step-mark { text-align: center; }
    .mc-step[data-state="done"] .mc-step-mark { color: var(--ok); }
    .mc-step[data-state="running"] { color: var(--text); }
    .mc-step[data-state="running"] .mc-step-mark { color: var(--accent); }
    .mc-step[data-state="halted"] .mc-step-mark, .mc-step[data-state="failed"] .mc-step-mark { color: var(--danger-text); }
    .mc-step-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-project { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); }
    .mc-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .copy-id { appearance: none; min-height: 44px; padding: 0 10px; border: 0; background: none; color: var(--accent); font: inherit; font-size: 13px; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
    .mc-project-meta { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
    .mc-project.mc-project-link { appearance: none; width: 100%; text-align: left; cursor: pointer; }
    .mc-project.mc-project-link:hover { border-color: var(--accent-line); }

    /* Settings: engine connection (public/js/engine/connection.js) and setup wizard (connection-wizard.js) */
    .mc-connection { margin: 0 24px 24px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .mc-connection summary { padding: 12px 14px; color: var(--muted); font-size: 12px; cursor: pointer; }
    .mc-connection-body { display: flex; flex-direction: column; gap: 8px; padding: 0 14px 14px; font-size: 12px; }
    .mc-connection-body p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
    .mc-connection textarea, .mc-url-input { width: 100%; padding: 9px 11px; border: 1px solid var(--line-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--text); font-family: var(--mono); font-size: 16px; }
    .mc-connection textarea { word-break: break-all; resize: vertical; }
    .mc-url-input:focus, .mc-connection textarea:focus { outline: none; border-color: var(--accent); }
    .mc-connection-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .mc-connection-url, .mc-connection-manual { display: flex; flex-direction: column; gap: 6px; }
    .mc-connection-url label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); }
    /* Quick Setup (public/js/engine/quick-setup.js) and the header's Elarion Ready badge. */
    #mc-view-connect { display: flex; flex-direction: column; gap: 20px; }
    #mc-view-connect[hidden] { display: none; }
    .mc-engine-note { margin: 0; padding: 12px 16px; border: 1px solid var(--alert-line); border-radius: var(--radius-m); background: var(--alert-soft); color: var(--text); font-size: 13.5px; line-height: 1.45; }
    .qs-form { display: flex; flex-direction: column; gap: 16px; padding: 8px 24px 22px; }
    .qs-field { display: flex; flex-direction: column; gap: 6px; }
    .qs-field label { font-weight: 600; font-size: 13px; }
    .qs-input { width: 100%; height: 44px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font-size: 14px; }
    .qs-input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
    .qs-key-row { display: flex; gap: 8px; }
    .qs-reveal { appearance: none; flex: none; height: 44px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface-soft); color: var(--text); font-weight: 600; cursor: pointer; }
    .qs-hint { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .qs-hint[data-kind="ok"] { color: var(--ok); }
    .qs-hint[data-kind="error"] { color: var(--alert); }
    .qs-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
    .qs-pair { height: 46px; padding: 0 22px; font-size: 14px; }
    .qs-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .qs-step { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .qs-step[data-state="idle"] { opacity: 0.65; }
    .qs-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--line-strong); font-size: 12px; font-weight: 700; }
    .qs-step[data-state="busy"] .qs-mark { border-color: var(--accent); border-top-color: transparent; animation: qs-spin 0.8s linear infinite; }
    .qs-step[data-state="ok"] .qs-mark { border-color: var(--ok-dot); background: var(--ok-bg); color: var(--ok); }
    .qs-step[data-state="ok"] .qs-mark::after { content: "✓"; }
    .qs-step[data-state="fail"] { border-color: var(--danger-line); }
    .qs-step[data-state="fail"] .qs-mark { border-color: var(--off-dot); background: var(--off-bg); color: var(--off); }
    .qs-step[data-state="fail"] .qs-mark::after { content: "!"; }
    .qs-step-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .qs-step-label { font-weight: 600; font-size: 13px; }
    .qs-step-detail { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .qs-step-detail:empty { display: none; }
    @keyframes qs-spin { to { transform: rotate(360deg); } }
    .ready-pill { appearance: none; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 14px; border: 1px solid transparent; border-radius: var(--radius-m); background: var(--ok-bg); color: var(--ok); font-size: 13px; font-weight: 700; white-space: nowrap; cursor: pointer; }
    .ready-pill[data-kind="alert"] { background: var(--alert-bg); color: var(--alert); border-color: var(--alert-line); }
    .ready-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok-dot); }
    .ready-pill[data-kind="alert"] .ready-dot { background: var(--alert-dot); }
    .cw { display: flex; flex-direction: column; gap: 16px; padding: 8px 24px 20px; }
    .cw-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .cw-status-text { flex: 1; min-width: 160px; }
    .cw-msg { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .cw-msg:empty { display: none; }
    .cw-msg[data-kind="ok"] { color: var(--ok); }
    .cw-msg[data-kind="error"] { color: var(--danger-text); }
    .cw-status .cw-msg { flex-basis: 100%; }
    .cw-offer { display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); background: var(--accent-soft); }
    .cw-offer h3 { font-size: 15px; color: var(--accent); }
    .cw-offer-text { overflow-wrap: anywhere; }
    .cw-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 0; border: none; }
    .cw-modes legend { padding: 0 0 10px; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .cw-mode { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 16px 16px 16px 44px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); cursor: pointer; }
    .cw-mode.active { border-color: var(--accent-line); background: var(--accent-soft); }
    .cw-mode-input { position: absolute; left: 16px; top: 18px; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
    .cw-mode-title { font-weight: 600; font-size: 15px; }
    .cw-mode-sub { color: var(--accent); font-size: 12px; font-weight: 600; }
    .cw-mode-text { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .cw-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 14px; }
    .cw-step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; }
    .cw-step-n { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 13px; }
    .cw-step-body { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .cw-step-body h3 { margin-top: 4px; font-size: 14px; font-weight: 600; }
    .cw-step-body p { line-height: 1.5; }
    .cw-step-body code { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    .cw-code { position: relative; border-radius: var(--radius-s); background: var(--terminal); color: var(--terminal-text); }
    .cw-code pre { margin: 0; padding: 12px 72px 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; line-height: 1.6; }
    .cw-copy { position: absolute; top: 7px; right: 7px; appearance: none; height: 26px; padding: 0 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(255,255,255,0.06); color: var(--terminal-text); font-size: 11px; cursor: pointer; }
    .cw-row, .cw-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .cw-row .mc-url-input { flex: 1; min-width: 200px; }
    .cw-label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 12px; }
    .cw-cloud-form { display: flex; flex-direction: column; gap: 8px; }
    .cw-pair { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; align-items: start; padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); }
    .cw-qr { width: 180px; height: 180px; border-radius: var(--radius-s); overflow: hidden; background: #fff; }
    .cw-qr svg { display: block; width: 100%; height: 100%; }
    .cw-pair-side { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .cw-pair-hint { font-weight: 600; }
    .cw-pair-link { display: block; padding: 7px 9px; border-radius: var(--radius-s); background: var(--surface-soft); color: var(--muted); }

    /* Elarion view: the dock (public/js/engine/brain-dock.js) fills the canvas. */
    #mc-elaron { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .brain-dock { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .brain-head { display: flex; align-items: center; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--line); }
    .brain-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .brain-title h2 { font-size: 17px; font-weight: 600; }
    .brain-status { font-size: 12px; color: var(--muted); }
    .elaron[data-mode="halted"] ~ .brain-title .brain-status { color: var(--danger-text); }
    .brain-icon-btn { appearance: none; flex: none; min-width: 40px; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); font-size: 13px; cursor: pointer; }
    .brain-icon-btn:disabled, .brain-send:disabled { opacity: 0.45; cursor: default; }
    .brain-mic[aria-pressed="true"] { border-color: var(--danger); background: var(--off-bg); }
    .brain-log { flex: 1; min-height: 0; margin: 0; padding: 18px 22px; list-style: none; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    .brain-empty { margin: auto 0; color: var(--muted); font-size: 13px; line-height: 1.5; text-align: center; }
    .brain-msg { max-width: 78%; display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; border-radius: var(--radius-m); font-size: 14px; line-height: 1.5; }
    .brain-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .brain-meta { font-size: 11px; color: var(--muted); }
    .brain-user { align-self: flex-end; background: var(--ink); color: var(--on-ink); }
    .brain-user .brain-meta { color: var(--faint); }
    .brain-assistant { align-self: flex-start; border: 1px solid var(--line); background: var(--surface-soft); }
    .brain-system { align-self: center; max-width: 100%; padding: 2px 8px; color: var(--muted); font-size: 12px; text-align: center; }
    .brain-error { align-self: stretch; max-width: 100%; border-left: 3px solid var(--danger); background: var(--danger-soft); color: var(--off); font-size: 13px; }
    .brain-interim { margin: 0 22px 6px; color: var(--muted); font-size: 13px; font-style: italic; }
    .brain-form { display: flex; align-items: flex-end; gap: 8px; padding: 14px 22px 4px; border-top: 1px solid var(--line); }
    .brain-input { flex: 1; min-width: 0; max-height: 140px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font: inherit; font-size: 16px; resize: none; }
    .brain-input:focus { outline: none; border-color: var(--accent); }
    .brain-send { appearance: none; height: 40px; padding: 0 18px; border: 1px solid var(--ink); border-radius: var(--radius-m); background: var(--ink); color: var(--on-ink); font-size: 13px; font-weight: 600; cursor: pointer; }
    .brain-hint { min-height: 1em; margin: 0; padding: 4px 22px 14px; color: var(--muted); font-size: 11px; }
    .elaron { position: relative; flex: none; width: 42px; height: 42px; }
    .elaron-core, .elaron-ring { position: absolute; border-radius: 50%; }
    .elaron-core { inset: 9px; background: radial-gradient(circle at 35% 30%, #D6FFF5, #00C9A7 55%, #0B4F48); }
    .elaron-ring { inset: 2px; border: 2px solid var(--accent-line); opacity: 0.6; }
    .elaron[data-mode="connecting"] .elaron-ring { border-style: dashed; opacity: 0.9; animation: elaron-spin 2.4s linear infinite; }
    .elaron[data-mode="listening"] .elaron-ring { border-color: var(--accent); animation: elaron-listen 1.2s ease-out infinite; }
    .elaron[data-mode="thinking"] .elaron-ring { border-color: transparent; border-top-color: var(--accent); opacity: 1; animation: elaron-spin 0.9s linear infinite; }
    .elaron[data-mode="speaking"] .elaron-core { animation: elaron-speak 0.5s ease-in-out infinite alternate; }
    .elaron[data-mode="halted"] .elaron-core { background: radial-gradient(circle at 35% 30%, #FFD5D5, #EF4444 55%, #7F1D1D); }
    .elaron[data-mode="halted"] .elaron-ring { border-color: var(--danger); opacity: 0.9; }
    .elaron[data-mode="offline"] .elaron-core { background: radial-gradient(circle at 35% 30%, #F4F4F5, #A1A1AA 55%, #52525B); }
    .elaron[data-mode="offline"] .elaron-ring { border-color: var(--line-strong); }
    @keyframes elaron-spin { to { transform: rotate(360deg); } }
    @keyframes elaron-listen { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.18); opacity: 0; } }
    @keyframes elaron-speak { from { transform: scale(0.9); } to { transform: scale(1.06); } }

    /* Projects: blueprints (public/js/engine/blueprints.js) */
    .bp-card { margin: 0 0 20px; padding: 22px 24px; border: 1px solid var(--line); border-radius: var(--radius-l); background: var(--surface); display: flex; flex-direction: column; gap: 12px; }
    .bp-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .bp-card-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .bp-tier { padding: 3px 10px; border-radius: 11px; font-size: 11px; font-weight: 600; background: var(--queued-bg); color: var(--queued); }
    .bp-tier[data-tier="pro"] { background: var(--alert-bg); color: var(--alert); }
    .bp-editor { width: 100%; min-height: 200px; padding: 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface-soft); color: var(--text); font-family: var(--mono); font-size: 13px; line-height: 1.55; resize: vertical; }
    .bp-editor:focus { outline: none; border-color: var(--accent); }
    .bp-editor[aria-invalid="true"] { border-color: var(--danger); }
    .bp-editor.bp-drop { border-style: dashed; border-color: var(--accent); }
    .bp-actions, .bp-deploy-row, .bp-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .bp-primary { appearance: none; display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border: 1px solid var(--ink); border-radius: var(--radius-m); background: var(--ink); color: var(--on-ink); font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; }
    .bp-primary:disabled { opacity: 0.5; cursor: progress; }
    .bp-pro-badge { padding: 1px 6px; border-radius: 4px; background: var(--lime); color: var(--on-lime); font-size: 10px; font-weight: 800; letter-spacing: 0.06em; }
    .bp-result { margin: 0; padding: 12px 14px; border-radius: var(--radius-s); border-left: 3px solid var(--switch-on); background: var(--ok-bg); color: var(--ok-strong); font-size: 13px; }
    .bp-result[data-kind="error"] { border-left-color: var(--danger); background: var(--danger-soft); color: var(--off); }
    .bp-result[data-kind="note"] { border-left-color: var(--line-strong); background: var(--surface-soft); color: var(--text-2); }
    .bp-result-title { margin: 0; font-weight: 600; }
    .bp-issues { margin: 6px 0 0; padding-left: 18px; font-size: 12px; }
    .bp-issues li[data-level="warning"] { color: var(--alert); }
    .bp-issues li[data-level="note"] { color: var(--muted); }
    .bp-issues code { font-family: var(--mono); }
    .bp-browser { display: grid; grid-template-columns: minmax(200px, 270px) minmax(0, 1fr); gap: 14px; align-items: start; }
    .bp-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 70vh; overflow-y: auto; }
    .bp-list-item { appearance: none; width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface); text-align: left; cursor: pointer; }
    .bp-list-item[aria-current="true"] { border-color: var(--accent-line); background: var(--accent-soft); }
    .bp-list-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .bp-list-meta { grid-column: 1 / -1; color: var(--muted); font-size: 11px; }
    .bp-viewer { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
    .bp-viewer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .bp-viewer-head h3 { margin: 0; font-size: 17px; font-weight: 600; }
    .bp-viewer-head p { margin: 2px 0 0; overflow-wrap: anywhere; }
    .bp-viewer h4 { margin: 8px 0 0; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .bp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
    .bp-fact { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--surface-soft); }
    .bp-fact-value { display: block; font-weight: 600; overflow-wrap: anywhere; }
    .bp-fact-label { color: var(--muted); font-size: 11px; }
    .bp-confirm { padding: 12px 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-m); font-size: 13px; }
    .bp-confirm[hidden] { display: none; }
    .bp-deploy-status { margin: 0; }
    .bp-table-wrap { overflow-x: auto; }
    .bp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .bp-table caption { text-align: left; color: var(--muted); font-size: 11px; padding-bottom: 4px; }
    .bp-table th, .bp-table td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .bp-table th { color: var(--muted); font-weight: 600; }
    .bp-table a { color: var(--accent); }
    .bp-warning { margin: 0; color: var(--alert); font-size: 12px; }
    .bp-raw summary { cursor: pointer; color: var(--muted); font-size: 12px; }
    .bp-raw pre { max-height: 320px; overflow: auto; margin: 6px 0 0; padding: 12px; border-radius: var(--radius-s); background: var(--terminal); color: var(--terminal-text); font-size: 11px; }

    /* Studio canvas (public/js/engine/studio-canvas.js): task trees, MCP servers and confidence-scored bridges. */
    .studio-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 18px 24px 6px; }
    .studio-slider-wrap { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; font-weight: 600; color: var(--text-2); }
    .studio-slider { width: 200px; min-height: 44px; accent-color: var(--flow-mcp); }
    .studio-spacer { flex: 1; }
    .studio-legend { display: inline-flex; align-items: center; gap: 6px; }
    .legend-line { display: inline-block; width: 22px; height: 0; border-top: 2px solid var(--flow-mcp); }
    .legend-dashed { border-top-style: dashed; opacity: 0.7; }
    .studio-status { padding: 0 24px 10px; margin: 0; }
    .studio-status[data-kind="error"] { color: var(--danger-text); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .studio-body { display: flex; gap: 16px; padding: 0 24px 24px; align-items: flex-start; }
    .studio-viewport { flex: 1; min-width: 0; min-height: 320px; overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-l); background: var(--surface-soft); }
    .studio-svg { display: block; }
    .tree-edge { fill: none; stroke: var(--line-strong); stroke-width: 1.5; }
    .bridge-line { fill: none; stroke: var(--flow-mcp); stroke-linecap: round; transition: stroke-opacity 300ms cubic-bezier(0.25, 1, 0.5, 1); }
    .bridge[data-depth="abstract"] .bridge-line { stroke-dasharray: 5 5; }
    .bridge-hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; pointer-events: stroke; }
    .bridge-hit:focus-visible { outline: none; stroke: var(--accent-line); }
    .bridge[data-hidden="true"] { display: none; }
    .bridge[data-selected="true"] .bridge-line { stroke: var(--accent); stroke-opacity: 1; }
    .node-box { fill: var(--surface); stroke: var(--line); stroke-width: 1; }
    .node-mcp .node-box { stroke: var(--flow-mcp); stroke-opacity: 0.55; }
    .node-task .node-box { stroke: var(--line-strong); }
    .node-dot { fill: var(--queued-dot); }
    .node-dot[data-kind="running"] { fill: var(--ok-dot); }
    .node-dot[data-kind="alert"] { fill: var(--alert-dot); }
    .node-dot[data-kind="off"] { fill: var(--off-dot); }
    .node-label { fill: var(--text); font-size: 13px; font-weight: 600; font-family: var(--font); }
    .node-sub { fill: var(--muted); font-size: 11px; font-family: var(--font); }
    .studio-inspector { width: 340px; flex-shrink: 0; padding: 18px 20px; position: sticky; top: 16px; max-height: calc(100vh - 140px); overflow: auto; }
    .studio-inspector h3 { font-size: 15px; font-weight: 600; }
    .studio-inspector h4 { margin: 18px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .inspector-route { margin: 10px 0; font-size: 13px; overflow-wrap: anywhere; }
    .studio-svg .node-task, .studio-svg .node-step { cursor: pointer; }
    .studio-svg .node[data-selected="true"] .node-box { stroke: var(--accent); stroke-width: 2; }
    .studio-svg .node:focus-visible { outline: none; }
    .studio-svg .node:focus-visible .node-box { stroke: var(--accent); stroke-width: 2; }
    .inspector-error { margin: 12px 0 0; padding: 10px 12px; border-left: 3px solid var(--danger-text); border-radius: 0 var(--radius-s) var(--radius-s) 0; background: var(--surface-soft); font-size: 13px; }
    .inspector-error p { margin: 4px 0 0; line-height: 1.45; overflow-wrap: anywhere; }
    .inspector-error strong { color: var(--danger-text); }
    .inspector-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
    .inspector-reply { margin: 0; padding: 10px 12px; max-height: 420px; overflow: auto; border-radius: var(--radius-s); background: var(--surface-soft); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .inspector-copy { margin-top: 8px; }
    .inspector-steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
    .inspector-step-link { appearance: none; border: none; background: none; padding: 2px 0; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .inspector-step-link:hover { color: var(--accent); }
    .inspector-step-link[data-state="failed"] { color: var(--danger-text); }
    .inspector-step-link[data-state="queued"] { color: var(--muted); }
    .inspector-confidence { display: flex; align-items: center; gap: 10px; }
    .inspector-pct { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
    .studio-inspector .meter { height: 6px; margin: 8px 0 4px; border-radius: 3px; background: var(--queued-bg); overflow: hidden; }
    .studio-inspector .meter span { display: block; height: 100%; background: var(--flow-mcp); }
    .inspector-rationale { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); }
    .inspector-quote { margin: 10px 0 0; padding: 10px 12px; border-left: 3px solid var(--flow-mcp); background: var(--surface-soft); border-radius: 0 var(--radius-s) var(--radius-s) 0; }
    .inspector-quote p { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .inspector-step { margin-top: 10px; font-size: 12.5px; }
    .inspector-step p { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
    .inspector-signals { margin: 0; padding: 0; list-style: none; font-size: 12.5px; }
    .inspector-signals li { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
    .inspector-terms { grid-column: 1 / -1; }
    .inspector-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 12.5px; }
    .inspector-meta dt { color: var(--muted); }
    .inspector-meta dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 900px) {
      .studio-body { flex-direction: column; }
      .studio-inspector { width: 100%; position: static; max-height: none; }
      .studio-toolbar, .studio-status, .studio-body { padding-left: 14px; padding-right: 14px; }
      .studio-slider { width: 160px; }
    }
    /* Studio Workflow console (public/js/engine/workflow-console.js, specs/ui/01-node-canvas.md). Cable colours are
       data colours (--flow-*), --accent marks only selection, and only the pulse halo glows. */
    .wfc-console { padding: 16px 24px 24px; min-width: 0; }
    .wfc-command { width: 100%; min-width: 0; padding: 14px 16px 10px; }
    .wfc-command-label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; }
    .wfc-command-row { display: flex; gap: 10px; align-items: stretch; width: 100%; min-width: 0; }
    /* The goal box fills its row at every width (explicit width, not just flex), and touch screens get 16px text so
       iOS Safari doesn't zoom the page when it is focused. */
    .wfc-prompt { flex: 1 1 auto; width: 100%; min-width: 0; min-height: 48px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-m); background: var(--surface); color: var(--text); font: inherit; font-size: 14px; line-height: 1.4; resize: vertical; -webkit-appearance: none; appearance: none; }
    @media (pointer: coarse) { .wfc-prompt { font-size: 16px; } }
    .wfc-prompt:focus { outline: 2px solid var(--accent-line); outline-offset: 1px; border-color: var(--accent); }
    .wfc-prompt[aria-busy="true"] { opacity: 0.7; }
    .wfc-submit { align-self: flex-start; height: 44px; }
    .wfc-submit:disabled { opacity: 0.6; cursor: progress; }
    .wfc-command-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .wfc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin-top: 14px; }
    .wfc-picker { height: 32px; max-width: 280px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); color: var(--text); font: inherit; font-size: 12.5px; }
    .wfc-edit-toggle[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .wfc-legend { display: inline-flex; flex-wrap: wrap; gap: 10px; }
    .wfc-legend-item { display: inline-flex; align-items: center; gap: 5px; }
    .wfc-legend-line { display: inline-block; width: 20px; height: 0; border-top: 2px solid var(--line-strong); }
    .wfc-legend-item[data-kind="mcp_read"] .wfc-legend-line { border-top-color: var(--flow-mcp); }
    .wfc-legend-item[data-kind="a2a"] .wfc-legend-line { border-top: 4px double var(--flow-a2a); }
    .wfc-legend-item[data-kind="action"] .wfc-legend-line { border-top-color: var(--flow-action); }
    .wfc-status { margin: 10px 0 8px; font-size: 12.5px; }
    .wfc-status[data-kind="error"] { color: var(--danger-text); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .wfc-halted { margin: 0 0 10px; padding: 10px 14px; border: 1px solid var(--danger-line); border-radius: var(--radius-m); background: var(--danger-soft); color: var(--danger-text); font-weight: 600; font-size: 13px; }
    .wfc-body { display: flex; gap: 16px; align-items: flex-start; }
    .wfc-canvas-wrap { position: relative; isolation: isolate; flex: 1; min-width: 0; }
    .wfc-viewport { min-height: 440px; max-height: calc(100vh - 300px); overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-l); background-color: var(--surface-soft); background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 16px 16px; }
    .wfc-stage { position: relative; min-width: 100%; min-height: 440px; }
    .wfc-cables { position: absolute; inset: 0 auto auto 0; overflow: visible; }
    .wfc-nodes { position: absolute; inset: 0; }
    .wfc-line { fill: none; stroke: var(--line-strong); stroke-width: 2; stroke-linecap: round; transition: stroke-width 300ms cubic-bezier(0.25, 1, 0.5, 1); }
    .wfc-cable[data-kind="mcp_read"] .wfc-line { stroke: var(--flow-mcp); }
    .wfc-cable[data-kind="action"] .wfc-line { stroke: var(--flow-action); }
    .wfc-cable[data-kind="a2a"] .wfc-line-outer { stroke: var(--flow-a2a); stroke-width: 6; }
    .wfc-cable[data-kind="a2a"] .wfc-line-inner { stroke: var(--surface-soft); stroke-width: 2; }
    .wfc-arrow { fill: var(--flow-action); }
    .wfc-bolt { font-size: 11px; pointer-events: none; }
    .wfc-hit { fill: none; stroke: transparent; stroke-width: 16; cursor: pointer; pointer-events: stroke; }
    .wfc-hit:focus-visible { outline: none; stroke: var(--accent-line); stroke-opacity: 0.6; }
    .wfc-cable[data-selected="true"] .wfc-line { stroke-width: 3; }
    .wfc-cable[data-selected="true"] .wfc-line-outer { stroke-width: 7; }
    .wfc-cable[data-selected="true"] .wfc-hit { stroke: var(--accent); stroke-opacity: 0.18; }
    .wfc-cable[data-flash="true"] .wfc-line { stroke-width: 3; }
    .wfc-cable[data-new="true"] .wfc-line { stroke-dasharray: 6 4; }
    .wfc-ghost { fill: none; stroke: var(--accent); stroke-width: 2; stroke-dasharray: 4 4; pointer-events: none; }
    .wfc-pulse { fill: var(--line-strong); }
    .wfc-pulse-halo { fill: var(--line-strong); opacity: 0.45; filter: blur(5px); }
    .wfc-pulse[data-kind="mcp_read"], .wfc-pulse-halo[data-kind="mcp_read"] { fill: var(--flow-mcp); }
    .wfc-pulse[data-kind="a2a"], .wfc-pulse-halo[data-kind="a2a"] { fill: var(--flow-a2a); }
    .wfc-pulse[data-kind="action"], .wfc-pulse-halo[data-kind="action"] { fill: var(--flow-action); }
    .wfc-pulse[data-frozen="true"], .wfc-pulse-halo[data-frozen="true"] { opacity: 0.3; }
    .wfc-overflow { font-size: 11px; font-weight: 700; fill: var(--text-2); font-family: var(--mono); }
    .wfc-console[data-halted="true"] .wfc-line { stroke: var(--faint); }
    .wfc-console[data-halted="true"] .wfc-line-inner { stroke: var(--surface-soft); }
    .wfc-node { position: absolute; box-sizing: border-box; border: 1px solid var(--line); border-radius: var(--radius-l); background: var(--surface); }
    .wfc-node[data-kind="trigger"] { border-style: dashed; }
    .wfc-node[data-kind="mcp"] { border-color: var(--flow-mcp); }
    .wfc-node[data-kind="action"] { border-color: var(--flow-action); }
    .wfc-node[data-kind="human"] { border-color: var(--alert-line); background: var(--alert-soft); }
    .wfc-node[data-selected="true"] { border-color: var(--accent); }
    .wfc-node[data-dragging="true"] { box-shadow: 0 8px 24px rgba(24,24,27,0.16); z-index: 2; }
    .wfc-node[data-new="true"] { outline: 2px dashed var(--accent-line); outline-offset: 3px; }
    .wfc-node-head { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px 4px; border-radius: var(--radius-l) var(--radius-l) 0 0; cursor: default; outline: none; }
    .wfc-console[data-editable="true"] .wfc-node-head { cursor: grab; touch-action: none; }
    .wfc-node[data-dragging="true"] .wfc-node-head { cursor: grabbing; }
    .wfc-node-head:focus-visible { box-shadow: inset 0 0 0 2px var(--accent-line); }
    .wfc-kind { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .wfc-node-label { font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 64px; }
    .wfc-node-sub { margin: 0; padding: 0 14px 0 52px; font-size: 11.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .wfc-run-pill { position: absolute; top: 8px; right: 8px; height: 22px; padding: 0 8px; font-size: 11px; }
    .wfc-port { position: absolute; width: 28px; height: 28px; margin: -14px 0 0 -14px; padding: 0; border: none; background: none; cursor: default; z-index: 1; }
    .wfc-port::before { content: ""; position: absolute; left: 8px; top: 8px; width: 12px; height: 12px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--line-strong); background: var(--surface); transition: transform 300ms cubic-bezier(0.25, 1, 0.5, 1), opacity 300ms; }
    .wfc-console[data-editable="true"] .wfc-port[data-dir="out"] { cursor: crosshair; }
    .wfc-port[data-port="mcp"]::before, .wfc-port[data-port="read"]::before { border-color: var(--flow-mcp); }
    .wfc-port[data-port="a2a"]::before { border-color: var(--flow-a2a); }
    .wfc-port[data-port="act"]::before { border-color: var(--flow-action); }
    .wfc-port:focus-visible { outline: none; }
    .wfc-port:focus-visible::before { box-shadow: 0 0 0 3px var(--accent-line); }
    .wfc-console[data-wiring="true"] .wfc-port[data-compat="true"]::before { transform: scale(1.35); background: var(--accent-soft); border-color: var(--accent); }
    .wfc-console[data-wiring="true"] .wfc-port[data-compat="false"] { opacity: 0.3; }
    .wfc-port-label { position: absolute; margin-top: -7px; font-size: 9.5px; line-height: 14px; color: var(--faint); pointer-events: none; }
    .wfc-port-label[data-dir="in"] { left: 12px; }
    .wfc-port-label[data-dir="out"] { right: 12px; }
    .wfc-badge { position: absolute; left: 50%; bottom: -14px; transform: translateX(-50%); max-width: 190px; padding: 3px 8px; border-radius: 10px; background: var(--ink); color: var(--on-ink); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; z-index: 3; }
    .wfc-shake { animation: wfc-shake 200ms linear 1; }
    @keyframes wfc-shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
    .wfc-tip { position: absolute; left: 12px; bottom: 12px; max-width: min(460px, calc(100% - 24px)); margin: 0; padding: 8px 12px; border-radius: var(--radius-m); background: var(--ink); color: var(--on-ink); font-size: 12.5px; z-index: 4; }
    .wfc-connect-menu { position: absolute; top: 12px; left: 12px; width: 300px; max-height: 340px; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 4px; z-index: 5; }
    .wfc-connect-menu[hidden] { display: none; }
    .wfc-menu-title { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; }
    .wfc-menu-item { appearance: none; min-height: 40px; padding: 0 10px; border: 1px solid transparent; border-radius: var(--radius-s); background: none; color: var(--text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
    .wfc-menu-item:hover, .wfc-menu-item:focus-visible { background: var(--surface-soft); border-color: var(--line); outline: none; }
    .wfc-inspector { width: 320px; flex-shrink: 0; padding: 16px 18px; position: sticky; top: 16px; max-height: calc(100vh - 140px); overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    .wfc-inspector h3 { margin: 0; font-size: 15px; font-weight: 600; }
    .wfc-inspector h4 { margin: 6px 0 0; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .wfc-inspector p { margin: 0; }
    .wfc-goal { font-size: 13px; line-height: 1.5; color: var(--text-2); }
    .wfc-field-wrap { display: flex; flex-direction: column; gap: 4px; }
    .wfc-field { padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; resize: vertical; }
    .wfc-field:focus { outline: 2px solid var(--accent-line); outline-offset: 1px; }
    .wfc-history { margin: 0; padding: 0; list-style: none; font-size: 12.5px; color: var(--text-2); display: flex; flex-direction: column; gap: 6px; }
    .wfc-source { display: inline-block; margin-right: 4px; padding: 1px 6px; border-radius: 6px; background: var(--queued-bg); color: var(--queued); font-size: 10.5px; font-weight: 600; }
    .wfc-source[data-source="operator"] { background: var(--accent-soft); color: var(--accent); }
    .wfc-source[data-source="model"] { background: var(--ok-bg); color: var(--ok); }
    .btn-danger-lite { align-self: flex-start; border-color: var(--danger-line); color: var(--danger-text); }
    @media (max-width: 900px) {
      .wfc-console { padding: 12px 14px 18px; }
      .wfc-body { flex-direction: column; }
      .wfc-inspector { width: 100%; position: static; max-height: none; box-sizing: border-box; }
      .wfc-command-row { flex-direction: column; }
      /* In a column a flex: 1 box starts from zero height; keep the textarea's own two rows instead. */
      .wfc-prompt { flex: none; font-size: 16px; min-height: 96px; }
      .wfc-submit { align-self: stretch; justify-content: center; }
      .wfc-viewport { max-height: 70vh; }
    }
    @media (prefers-reduced-motion: reduce) {
      .engine-badge[data-state="HALTED"], .status-pill[data-kind="halted"] { animation: none; }
      .elaron-ring, .elaron-core { animation: none !important; }
      .elaron[data-mode="listening"] .elaron-ring, .elaron[data-mode="thinking"] .elaron-ring { opacity: 1; border-color: var(--accent); }
      .mc-progress-fill, .bar-fill, .switch, .switch-knob, .mc-rail { transition: none; }
      .wfc-line, .wfc-port::before { transition: none; }
      .wfc-shake { animation: none; }
    }
    /* Medium screens: the detail panel moves under the workforce, whose cards go two across. */
    /* The menu tray folded to icons (☰ on desktop, or a medium screen by default). */
    @media (min-width: 680.02px) {
      body[data-rail="icons"] .mc-rail { width: 84px; padding-left: 12px; padding-right: 12px; align-items: center; }
      body[data-rail="icons"] .rail-brand { padding: 0 0 22px; }
      body[data-rail="icons"] .rail-brand-word, body[data-rail="icons"] .rail-label, body[data-rail="icons"] .rail-compute, body[data-rail="icons"] .rail-user-text { display: none; }
      body[data-rail="icons"] .rail-item { justify-content: center; padding: 0; width: 52px; position: relative; }
      body[data-rail="icons"] .rail-count { position: absolute; top: 4px; right: 2px; min-width: 18px; height: 18px; font-size: 10px; padding: 0 4px; }
      body[data-rail="icons"] .rail-user { justify-content: center; padding: 14px 0 4px; }
    }
    @media (max-width: 1180px) {
      .wf-split { grid-template-columns: minmax(0, 1fr); }
      .wf-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
      .wf-detail { position: static; }
    }
    @media (max-width: 767.98px) {
      .surface-link { padding: 0; width: 44px; }
      .surface-link-label { display: none; }
    }
    @media (max-width: 900px) {
      .mc-top { padding-left: 24px; padding-right: 24px; }
      .mc-main { padding: 20px 20px calc(24px + env(safe-area-inset-bottom, 0px)); }
      .wf-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric:nth-child(3) { padding-left: 0; border-left: none; }
      .metric:nth-child(n + 3) { border-top: 1px solid var(--line); }
      .mc-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .bp-browser { grid-template-columns: minmax(0, 1fr); }
      .bp-list { max-height: 240px; }
    }
    /* Phones: the rail is a menu tray that slides in from the left under ☰ (like Claude and Gemini), over a scrim
       that closes it; the header keeps the status pill. */
    @media (max-width: 680px) {
      body { flex-direction: column; }
      .mc-rail { position: fixed; z-index: 300; inset: 0 auto 0 0; width: min(300px, 86vw); transform: translateX(-102%); transition: transform 0.26s cubic-bezier(0.25, 1, 0.5, 1); border-right: 1px solid var(--rail-line); }
      body.rail-open .mc-rail { transform: none; }
      .mc-scrim { position: fixed; inset: 0; z-index: 290; border: 0; padding: 0; background: rgba(0,0,0,0.5); }
        .mc-canvas { min-height: 0; }
      /* Phone header budget: one row of 44px controls (menu, Space, page title, status pill, New agent), 68px tall, plus a
         greeting line on Mission Control only. The heading and actions wrappers dissolve so each piece is a direct flex item;
         the title takes the space left and wraps to two lines rather than clipping; the "Operations" eyebrow just repeats
         the title here, so it is dropped on phones. */
      .mc-top { gap: 4px 8px; padding: calc(12px + env(safe-area-inset-top, 0px)) calc(14px + env(safe-area-inset-right, 0px)) 12px calc(14px + env(safe-area-inset-left, 0px)); }
      .mc-heading, .mc-actions { display: contents; }
      .mc-crumbs { display: none; }
      .mc-title { flex: 1 1 0; min-width: 0; margin: 0; font-size: 18px; line-height: 1.2; white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .mc-greeting { order: 10; flex: 0 0 100%; font-size: 13px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .status-pill { padding: 0 12px; font-size: 13px; }
      /* Calm states stay a compact pill in the row. States that want attention (needs you, offline, halted) become a
         full-width strip under the title, so their longer words never squeeze the page name. */
      .mc-status:has(.status-pill[data-kind="alert"]), .mc-status:has(.status-pill[data-kind="halted"]) { order: 8; flex: 1 0 100%; }
      .mc-status:has(.status-pill[data-kind="alert"]) .status-pill, .mc-status:has(.status-pill[data-kind="halted"]) .status-pill { width: 100%; justify-content: center; }
      /* Only the header's New agent shrinks to an icon; other primary buttons (the Command Bar's Generate) keep their label. */
      .mc-actions .btn-primary .btn-label { display: none; }
      .mc-actions .btn-primary { width: 44px; height: 44px; padding: 0; justify-content: center; }
      .mc-main { padding: 14px 12px 20px; }
      .wf-overview { padding: 18px 16px 0; }
      .metric, .metric + .metric { padding: 16px 12px 16px 0; }
      .metric:nth-child(even) { padding-left: 14px; }
      .metric-row { flex-direction: column; align-items: flex-start; gap: 2px; }
      .metric-sub { text-align: left; }
      .wf-cards { grid-template-columns: minmax(0, 1fr); }
      .detail-head, .pane { padding-left: 16px; padding-right: 16px; }
      .objective { margin: 0 16px; }
      .detail-stats { flex-wrap: wrap; margin: 16px; gap: 12px 0; }
      .btn-pause { flex-basis: 100%; }
      .subtabs { padding: 0 16px; }
      .check-row { grid-template-columns: 22px minmax(0, 1fr) auto; padding: 12px 8px; }
      .check-label { display: none; }
      .endpoints li { grid-template-columns: 48px minmax(0, 1fr); }
      .endpoint-what { grid-column: 2; text-align: left; }
      .emergency { flex-wrap: wrap; padding: 16px; }
      .cw { padding: 8px 14px 14px; }
      .qs-form { padding: 8px 14px 16px; }
      .cw-modes { grid-template-columns: minmax(0, 1fr); }
      /* On a phone the QR code would be scanned by the phone itself; keep the address and buttons. */
      .cw-pair { grid-template-columns: minmax(0, 1fr); }
      .cw-qr, .cw-pair-hint { display: none; }
      .mc-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 8px 14px 12px; }
      .mc-section, .mc-panel-head { padding-left: 14px; padding-right: 14px; }
      .bp-card { padding: 16px; }
      .brain-msg { max-width: 90%; }
      /* Elarion's message box gets its own row; mic, speaker and Send sit under it. */
      .brain-form { flex-wrap: wrap; padding: 10px 14px 4px; }
      .brain-input { flex-basis: 100%; }
      .brain-send { margin-left: auto; }
    }
    @media (max-width: 359.98px) {
      .mc-top { flex-wrap: wrap; }
      .mc-title { flex-basis: 100%; order: 5; }
    }
  </style>
</head>
<body data-view="overview" data-shell-surface="mission-control">
  <aside class="mc-rail" id="mc-rail" aria-label="Aether">
    <a class="rail-brand" href="/" title="Space: the 3D graph (Alt+S)" aria-label="Aether Space (Alt+S)" aria-keyshortcuts="Alt+S"><span class="rail-logo">${ICONS.star}</span><span class="rail-brand-word">AETHER</span></a>
    <nav class="rail-nav" aria-label="Mission Control views">
      <button type="button" class="rail-item" id="mc-nav-overview" aria-controls="mc-view-overview" title="Mission Control">${ICONS.grid}<span class="rail-label" data-short="Control">Mission Control</span><span class="rail-count" id="mc-agent-count" aria-label="agents">1</span></button>
      <button type="button" class="rail-item" id="mc-nav-studio" aria-controls="mc-view-studio" title="Studio: task trees, MCP servers and bridges">${ICONS.nodes}<span class="rail-label">Studio</span></button>
      <button type="button" class="rail-item" id="mc-nav-elaron" aria-controls="mc-view-elaron" title="Elarion">${ICONS.pulse}<span class="rail-label">Elarion</span></button>
      <button type="button" class="rail-item" id="mc-nav-create" aria-controls="mc-view-create" title="Create / Templates: start a project from a template">${ICONS.plus}<span class="rail-label">Create</span></button>
      <button type="button" class="rail-item" id="mc-nav-blueprints" aria-controls="mc-view-blueprints" title="Projects">${ICONS.layers}<span class="rail-label">Projects</span></button>
      <button type="button" class="rail-item" id="mc-nav-roadmap" aria-controls="mc-view-roadmap" title="Roadmap: goals from ROADMAP.md and recent sessions">${ICONS.flag}<span class="rail-label">Roadmap</span></button>
      <button type="button" class="rail-item" id="mc-nav-operator" aria-controls="mc-view-operator" title="Operator Console: live agent activity, and the choices agents are waiting on">${ICONS.console}<span class="rail-label" data-short="Operator">Operator</span><span class="rail-count" id="mc-operator-count" aria-label="choices waiting" hidden>0</span></button>
      <button type="button" class="rail-item" id="mc-nav-monitor" aria-controls="mc-view-monitor" title="Run history">${ICONS.clock}<span class="rail-label" data-short="Runs">Run history</span></button>
      <span class="rail-spacer"></span>
      <div class="rail-compute">
        <div class="rail-compute-head"><span>Compute</span><strong id="mc-compute-value" title="Tokens used by task runs">0</strong></div>
        <div class="rail-compute-bar" aria-hidden="true"><span id="mc-compute-bar"></span></div>
        <div class="rail-compute-sub" id="mc-compute-sub">tokens · 0 / 0 runs done</div>
      </div>
      <a class="rail-item" id="mc-nav-engine" href="#" title="Engine State: the Aether Engine's own status page">${ICONS.engine}<span class="rail-label" data-short="Engine">Engine State</span></a>
      <button type="button" class="rail-item" id="mc-nav-connect" aria-controls="mc-view-connect" title="Settings">${ICONS.gear}<span class="rail-label">Settings</span></button>
      <button type="button" class="rail-item" id="mc-theme-toggle" title="Switch between light and dark">${ICONS.theme}<span class="rail-label" id="mc-theme-label" data-short="Theme">Dark mode</span></button>
    </nav>
    <div class="rail-user">
      <span class="rail-avatar" aria-hidden="true">${escapeAttr(initialsOf(userName))}</span>
      <span class="rail-user-text"><span class="rail-user-name">${escapeAttr(displayName || 'Operator')}</span><span class="rail-user-role">${escapeAttr(role || (tier === 'pro' ? 'Pro operator' : 'Operator'))}</span></span>
    </div>
  </aside>
  <button type="button" class="mc-scrim" id="mc-scrim" aria-label="Close menu" hidden></button>
  <div class="mc-canvas">
    <header class="mc-top">
      <button type="button" class="menu-toggle" id="mc-menu-toggle" aria-controls="mc-rail" aria-expanded="false" title="Menu" aria-label="Menu">${ICONS.menu}</button>
      <a class="surface-link" href="/" aria-label="Space" aria-keyshortcuts="Alt+S" title="Space: the 3D graph (Alt+S)">${ICONS.space}<span class="surface-link-label">Space</span></a>
      <div class="mc-heading">
        <p class="mc-crumbs">Operations</p>
        <h1 class="mc-title" id="mc-title">Mission Control</h1>
        <p class="mc-greeting" id="mc-greeting"></p>
        <span class="mc-visually-hidden" id="mc-route" role="status" aria-live="polite"></span>
      </div>
      <div class="mc-actions">
        <div class="mc-status" id="mc-status">
          <button type="button" class="status-pill" data-status="pill" data-kind="checking" aria-haspopup="dialog" aria-expanded="false" aria-controls="mc-status-panel" aria-label="Fleet status: Checking. Open details."><span class="status-dot" aria-hidden="true"></span><span class="status-text" data-status="text">Checking</span></button>
          <span class="mc-visually-hidden" data-status="live" role="status" aria-live="polite"></span>
          <span class="mc-visually-hidden" data-status="alert" role="alert"></span>
          <div class="status-panel" id="mc-status-panel" data-status="panel" role="dialog" aria-labelledby="mc-status-title" tabindex="-1" hidden>
            <h2 class="status-title" id="mc-status-title">Fleet status</h2>
            <dl class="status-rows">
              <div class="status-row"><dt>Engine</dt><dd><span data-status="engine">Checking the connection</span> <button type="button" class="status-link" data-status="engine-action" hidden>Retry</button></dd></div>
              <div class="status-row"><dt>Elarion</dt><dd><button type="button" class="ready-pill" id="mc-ready" data-kind="running" hidden><span class="ready-dot" aria-hidden="true"></span><span class="ready-text">Elarion Ready</span></button></dd></div>
              <div class="status-row"><dt>Agents</dt><dd data-status="agents">None yet</dd></div>
              <div class="status-row"><dt>Waiting for you</dt><dd data-status="waiting">Nothing</dd></div>
              <div class="status-row"><dt>Safety cutoff</dt><dd data-status="cutoff">Unknown until the engine answers.</dd></div>
            </dl>
            <div id="mc-breaker" class="mc-breaker" role="group" aria-label="Stop and resume agents"></div>
            <p class="status-help">The safety cutoff stops agents at their next step. Stop all agents turns it on for Elarion and every agent below. Resume Elarion turns it off for Elarion; resume other agents from their cards.</p>
          </div>
        </div>
        <button type="button" class="btn-primary" id="mc-new-agent" aria-label="New agent: deploy a blueprint">${ICONS.plus}<span class="btn-label">New agent</span></button>
      </div>
    </header>
    <main class="mc-main">
      <section id="mc-next" aria-label="Do this next" hidden></section>
      <div class="mc-view" id="mc-view-overview"><div id="mc-workforce"></div></div>
      <div class="mc-view" id="mc-view-studio" hidden>
        <section class="surface mc-panel" aria-labelledby="mc-studio-title">
          <div class="mc-panel-head"><h2 id="mc-studio-title">Studio</h2><span class="mc-muted">Agent-generated workflows, and what the engine is doing</span></div>
          <div class="subtabs" role="tablist" aria-label="Studio">
            <button type="button" role="tab" id="mc-studio-tab-workflow" aria-controls="mc-workflow" aria-selected="true">Workflow console</button>
            <button type="button" role="tab" id="mc-studio-tab-activity" aria-controls="mc-studio-activity" aria-selected="false" tabindex="-1">Engine activity</button>
          </div>
          <div id="mc-workflow" class="wfc-console" role="tabpanel" aria-labelledby="mc-studio-tab-workflow"></div>
          <div id="mc-studio-activity" role="tabpanel" aria-labelledby="mc-studio-tab-activity" hidden><div id="mc-studio"></div></div>
        </section>
      </div>
      <div class="mc-view surface" id="mc-view-elaron" hidden><section class="mc-elaron" id="mc-elaron" aria-label="Elarion chat and voice"></section></div>
      <div class="mc-view" id="mc-view-create" hidden><div id="mc-templates"></div></div>
      <div class="mc-view" id="mc-view-blueprints" hidden><div id="mc-blueprints"></div><div id="mc-outcomes"></div></div>
      <div class="mc-view" id="mc-view-roadmap" hidden><div id="mc-roadmap"></div></div>
      <div class="mc-view" id="mc-view-operator" hidden>
        <section class="surface mc-panel" aria-labelledby="mc-operator-title">
          <div class="mc-panel-head"><h2 id="mc-operator-title">Operator Console</h2><span id="mc-operator-status" class="mc-muted" aria-live="polite"></span></div>
          <div class="subtabs oc-tabs" role="tablist" aria-label="Operator views">
            <button type="button" role="tab" id="mc-operator-tab-log" aria-controls="mc-operator" aria-selected="true">Live log</button>
            <button type="button" role="tab" id="mc-operator-tab-dialogue" aria-controls="mc-dialogue" aria-selected="false" tabindex="-1">Agent dialogue</button>
            <button type="button" role="tab" id="mc-operator-tab-dual" aria-controls="mc-dual" aria-selected="false" tabindex="-1">Claude ⇄ Gemini</button>
          </div>
          <div id="mc-operator" role="tabpanel" aria-labelledby="mc-operator-tab-log"></div>
          <div id="mc-dialogue" role="tabpanel" aria-labelledby="mc-operator-tab-dialogue" hidden></div>
          <div id="mc-dual" role="tabpanel" aria-labelledby="mc-operator-tab-dual" hidden></div>
        </section>
      </div>
      <div class="mc-view" id="mc-view-monitor" hidden>
        <section class="surface mc-panel" aria-labelledby="mc-monitor-title">
          <div class="mc-panel-head"><h2 id="mc-monitor-title">Run history</h2><span id="mc-monitor-status" class="mc-muted" aria-live="polite"></span></div>
          <div id="mc-monitor"></div>
        </section>
      </div>
      <div class="mc-view" id="mc-view-connect" hidden>
        <p class="mc-engine-note" id="mc-engine-note" role="status" hidden></p>
        <div id="mc-quick-setup"></div>
        <section class="surface mc-panel" aria-labelledby="mc-connect-title">
          <div class="mc-panel-head"><h2 id="mc-connect-title">Engine connection</h2></div>
          <div id="mc-connect"></div>
          <details id="mc-connection" class="mc-connection"></details>
        </section>
      </div>
    </main>
    <form class="mc-command" id="mc-command" autocomplete="off" aria-label="Command bar">
      <button type="button" class="mc-command-skill" id="mc-command-skill" title="Learn a skill from a repo, a page or text">+ Skill</button>
      <label class="mc-visually-hidden" for="mc-command-input">Ask Elarion</label>
      <input id="mc-command-input" type="text" enterkeyhint="send" placeholder="Ask Elarion…" aria-describedby="mc-command-hint" maxlength="4000">
      <span class="mc-visually-hidden" id="mc-command-hint">Or paste a repo link to learn a skill.</span>
      <button type="button" class="mic" id="mc-command-mic" aria-pressed="false" title="Speak (Microphone)" aria-label="Microphone">${ICONS.mic}</button>
      <button type="submit">Send</button>
    </form>
  </div>
  <noscript><p class="mc-section">Mission Control needs JavaScript.</p></noscript>
  <script type="module" src="/js/engine/mission-control.js?v=${v}"></script>
  <script type="module" src="/js/update-check.js?v=${v}"></script>
</body>
</html>`;
}
