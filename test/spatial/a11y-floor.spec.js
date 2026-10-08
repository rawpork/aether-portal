// The accessibility floor, checked from source so it cannot slip back: the 12px type floor in both pages' CSS and the spatial
// modules, AA contrast for Space's text and for the thumb wheel's labels, and the focus ring and 44px touch pads Space relies on.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WHEEL_COLORS } from '../../public/js/spatial/thumb-wheel.js';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const spatialFiles = () => readdirSync(join(process.cwd(), 'public/js/spatial')).filter((f) => f.endsWith('.js')).map((f) => 'public/js/spatial/' + f);
const sources = ['src/index.js', 'src/mission-control-page.js', 'src/share-page.js', 'public/js/shell-surfaces.js', ...spatialFiles()];

// Colour maths (WCAG 2.x relative luminance).
const channel = (v) => {
	const c = v / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
	const h = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

// The only text left under 12px, by selector, with the reason. Glyphs are not text; the workflow canvas nodes are laid out to
// fixed pixel geometry (specs/ui/01-node-canvas.md).
const ALLOWED_UNDER_FLOOR = [
	{ selector: /^\.scope-chip-caret\b/, why: 'a ▾ glyph' },
	{ selector: /^\.btn-icon\b/, why: 'a ❚❚ / ▶ glyph' },
	{ selector: /^\.check-mark\b/, why: 'a ✓ glyph' },
	{ selector: /^\.wfc-/, why: 'workflow canvas node internals' },
];

function selectorFor(source, pos) {
	const lineStart = source.lastIndexOf('\n', pos) + 1;
	const before = source.slice(lineStart, pos);
	if (before.includes('{')) return before.split('{')[0].trim();
	const open = source.lastIndexOf('{', pos);
	return source.slice(source.lastIndexOf('\n', open) + 1, open).trim();
}

describe('12px type floor', () => {
	it('has no font-size under 12px in either page, the spatial modules or the shared switch, apart from the listed glyphs', () => {
		const offenders = [];
		for (const file of sources) {
			const source = read(file);
			for (const m of source.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|rem|em)/g)) {
				const px = parseFloat(m[1]) * (m[2] === 'px' ? 1 : 16);
				if (px >= 12) continue;
				const selector = selectorFor(source, m.index);
				if (ALLOWED_UNDER_FLOOR.some((a) => a.selector.test(selector))) continue;
				offenders.push(file + ': ' + selector.slice(0, 50) + ' { ' + m[0] + ' }');
			}
		}
		expect(offenders).toEqual([]);
	});

	it('keeps the thumb wheel labels at 12px and its View band tall enough for them', () => {
		const wheel = read('public/js/spatial/thumb-wheel.js');
		expect(wheel).toMatch(/const FONT = \{ view: 12, primary: 12, inner: 12 \};/);
		expect(wheel).toMatch(/const WIDTH = \{ view: 26,/);
	});
});

describe('contrast (WCAG AA, 4.5:1 for text)', () => {
	const space = read('src/index.js');
	const token = (name) => new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(space)[1];

	it('Space text and muted text read on its page and panel grounds', () => {
		for (const ground of ['bg-page', 'bg-panel']) {
			expect(contrast(token('text'), token(ground)), 'text on ' + ground).toBeGreaterThanOrEqual(4.5);
			expect(contrast(token('text-muted'), token(ground)), 'text-muted on ' + ground).toBeGreaterThanOrEqual(4.5);
			expect(contrast(token('accent'), token(ground)), 'accent on ' + ground).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrast(token('on-accent'), token('accent'))).toBeGreaterThanOrEqual(4.5);
	});

	it("the 3D graph library's navigation hint is raised to the muted token at the type floor", () => {
		expect(space).toMatch(/body \.scene-nav-info \{ font-size: 12px; color: var\(--text-muted\); opacity: 1; \}/);
	});

	it('the thumb wheel labels and the active label read on every band', () => {
		const { TEXT, ACCENT, HUB_TEXT, FILL } = WHEEL_COLORS;
		for (const [name, fill] of [['view', FILL.view], ['primary', FILL.primary], ['inner 1', FILL.inner[0]], ['inner 2', FILL.inner[1]]]) {
			expect(contrast(TEXT, fill), 'label on ' + name).toBeGreaterThanOrEqual(4.5);
			expect(contrast(ACCENT, fill), 'active label on ' + name).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrast(HUB_TEXT, ACCENT)).toBeGreaterThanOrEqual(4.5);
	});

	it('the active label and the index mark are drawn in the full accent, and only labels past the edge fade', () => {
		const wheel = read('public/js/spatial/thumb-wheel.js');
		expect(wheel).toContain("text.setAttribute('fill', index === selected ? ACCENT : TEXT);");
		expect(wheel).toContain("const mark = el('path', { fill: ACCENT,");
		expect(space).not.toMatch(/thumb-wheel-mark[^}]*opacity/);
	});
});

