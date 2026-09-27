import { describe, expect, it } from "vitest";
import { TOKEN_DEFAULTS, readTokens } from "../../public/js/spatial/tokens.js";

describe("readTokens", () => {
	it("reads and trims CSS custom properties", () => {
		const css = { "--accent": " #00ffcc ", "--bg-page": "#080c14" };
		const tokens = readTokens(name => css[name] || "");
		expect(tokens.accent).toBe("#00ffcc");
		expect(tokens.bgPage).toBe("#080c14");
		expect(tokens.hairlineAlpha).toBe(0.08);
	});

	it("falls back to the defaults for missing or failing variables", () => {
		expect(readTokens(() => "")).toMatchObject(TOKEN_DEFAULTS);
		expect(readTokens(() => { throw new Error("no style"); }).accent).toBe(TOKEN_DEFAULTS.accent);
	});
});
