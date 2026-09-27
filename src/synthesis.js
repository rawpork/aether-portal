// Agentic Synthesis Engine (SPATIAL_ARCHITECTURE.md section 8, D10): finds high-value cross-topic patterns in a user's
// recent saves and turns the best into Outcome Nodes, cited step-by-step plans (Input A + Input B -> Outcome C).
// Everything here is pure; src/index.js does the D1 reads and writes and the Gemini call.

export const OUTCOME_CATEGORY = "outcome";
export const OUTCOME_STATUSES = ["proposed", "accepted", "dismissed", "sent"];
// Blueprint template types (TODO.md "Blueprint Clusters"); the synthesis call must pick one.
export const OUTCOME_TEMPLATES = {
  project_setup: "Project Setup (architecture, DB schema, UI)",
  sop_creation: "SOP Creation (standard operating procedures)",
  content_creation: "Content Creation (video scripts, descriptions, physical asset specs)",
  ad_creation: "Ad Creation",
  website_creation: "Website Creation"
};

export const SYNTHESIS_WINDOW_DAYS = 60;
export const MAX_OUTCOMES_PER_DAY = 2;
const MAX_CANDIDATES = 8;
const BUNDLE_MIN = 3;
const BUNDLE_MAX = 12;
const MIN_FAMILIES = 2;
const MAX_FAMILIES_COUNTED = 4;
const RECENCY_HALF_LIFE_DAYS = 14;
const NOVELTY_OVERLAP = 0.6;
export const MIN_CANDIDATE_SCORE = 0.08;
const LINK_WEIGHTS = { ai: 1, concept: 0.6, semantic: 0.5 };
const DAY_MS = 24 * 60 * 60 * 1000;
const TEXT_LIMITS = { title: 120, why: 300, goal: 300, effort: 60, stepTitle: 120, stepDetail: 600 };
const STEPS_MIN = 3;
const STEPS_MAX = 10;
const ITEM_TEXT_MAX = 160;
const SNIPPET_MAX = 160;

const endId = end => String(end && typeof end === "object" ? end.id : end);
const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// FNV-1a over the sorted ids: a stable fingerprint of an input set, for novelty and dismiss memory.
export function fingerprint(ids) {
  let hash = 0x811c9dc5;
  for (const ch of [...new Set(ids.map(String))].sort().join("|")) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return "fp_" + hash.toString(16).padStart(8, "0");
}

// A node's topic family: its group, else its strongest tag, else its category. Bundles must span several.
export function topicFamily(node) {
  if (node.group_id) return "group:" + node.group_id;
  const tags = Array.isArray(node.tags) ? [...node.tags] : [];
  tags.sort((a, b) => (b.source === "user" ? 1 : b.weight || 0) - (a.source === "user" ? 1 : a.weight || 0) || String(a.tag).localeCompare(String(b.tag)));
  if (tags.length) return "tag:" + tags[0].tag;
  return "category:" + String(node.category || "note");
}

const overlap = (a, b) => {
  const set = new Set(b);
  const shared = a.filter(id => set.has(id)).length;
  return shared / Math.max(1, Math.min(a.length, b.length));
};