describe('focus and touch targets in Space', () => {
	const space = read('src/index.js');

	it('gives every control the same full-accent 2px focus ring, which the older outline:none rules cannot remove', () => {
		expect(space).toMatch(/button:focus-visible, a\[href\]:focus-visible, \[role="button"\]:focus-visible, \[role="switch"\]:focus-visible[^{]*\{ outline: 2px solid var\(--accent\) !important; outline-offset: 2px !important; \}/);
		expect(space).toContain('.thumb-wheel-svg g:focus-visible path:first-child { stroke: var(--accent); stroke-width: 2; }');
		expect(space).toContain('#wheel-mode:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }');
		expect(space).not.toContain('stroke: var(--accent-line); }\n    /* The visual click');
	});

	it('pads the top bar buttons, the close buttons and small links to a 44px touch area, and sizes the inputs to it', () => {
		expect(space).toContain('#topbar .bar-btn::after { content: ""; position: absolute; inset: -8px -5px; }');
		expect(space).toMatch(/#node-card \.card-close, #cluster-drawer \.card-close, \.reader-panel \.card-close \{[^}]*min-width: 44px; min-height: 44px;/);
		expect(space).toMatch(/#command-input \{[^}]*height: 44px;/);
		expect(space).toMatch(/#command-mic \{[^}]*width: 44px;\s*height: 44px;/);
	});
});

describe('Space search field, announcements and focus traps', () => {
	const space = read('src/index.js');
	const wheel = read('public/js/spatial/thumb-wheel.js');

	it('wraps the 30px search field in a label that fills the bar, so the whole 44px height focuses it', () => {
		expect(space).toContain('<label class="search-wrap" for="search-input"><input type="text" id="search-input" placeholder="🔍 Search nodes..." aria-label="Search nodes"></label>');
		expect(space).toMatch(/#topbar \.search-wrap \{[^}]*margin: -1px auto -1px 0; align-self: stretch;/);
	});

	it('gives the + hub a transparent quarter-disc pad of at least 44px under its unchanged shape', () => {
		expect(wheel).toContain("const hubPad = el('path', { fill: 'transparent',");
		expect(wheel).toContain('hub.append(hubPad, hubShape, hubLabel);');
		expect(wheel).toContain("hubPad.setAttribute('d', bandPath(cx, cy, 0.01, hubHitRadius(hubRadius),");
		expect(wheel).toContain("hubShape.setAttribute('d', bandPath(cx, cy, 0.01, hubRadius,");
	});

	it('announces every change of mode: view, time range, zoom stop, flat board and connection depth', () => {
		expect(space).toContain("announceMode(VIEW_NAMES[view] + ' view');");
		expect(space).toContain("announceMode('Time range: ' + (SCOPE_LABELS[filterState.horizon] || 'All time') + ', ' + currentVisibleNodes.length + ' cards');");
		expect(space).toContain("announceMode('Zoom: ' + ZOOM_STOP_NAMES[next]);");
		expect(space).toContain("announceMode(filterState.flat ? 'Flat 2D board' : '3D Space');");
		expect(space).toContain("announceMode('Connection depth: ' + level);");
		expect(read('public/js/spatial/index.js')).toContain("import '../a11y.js';");
	});

	it('traps Tab in the menu tray and in the add, help and reader dialogs, and releases each when it closes', () => {
		for (const name of ['trayTrap', 'helpTrap', 'readerTrap', 'addNodeTrap']) {
			expect(space.includes(name + ' = window.AetherA11y.trapFocus('), name + ' taken').toBe(true);
			expect(space.includes(name + '.release('), name + ' released').toBe(true);
		}
		// The add dialog hands focus back to whatever opened it (it used to leave it on the page).
		expect(space).toContain('trapFocus(addNodeModal, { returnTo: opener })');
	});
});
