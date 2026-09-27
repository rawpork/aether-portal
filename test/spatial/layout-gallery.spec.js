import { describe, expect, it } from "vitest";
import { galleryLayout, slotToWorld, yawToward } from "../../public/js/spatial/layout-gallery.js";

const CARD = { cardWidth: 12, cardHeight: 7.5 };

describe("galleryLayout", () => {
	it("spreads one row across the half circle, symmetric about forward", () => {
		const { slots, radius, rows } = galleryLayout(5, CARD);
		expect(rows).toBe(1);
		const angles = slots.map(slot => slot.angle);
		expect(angles[0]).toBeCloseTo(-Math.PI / 2 + Math.PI / 10, 6);
		expect(angles[2]).toBeCloseTo(0, 6);
		expect(angles[4]).toBeCloseTo(-angles[0], 6);
		for (const slot of slots) {
			expect(Math.hypot(slot.local.x, slot.local.z)).toBeCloseTo(radius, 6);
			expect(slot.local.y).toBe(0);
		}
		expect(slots[2].local.z).toBeCloseTo(-radius, 6);
	});

	it("never lets neighbouring cards overlap", () => {
		const { slots, radius, perRow } = galleryLayout(9, CARD);
		const chord = 2 * radius * Math.sin(Math.PI / perRow / 2);
		expect(chord).toBeGreaterThanOrEqual(CARD.cardWidth * 0.99);
		expect(Math.hypot(slots[1].local.x - slots[0].local.x, slots[1].local.z - slots[0].local.z)).toBeCloseTo(chord, 6);
	});

	it("uses up to three rows centred on eye level, then pages", () => {
		const layout = galleryLayout(30, CARD);
		expect(layout).toMatchObject({ perRow: 9, rows: 3, pageSize: 27, pages: 2 });
		const firstPage = layout.slots.filter(slot => slot.page === 0);
		const ys = [...new Set(firstPage.map(slot => slot.local.y))];
		expect(ys).toHaveLength(3);
		expect(ys[0]).toBeCloseTo(-ys[2], 6);
		expect(layout.slots[29]).toMatchObject({ page: 1, row: 0 });
	});

	it("centres a partly filled last row", () => {
		const { slots } = galleryLayout(11, CARD);
		const lastRow = slots.filter(slot => slot.row === 1);
		expect(lastRow).toHaveLength(2);
		expect(lastRow[0].angle).toBeCloseTo(-lastRow[1].angle, 6);
	});

	it("respects radius limits", () => {
		expect(galleryLayout(2, { ...CARD, minRadius: 40 }).radius).toBe(40);
		expect(galleryLayout(9, { ...CARD, maxRadius: 10 }).radius).toBe(10);
	});
});

describe("slotToWorld", () => {
	it("places the middle slot straight ahead of the viewer, facing back at it", () => {
		const { slots, radius } = galleryLayout(3, CARD);
		const origin = { x: 10, y: 5, z: -3 };
		const ahead = slotToWorld(slots[1], origin, 0);
		expect(ahead.position.x).toBeCloseTo(10, 6);
		expect(ahead.position.z).toBeCloseTo(-3 - radius, 6);
		expect(ahead.rotationY).toBeCloseTo(0, 6);
		const turned = slotToWorld(slots[1], origin, Math.PI / 2);
		expect(turned.position.x).toBeCloseTo(10 + radius, 6);
		expect(turned.position.z).toBeCloseTo(-3, 6);
		expect(Math.abs(turned.rotationY)).toBeCloseTo(Math.PI / 2, 6);
	});

	it("puts the first slot on the viewer's left", () => {
		const { slots } = galleryLayout(3, CARD);
		expect(slotToWorld(slots[0], { x: 0, y: 0, z: 0 }, 0).position.x).toBeLessThan(0);
	});
});

describe("yawToward", () => {
	it("is 0 looking down -Z and a quarter turn looking down +X", () => {
		expect(yawToward({ x: 0, y: 0, z: 0 }, { x: 0, y: 9, z: -5 })).toBeCloseTo(0, 6);
		expect(yawToward({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 6);
	});
});