// Candidate bundles for synthesis: connected sets of 3-12 recent saves (over ai, concept and semantic links) that span
// at least two topic families, scored by diversity x strength x recency x novelty; top 8 above the minimum score.
// nodes: [{ id, created_at, category, group_id, tags }]; links: [{ source, target, type }]; previous: arrays of
// input ids of existing or dismissed outcomes.
export function findCandidateBundles(nodes, links, { now = Date.now(), previous = [] } = {}) {
  const recent = new Map(nodes
    .filter(node => String(node.category) !== OUTCOME_CATEGORY)
    .filter(node => {
      const time = new Date(node.created_at || 0).getTime();
      return Number.isFinite(time) && now - time <= SYNTHESIS_WINDOW_DAYS * DAY_MS;
    })
    .map(node => [String(node.id), node]));
  const adjacency = new Map();
  for (const link of links) {
    const weight = LINK_WEIGHTS[link.type];
    if (!weight) continue;
    const a = endId(link.source);
    const b = endId(link.target);
    if (a === b || !recent.has(a) || !recent.has(b)) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!adjacency.has(from)) adjacency.set(from, new Map());
      adjacency.get(from).set(to, Math.max(weight, adjacency.get(from).get(to) || 0));
    }
  }
  const recency = id => 0.5 ** ((now - new Date(recent.get(id).created_at).getTime()) / DAY_MS / RECENCY_HALF_LIFE_DAYS);
  const seen = new Set();
  const candidates = [];
  // Grow a bundle from each seed, most recent first, always taking the strongest link out of the bundle next.
  const seeds = [...adjacency.keys()].sort((a, b) => recency(b) - recency(a) || a.localeCompare(b));
  for (const seed of seeds) {
    const members = [seed];
    const inBundle = new Set(members);
    while (members.length < BUNDLE_MAX) {
      let best = null;
      for (const id of members) {
        for (const [next, weight] of adjacency.get(id) || []) {
          if (inBundle.has(next)) continue;
          if (!best || weight > best.weight || (weight === best.weight && next < best.id)) best = { id: next, weight };
        }
      }
      if (!best) break;
      members.push(best.id);
      inBundle.add(best.id);
    }
    if (members.length < BUNDLE_MIN) continue;
    const key = fingerprint(members);
    if (seen.has(key)) continue;
    seen.add(key);
    const families = new Set(members.map(id => topicFamily(recent.get(id))));
    if (families.size < MIN_FAMILIES) continue;
    const weights = [];
    members.forEach(a => members.forEach(b => { if (a < b && adjacency.get(a)?.has(b)) weights.push(adjacency.get(a).get(b)); }));
    const strength = weights.reduce((sum, w) => sum + w, 0) / Math.max(1, weights.length);
    const fresh = members.reduce((sum, id) => sum + recency(id), 0) / members.length;
    const novelty = previous.some(ids => overlap(members, ids.map(String)) > NOVELTY_OVERLAP) ? 0 : 1;
    const diversity = Math.min(families.size, MAX_FAMILIES_COUNTED) / MAX_FAMILIES_COUNTED;
    const score = diversity * strength * fresh * novelty;
    if (score < MIN_CANDIDATE_SCORE) continue;
    candidates.push({ ids: members, families: [...families], score: Math.round(score * 1000) / 1000, fingerprint: key });
  }
  return candidates.sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint)).slice(0, MAX_CANDIDATES);
}

// One prompt for all candidate bundles. Items are numbered within each bundle so Gemini cites by index, never by id.
// nodeById maps an id to { title, url, category, snippet, tags }; familyLabel turns a family key into a readable name.
export function buildSynthesisPrompt(bundles, nodeById, familyLabel = key => key) {
  const lines = [];
  bundles.forEach((bundle, b) => {
    lines.push("", `Bundle ${b} (spans: ${bundle.families.map(familyLabel).join(", ")}):`);
    bundle.ids.forEach((id, i) => {
      const node = nodeById.get(id) || {};
      const title = clean(node.title, ITEM_TEXT_MAX);
      const url = /^https?:/i.test(String(node.url || "")) ? " | " + clean(node.url, 80) : "";
      const snippet = clean(node.snippet, SNIPPET_MAX);
      const tags = Array.isArray(node.tags) && node.tags.length ? " #" + node.tags.slice(0, 4).map(tag => tag.tag).join(" #") : "";
      lines.push(`  [${i}] (${node.category || "note"}) ${title}${url}${snippet ? " :: " + snippet : ""}${tags}`);
    });
  });
  return [
    "You are the synthesis layer of a personal knowledge graph. Each bundle below is a set of the user's own recent saves that are connected but come from different topics.",
    `Find at most ${MAX_OUTCOMES_PER_DAY} bundles where the saves genuinely combine into something the user could DO: a concrete, executable workflow or action plan (Input A + Input B -> Outcome C). Skip bundles that only share a theme; return no outcome at all rather than a weak one.`,
    `For each outcome pick one template: ${Object.entries(OUTCOME_TEMPLATES).map(([key, label]) => key + " (" + label + ")").join(", ")}.`,
    `Write ${STEPS_MIN}-${STEPS_MAX} steps. Every step must cite the numbers of the saves in that bundle it relies on. Use only what the saves say; do not invent tools, facts or numbers.`,
    'Return only valid JSON: {"outcomes":[{"bundle":0,"template":"content_creation","title":"...","why":"one sentence on the pattern you noticed","goal":"one sentence","steps":[{"title":"...","detail":"...","inputs":[0,2]}],"effort":"e.g. about 2 weekends"}]}',
    "Bundles:",
    ...lines
  ].join("\n");
}

