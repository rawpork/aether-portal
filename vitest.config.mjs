import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			// Worker code, run inside workerd with the D1 binding from wrangler.jsonc.
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
					}),
				],
				test: { name: "worker", include: ["test/*.spec.js"] },
			},
			// Browser-side spatial modules (public/js/spatial/): pure functions, run in plain Node.
			{
				test: { name: "spatial", environment: "node", include: ["test/spatial/**/*.spec.js"] },
			},
		],
	},
});
