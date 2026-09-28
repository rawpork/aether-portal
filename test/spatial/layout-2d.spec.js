import { describe, expect, it } from "vitest";
import { boardLayout, columnAt } from "../../public/js/spatial/layout-2d.js";

const size = { cardWidth: 12, cardHeight: 7.5 };

describe("boardLayout", () => {
	it("makes one column per group, largest first, cards ordered by status then newest", () => {
		const layout = boardLayout(
			[
				{ id: "a", key: "group:1", label: "Alpha", status: "done", created: "2026-09-01" },
				{ id: "b", key: "group:1", label: "Alpha", status: "inbox", created: "2026-09-02" },
				{ id: "c", key: "group:1", label: "Alpha", status: "inbox", created: "2026-09-05" },
				{ id: "d", key: "category:note", label: "note", status: "active", created: "2026-09-03" }
			],
			size
		);
		expect(layout.columns.map(column => [column.key, column.count])).toEqual([["group:1", 3], ["category:note", 1]]);
		const ys = ["c", "b", "a"].map(id => layout.slots.get(id).y);
		expect(ys[0]).toBeGreaterThan(ys[1]);
		expect(ys[1]).toBeGreaterThan(ys[2]);
		expect(layout.slots.get("c").x).toBe(layout.slots.get("a").x);
		expect(layout.slots.get("d").x).toBeGreaterThan(layout.slots.get("a").x);
		layout.slots.forEach(slot => expect(slot.z).toBe(0));
	});

	it("centres the board on the origin", () => {
		const items = Array.from({ length: 5 }, (_, i) => ({ id: "n" + i, key: "k" + (i % 2), label: "k" + (i % 2) }));
		const layout = boardLayout(items, size);
		const first = layout.columns[0];
		const last = layout.columns[layout.columns.length - 1];
		expect(first.left + last.right).toBeCloseTo(0, 6);
		const ys = [...layout.slots.values()].map(slot => slot.y);
		expect(Math.max(...ys) + size.cardHeight / 2 + Math.min(...ys) - size.cardHeight / 2).toBeLessThanOrEqual(layout.height);
		expect(first.headerY).toBeGreaterThan(Math.max(...ys));
	});

	it("wraps a tall column into sub-columns beside it", () => {
		const items = Array.from({ length: 15 }, (_, i) => ({ id: "n" + i, key: "big", label: "Big", created: String(1100 - i) }));
		const layout = boardLayout(items, { ...size, maxRows: 12 });
		expect(layout.columns[0].subColumns).toBe(2);
		expect(layout.slots.get("n12").x).toBeGreaterThan(layout.slots.get("n0").x);
		expect(layout.slots.get("n12").y).toBe(layout.slots.get("n0").y);
	});
});

describe("boardLayout with fixed columns", () => {
	it("keeps the given order and empty columns", () => {
		const layout = boardLayout(
			[
				{ id: "a", key: "done", label: "Done" },
				{ id: "b", key: "done", label: "Done" },
				{ id: "c", key: "inbox", label: "Inbox" }
			],
			{ ...size, columns: [{ key: "inbox", label: "Inbox" }, { key: "active", label: "Active" }, { key: "done", label: "Done" }] }
		);
		expect(layout.columns.map(column => [column.key, column.count])).toEqual([["inbox", 1], ["active", 0], ["done", 2]]);
		expect(layout.columns[1].bottom).toBeLessThan(layout.columns[1].headerY);
	});
});

describe("columnAt", () => {
	it("finds the column under an x position, or the nearest one", () => {
		const layout = boardLayout(
			[
				{ id: "a", key: "one", label: "one" },
				{ id: "b", key: "one", label: "one" },
				{ id: "c", key: "two", label: "two" }
			],
			size
		);
		expect(columnAt(layout, layout.slots.get("a").x).key).toBe("one");
		expect(columnAt(layout, layout.slots.get("c").x).key).toBe("two");
		expect(columnAt(layout, 1e6).key).toBe("two");
		expect(columnAt(layout, -1e6).key).toBe("one");
		expect(columnAt({ columns: [] }, 0)).toBe(null);
	});
});