// Validates Gemini's answer. Returns outcomes with steps citing node ids: [{ bundle, template, title, why, goal, effort,
// steps: [{ title, detail, inputs: [ids] }], inputIds, fingerprint }]. Anything malformed or uncited is dropped.
export function parseSynthesisResponse(parsed, bundles) {
  const outcomes = [];
  const used = new Set();
  for (const entry of Array.isArray(parsed?.outcomes) ? parsed.outcomes : []) {
    if (outcomes.length >= MAX_OUTCOMES_PER_DAY) break;
    const b = Number(entry?.bundle);
    if (!Number.isInteger(b) || b < 0 || b >= bundles.length || used.has(b)) continue;
    const template = String(entry?.template || "").trim().toLowerCase();
    if (!Object.hasOwn(OUTCOME_TEMPLATES, template)) continue;
    const title = clean(entry?.title, TEXT_LIMITS.title);
    if (!title) continue;
    const bundle = bundles[b];
    const steps = [];
    let valid = Array.isArray(entry?.steps);
    for (const step of valid ? entry.steps : []) {
      const stepTitle = clean(step?.title, TEXT_LIMITS.stepTitle);
      const cited = [...new Set((Array.isArray(step?.inputs) ? step.inputs : []).map(Number))]
        .filter(i => Number.isInteger(i) && i >= 0 && i < bundle.ids.length);
      if (!stepTitle || !cited.length) {
        valid = false;
        break;
      }
      steps.push({ title: stepTitle, detail: clean(step?.detail, TEXT_LIMITS.stepDetail), inputs: cited.map(i => bundle.ids[i]) });
    }
    if (!valid || steps.length < STEPS_MIN || steps.length > STEPS_MAX) continue;
    used.add(b);
    outcomes.push({
      bundle: b,
      template,
      title,
      why: clean(entry?.why, TEXT_LIMITS.why),
      goal: clean(entry?.goal, TEXT_LIMITS.goal),
      effort: clean(entry?.effort, TEXT_LIMITS.effort),
      steps,
      inputIds: bundle.ids,
      fingerprint: bundle.fingerprint
    });
  }
  return outcomes;
}

// Parses a stored plan, tolerating older or damaged rows.
export function readPlan(value) {
  try {
    const plan = typeof value === "string" ? JSON.parse(value) : value;
    if (!plan || typeof plan !== "object") return null;
    return {
      template: String(plan.template || ""),
      goal: String(plan.goal || ""),
      why: String(plan.why || ""),
      effort: String(plan.effort || ""),
      steps: (Array.isArray(plan.steps) ? plan.steps : []).map(step => ({
        title: String(step?.title || ""),
        detail: String(step?.detail || ""),
        inputs: (Array.isArray(step?.inputs) ? step.inputs : []).map(String)
      }))
    };
  } catch {
    return null;
  }
}

// The Finish Line export (section 8.6): a versioned blueprint with every step's sources resolved to titles and URLs.
// sourceById maps a node id to { title, url }.
export function toBlueprint(outcome, plan, sourceById) {
  const source = id => {
    const node = sourceById.get(String(id)) || {};
    const url = /^https?:/i.test(String(node.url || "")) ? String(node.url) : null;
    return { id: String(id), title: String(node.title || "Saved note"), url };
  };
  return {
    schema: "aether.blueprint/1",
    template: plan?.template || null,
    template_label: OUTCOME_TEMPLATES[plan?.template] || null,
    title: String(outcome.title || ""),
    goal: plan?.goal || "",
    why: plan?.why || "",
    effort: plan?.effort || "",
    steps: (plan?.steps || []).map((step, index) => ({ n: index + 1, title: step.title, detail: step.detail, sources: step.inputs.map(source) })),
    created: outcome.created_at || null,
    outcome_id: String(outcome.id)
  };
}
