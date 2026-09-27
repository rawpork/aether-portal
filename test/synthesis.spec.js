import { describe, it, expect } from "vitest";
import {
	OUTCOME_TEMPLATES,
	buildSynthesisPrompt,
	findCandidateBundles,
	fingerprint,
	parseSynthesisResponse,
	readPlan,
	toBlueprint,
	topicFamily,
} from "../src/synthesis.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const daysAgo = n => new Date(NOW - n * 24 * 3600 * 1000).toISOString();
const node = (id, family, age = 1, extra = {}) => ({ id, created_at: daysAgo(age), category: "link", group_id: family, ...extra });

// Three topic families (AI video, SEO, lead gen) wired together, plus an unrelated same-family pair.
const nodes = [
	node("v1", "g_video"), node("v2", "g_video"), node("s1", "g_seo"), node("s2", "g_seo"), node("l1", "g_leads"),
	node("x1", "g_cooking"), node("x2", "g_cooking"), node("old", "g_seo", 90), node("o1", null, 1, { category: "outcome" }),
];
const links = [
	{ source: "v1", target: "s1", type: "ai" }, { source: "s1", target: "l1", type: "ai" }, { source: "v2", target: "v1", type: "concept" },
	{ source: "s2", target: "s1", type: "semantic" }, { source: "x1", target: "x2", type: "ai" }, { source: "x2", target: { id: "x1" }, type: "ai" },
	{ source: "old", target: "s1", type: "ai" }, { source: "o1", target: "v1", type: "synthesis" }, { source: "v1", target: "l1", type: "category" },
];

describe("fingerprint", () => {
	it("ignores order and duplicates", () => {
		expect(fingerprint(["b", "a", "a"])).toBe(fingerprint(["a", "b"]));
		expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["a", "c"]));
	});
});

describe("topicFamily", () => {
	it("prefers the group, then the strongest tag, then the category", () => {
		expect(topicFamily({ group_id: "g1" })).toBe("group:g1");
		expect(topicFamily({ tags: [{ tag: "seo", source: "miner", weight: 0.5 }, { tag: "anki", source: "user" }] })).toBe("tag:anki");
		expect(topicFamily({ category: "video" })).toBe("category:video");
	});
});

describe("findCandidateBundles", () => {
	it("finds a recent cross-topic bundle and skips single-topic, old and outcome nodes", () => {
		const bundles = findCandidateBundles(nodes, links, { now: NOW });
		expect(bundles.length).toBeGreaterThan(0);
		const best = bundles[0];
		expect(new Set(best.ids)).toEqual(new Set(["v1", "v2", "s1", "s2", "l1"]));
		expect(best.families.length).toBe(3);
		expect(bundles.every(bundle => !bundle.ids.includes("old") && !bundle.ids.includes("o1") && !bundle.ids.includes("x1"))).toBe(true);
	});

	it("drops bundles that mostly repeat an existing or dismissed outcome", () => {
		const bundles = findCandidateBundles(nodes, links, { now: NOW, previous: [["v1", "s1", "l1", "v2"]] });
		expect(bundles).toEqual([]);
	});

	it("needs at least three connected saves", () => {
		expect(findCandidateBundles(nodes.slice(0, 2), [{ source: "v1", target: "v2", type: "ai" }], { now: NOW })).toEqual([]);
	});
});

describe("buildSynthesisPrompt", () => {
	it("numbers items per bundle, lists templates and asks for citations", () => {
		const bundles = findCandidateBundles(nodes, links, { now: NOW });
		const byId = new Map(nodes.map(n => [n.id, { title: "Title " + n.id, url: "https://" + n.id + ".test", category: n.category, tags: [{ tag: "seo" }] }]));
		const prompt = buildSynthesisPrompt(bundles, byId, key => key.replace("group:", ""));
		expect(prompt).toContain("Bundle 0 (spans:");
		expect(prompt).toMatch(/\[0\] \(link\) Title \w+ \| https:\/\/\w+\.test #seo/);
		for (const key of Object.keys(OUTCOME_TEMPLATES)) expect(prompt).toContain(key);
		expect(prompt).toContain("must cite");
	});
});

describe("parseSynthesisResponse", () => {
	const bundles = [{ ids: ["a", "b", "c"], fingerprint: "fp_1" }, { ids: ["d", "e", "f"], fingerprint: "fp_2" }];
	const step = (inputs, title = "Step") => ({ title, detail: "Do it", inputs });
	const good = { bundle: 0, template: "content_creation", title: " Launch a funnel ", why: "Pattern", goal: "Goal", effort: "2 weekends", steps: [step([0]), step([1, 2]), step([0, 0, 9])] };

	it("keeps a valid outcome and resolves cited indexes to node ids", () => {
		const [outcome] = parseSynthesisResponse({ outcomes: [good] }, bundles);
		expect(outcome).toMatchObject({ bundle: 0, template: "content_creation", title: "Launch a funnel", fingerprint: "fp_1", inputIds: ["a", "b", "c"] });
		expect(outcome.steps.map(s => s.inputs)).toEqual([["a"], ["b", "c"], ["a"]]);
	});

	it("drops uncited steps, unknown templates, bad bundles, too few steps and repeats", () => {
		const bad = [
			{ ...good, steps: [step([0]), step([]), step([1])] },
			{ ...good, template: "tiktok_dance" },
			{ ...good, bundle: 7 },
			{ ...good, steps: [step([0]), step([1])] },
			{ ...good, title: "   " },
		];
		expect(parseSynthesisResponse({ outcomes: bad }, bundles)).toEqual([]);
		expect(parseSynthesisResponse({ outcomes: [good, good] }, bundles)).toHaveLength(1);
		expect(parseSynthesisResponse(null, bundles)).toEqual([]);
	});

	it("caps the number of outcomes", () => {
		const three = [good, { ...good, bundle: 1 }, { ...good, bundle: 1 }];
		expect(parseSynthesisResponse({ outcomes: three }, bundles)).toHaveLength(2);
	});
});

describe("readPlan and toBlueprint", () => {
	it("round-trips a plan into an aether.blueprint/1 package with resolved sources", () => {
		const plan = readPlan(JSON.stringify({ template: "sop_creation", goal: "G", why: "W", effort: "E", steps: [{ title: "One", detail: "D", inputs: ["a", "n"] }] }));
		const sources = new Map([["a", { title: "Article", url: "https://a.test" }], ["n", { title: "My note", url: "just text" }]]);
		const blueprint = toBlueprint({ id: "node_1", title: "Plan", created_at: "2026-09-27T00:00:00Z" }, plan, sources);
		expect(blueprint).toMatchObject({ schema: "aether.blueprint/1", template: "sop_creation", template_label: OUTCOME_TEMPLATES.sop_creation, title: "Plan", goal: "G", outcome_id: "node_1" });
		expect(blueprint.steps[0]).toEqual({ n: 1, title: "One", detail: "D", sources: [{ id: "a", title: "Article", url: "https://a.test" }, { id: "n", title: "My note", url: null }] });
	});

	it("tolerates damaged plans", () => {
		expect(readPlan("{nope")).toBeNull();
		expect(readPlan(null)).toBeNull();
	});
});
