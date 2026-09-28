import { describe, expect, it } from "vitest";
import { PANEL_HEIGHT, PANEL_METRES_WIDE, PANEL_WIDTH, hitTest, layoutPanel } from "../../public/js/spatial/xr-panel.js";

const state = { view: "space", scopeLabel: "This week · 12", depth: "logical", platform: "all", passthrough: true, pinned: false };
const centre = button => ({ u: (button.x + button.w / 2) / PANEL_WIDTH, v: 1 - (button.y + button.h / 2) / PANEL_HEIGHT });

describe("layoutPanel", () => {
	it("lays out views, time, depth, platforms and actions inside the panel", () => {
		const { buttons } = layoutPanel(state);
		const ids = buttons.map(button => button.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ["view:space", "view:groups", "view:status", "view:map", "view:timeline", "view:gallery", "scope:narrow", "scope:widen", "depth:obvious", "depth:logical", "depth:abstract", "platform:all", "platform:youtube", "back", "recenter", "zoom-in", "zoom-out", "passthrough", "pin", "exit"]) {
			expect(ids).toContain(id);
		}
		buttons.forEach(button => {
			expect(button.x).toBeGreaterThanOrEqual(0);
			expect(button.y).toBeGreaterThanOrEqual(0);
			expect(button.x + button.w).toBeLessThanOrEqual(PANEL_WIDTH);
			expect(button.y + button.h).toBeLessThanOrEqual(PANEL_HEIGHT);
		});
	});

	it("marks the current view, depth and platform", () => {
		const active = layoutPanel({ ...state, view: "map", depth: "abstract", platform: "youtube" }).buttons.filter(b => b.active).map(b => b.id);
		expect(active).toEqual(expect.arrayContaining(["view:map", "depth:abstract", "platform:youtube", "passthrough"]));
		expect(active).not.toContain("view:space");
	});

	it("only offers the passthrough switch in mixed reality", () => {
		expect(layoutPanel({ ...state, passthrough: null }).buttons.map(b => b.id)).not.toContain("passthrough");
	});

	it("keeps buttons big enough to hit with a controller ray (at least 3 cm wide)", () => {
		const metresPerPixel = PANEL_METRES_WIDE / PANEL_WIDTH;
		layoutPanel(state).buttons.forEach(button => expect(button.w * metresPerPixel).toBeGreaterThanOrEqual(0.03));
	});
});

describe("hitTest", () => {
	it("finds each button from the centre of its face", () => {
		const layout = layoutPanel(state);
		layout.buttons.forEach(button => {
			const { u, v } = centre(button);
			expect(hitTest(layout, u, v)).toBe(button.id);
		});
	});

	it("returns null between buttons and off the panel", () => {
		const layout = layoutPanel(state);
		expect(hitTest(layout, 0.01, 0.99)).toBe(null);
		expect(hitTest(layout, 1.2, 0.5)).toBe(null);
		expect(hitTest(layout, NaN, 0.5)).toBe(null);
	});
});
