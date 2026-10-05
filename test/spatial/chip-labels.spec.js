import { describe, expect, it } from "vitest";
import { CHIP_HIDE_PX, CHIP_SHOW_PX, fitTitle, placeChips, wantsChip } from "../../public/js/spatial/chip-labels.js";

// Every character 7px wide.
const measure = (text) => text.length * 7;

describe("fitTitle", () => {
	it("keeps short titles and cuts long ones with an ellipsis to fit", () => {
		expect(fitTitle("Short title", measure, 200)).toBe("Short title");
		const cut = fitTitle("A very long title that will never fit on one small chip", measure, 140);
		expect(cut.endsWith("…")).toBe(true);
		expect(measure(cut)).toBeLessThanOrEqual(140);
		expect(fitTitle("   ", measure)).toBe("Untitled");
	});
});

describe("placeChips", () => {
	const chip = (id, x, y, priority) => ({ id, x, y, width: 100, height: 24, priority });

	it("keeps the most important chip where two overlap, and all that have room", () => {
		const kept = placeChips([chip("low", 100, 100, 1), chip("high", 130, 105, 5), chip("apart", 400, 100, 0)]);
		expect([...kept].sort()).toEqual(["apart", "high"]);
	});

	it("keeps a gap between chips", () => {
		expect(placeChips([chip("a", 0, 0, 2), chip("b", 102, 0, 1)]).has("b")).toBe(false);
		expect(placeChips([chip("a", 0, 0, 2), chip("b", 120, 0, 1)]).has("b")).toBe(true);
	});
});

describe("wantsChip", () => {
	it("switches on below the show width and off only above the hide width", () => {
		expect(wantsChip(CHIP_SHOW_PX - 1, false)).toBe(true);
		expect(wantsChip(CHIP_SHOW_PX + 5, false)).toBe(false);
		expect(wantsChip(CHIP_SHOW_PX + 5, true)).toBe(true);
		expect(wantsChip(CHIP_HIDE_PX + 1, true)).toBe(false);
	});
});
