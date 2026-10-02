import { describe, expect, it } from 'vitest';
import { makeQrMatrix, renderQrSvg } from '../../src/services/qr.ts';

const LINK = 'https://lingering-water-de49.klo377.workers.dev/mission-control?engine=https%3A%2F%2Foptimum-ind-tablet-jeremy.trycloudflare.com#connect';

describe('qr', () => {
	it('builds a valid QR matrix with the three finder patterns', () => {
		const m = makeQrMatrix(LINK);
		// Version is chosen automatically; sizes are 17 + 4 * version.
		expect((m.size - 17) % 4).toBe(0);
		expect(m.size).toBeGreaterThanOrEqual(41);
		// Finder patterns: dark 7x7 ring with a light separator, at three corners.
		for (const [r, c] of [
			[0, 0],
			[0, m.size - 7],
			[m.size - 7, 0],
		]) {
			expect(m.isDark(r, c)).toBe(true);
			expect(m.isDark(r + 6, c + 6)).toBe(true);
			expect(m.isDark(r + 3, c + 3)).toBe(true);
			expect(m.isDark(r + 1, c + 1)).toBe(false);
		}
		// The fourth corner has no finder pattern.
		expect(m.isDark(m.size - 2, m.size - 2) && m.isDark(m.size - 6, m.size - 6) && !m.isDark(m.size - 7, m.size - 7)).toBe(false);
	});

	it('renders a crisp SVG with a white quiet zone and an accessible label', () => {
		const svg = renderQrSvg(LINK, { label: 'Pair "phone" & tablet' });
		const size = makeQrMatrix(LINK).size + 8;
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '"')).toBe(true);
		expect(svg).toContain('shape-rendering="crispEdges"');
		expect(svg).toContain('aria-label="Pair &quot;phone&quot; &amp; tablet"');
		expect(svg).toContain('<rect width="' + size + '" height="' + size + '" fill="#ffffff"/>');
		// First dark module drawn at the quiet-zone offset.
		expect(svg).toContain('<path d="M4 4h1v1h-1z');
		expect(svg).not.toContain(LINK);
	});

	it('is deterministic', () => {
		expect(renderQrSvg('hello')).toBe(renderQrSvg('hello'));
		expect(renderQrSvg('hello')).not.toBe(renderQrSvg('hello!'));
	});
});
