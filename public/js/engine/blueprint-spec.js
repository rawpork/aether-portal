// Blueprint spec parsing and validation for Mission Control's ingestion form, plus helpers that turn a compiled
// blueprint into its route matrix and into sub-agent task steps. Validation mirrors the engine's data contract,
// Aether_Engine/blueprint_schema.json#/definitions/compile_request; the engine re-validates every compile.

export const MAX_SPEC_BYTES = 256 * 1024;

const KNOWN_KEYS = ['links', 'projectName', 'creator', 'lodLevel', 'useMiserlyProxy', 'interviewResponses'];
const INTERVIEW_KEYS = ['database', 'hosting', 'miserlyBudgetCapUsd', 'unresolvedConnectors'];

export const EXAMPLE_SPEC = {
  projectName: 'Aether Knowledge Sync',
  lodLevel: 2,
  useMiserlyProxy: true,
  links: [
    { url: 'https://developers.cloudflare.com/d1/', title: 'Cloudflare D1', rawSnippet: 'Serverless SQLite at the edge.' },
    { url: 'https://supabase.com/docs/guides/auth/jwts', title: 'Supabase JWTs' },
  ],
  interviewResponses: {
    database: 'cloudflare_d1',
    hosting: 'cloudflare_workers',
    miserlyBudgetCapUsd: 2.5,
    unresolvedConnectors: ['telegram_bot'],
  },
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Index of the first JSON syntax error in text (after JSON.parse has already failed). Browsers word and position
// their JSON.parse errors differently (recent V8 gives no position at all), so the editor finds it itself.
export function findJsonErrorIndex(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const fail = () => {
    throw i;
  };
  const literal = (word) => (text.startsWith(word, i) ? (i += word.length) : fail());
  function string() {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === '"') return i++;
      if (c < ' ') fail();
      if (c === '\\') {
        i++;
        if (text[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
          i += 5;
        } else if ('"\\/bfnrt'.includes(text[i]) && i < text.length) i++;
        else fail();
      } else i++;
    }
    fail();
  }
  function number() {
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!match || !match[0] || match[0] === '-') fail();
    i += match[0].length;
  }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ':') fail();
        i++;
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return i++;
        else fail();
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return i++;
        else fail();
      }
    }
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    return number();
  }
  try {
    value();
    ws();
    return i < text.length ? i : -1;
  } catch (index) {
    return typeof index === 'number' ? Math.min(index, text.length) : -1;
  }
}

function describeJsonError(text, error) {
  const index = findJsonErrorIndex(text);
  if (index < 0) return 'Invalid JSON: ' + String((error && error.message) || error);
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return index >= text.length ? 'Invalid JSON: it ends early (line ' + line + ', column ' + column + ').' : 'Invalid JSON at line ' + line + ', column ' + column + '.';
}

// Validates a compile_request object. Returns { errors, warnings }, each [{ path, message }] with JSON-pointer paths
// like the engine's validation_errors.
export function validateCompileRequest(spec) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isPlainObject(spec)) {
    err('/', 'must be a JSON object');
    return { errors, warnings };
  }

  if (!('links' in spec)) err('/', "must have required property 'links'");
  else if (!Array.isArray(spec.links)) err('/links', 'must be an array');
  else if (spec.links.length === 0) err('/links', 'must NOT have fewer than 1 items');
  else {
    spec.links.forEach((link, i) => {
      const at = '/links/' + i;
      if (!isPlainObject(link)) return err(at, 'must be an object');
      if (!('url' in link)) err(at, "must have required property 'url'");
      else if (typeof link.url !== 'string') err(at + '/url', 'must be string');
      else if (!link.url.length) err(at + '/url', 'must NOT have fewer than 1 characters');
      else if (!/^https?:\/\//i.test(link.url)) warn(at + '/url', 'is not an http(s) URL; the compiler will keep it as written');
      for (const key of ['title', 'rawSnippet']) {
        if (key in link && typeof link[key] !== 'string') err(at + '/' + key, 'must be string');
      }
    });
  }

  for (const key of ['projectName', 'creator']) {
    if (key in spec && typeof spec[key] !== 'string') err('/' + key, 'must be string');
  }
  if ('lodLevel' in spec) {
    if (!Number.isInteger(spec.lodLevel)) err('/lodLevel', 'must be integer');
    else if (spec.lodLevel < 1) err('/lodLevel', 'must be >= 1');
  }
  if ('useMiserlyProxy' in spec && typeof spec.useMiserlyProxy !== 'boolean') err('/useMiserlyProxy', 'must be boolean');

  if ('interviewResponses' in spec) {
    const ir = spec.interviewResponses;
    if (!isPlainObject(ir)) err('/interviewResponses', 'must be object');
    else {
      for (const key of ['database', 'hosting']) {
        if (key in ir && typeof ir[key] !== 'string') err('/interviewResponses/' + key, 'must be string');
      }
      if ('miserlyBudgetCapUsd' in ir) {
        if (typeof ir.miserlyBudgetCapUsd !== 'number' || !Number.isFinite(ir.miserlyBudgetCapUsd)) err('/interviewResponses/miserlyBudgetCapUsd', 'must be number');
        else if (ir.miserlyBudgetCapUsd < 0) err('/interviewResponses/miserlyBudgetCapUsd', 'must be >= 0');
      }
      if ('unresolvedConnectors' in ir) {
        if (!Array.isArray(ir.unresolvedConnectors)) err('/interviewResponses/unresolvedConnectors', 'must be array');
        else ir.unresolvedConnectors.forEach((c, i) => typeof c !== 'string' && err('/interviewResponses/unresolvedConnectors/' + i, 'must be string'));
      }
      for (const key of Object.keys(ir)) {
        if (!INTERVIEW_KEYS.includes(key)) warn('/interviewResponses/' + key, 'is not part of the spec and will be ignored');
      }
    }
  }

  for (const key of Object.keys(spec)) {
    if (!KNOWN_KEYS.includes(key)) warn('/' + key, 'is not part of the spec and will be ignored');
  }
  if (!('projectName' in spec)) warn('/projectName', 'is missing; the engine will name it "Untitled Aether Project"');
  return { errors, warnings };
}

// Parses pasted or uploaded text into a compile_request.
// Returns { ok, spec, errors, warnings, notes }: notes describe conveniences applied (a bare list of links, or links
// given as plain URL strings, are accepted and normalized).
export function parseBlueprintSpec(text) {
  const notes = [];
  const source = String(text || '');
  if (!source.trim()) return { ok: false, spec: null, errors: [{ path: '/', message: 'Paste or upload a blueprint spec (JSON).' }], warnings: [], notes };
  if (new TextEncoder().encode(source).length > MAX_SPEC_BYTES) {
    return { ok: false, spec: null, errors: [{ path: '/', message: 'Spec is larger than ' + MAX_SPEC_BYTES / 1024 + ' KB.' }], warnings: [], notes };
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { ok: false, spec: null, errors: [{ path: '/', message: describeJsonError(source, error) }], warnings: [], notes };
  }

  if (isPlainObject(value) && typeof value.blueprint_id === 'string' && Array.isArray(value.execution_phases)) {
    return {
      ok: false,
      spec: null,
      errors: [{ path: '/', message: 'This is an already compiled blueprint (' + value.blueprint_id + '), not a spec. Compiled blueprints are listed under Artifacts.' }],
      warnings: [],
      notes,
    };
  }

  if (isPlainObject(value) && value.schema === OUTCOME_BLUEPRINT_SCHEMA) {
    const converted = outcomeToCompileRequest(value);
    if (!converted.spec.links.length) {
      return {
        ok: false,
        spec: null,
        errors: [{ path: '/steps', message: 'This outcome blueprint has no linked sources. The engine compiles from links; add a saved link to the outcome first.' }],
        warnings: converted.warnings,
        notes,
      };
    }
    notes.push('Converted the portal outcome blueprint "' + converted.spec.projectName + '" (' + OUTCOME_BLUEPRINT_SCHEMA + ') into an engine spec.');
    const { errors, warnings } = validateCompileRequest(converted.spec);
    return { ok: errors.length === 0, spec: converted.spec, errors, warnings: [...converted.warnings, ...warnings], notes };
  }

  if (Array.isArray(value)) {
    value = { links: value };
    notes.push('Treated the top-level list as "links".');
  }
  if (isPlainObject(value) && Array.isArray(value.links) && value.links.some((l) => typeof l === 'string')) {
    value = { ...value, links: value.links.map((l) => (typeof l === 'string' ? { url: l } : l)) };
    notes.push('Turned plain URL strings into { "url": ... } links.');
  }

  const { errors, warnings } = validateCompileRequest(value);
  return { ok: errors.length === 0, spec: value, errors, warnings, notes };
}

// The main portal's outcome blueprints (Export blueprint / GET /api/outcome/<id>/blueprint) use their own format:
// a plan of steps whose sources are saved nodes. The engine compiles from links, so each linked source becomes a
// link (deduplicated) and its step titles become the snippet; saved notes without a link are reported, not sent.
export const OUTCOME_BLUEPRINT_SCHEMA = 'aether.blueprint/1';

export function outcomeToCompileRequest(outcome) {
  const links = new Map();
  let unlinked = 0;
  for (const step of Array.isArray(outcome.steps) ? outcome.steps : []) {
    for (const source of Array.isArray(step.sources) ? step.sources : []) {
      if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) {
        unlinked++;
        continue;
      }
      const link = links.get(source.url) || { url: source.url, title: source.title || source.url, steps: [] };
      link.steps.push('Step ' + step.n + ': ' + step.title);
      links.set(source.url, link);
    }
  }
  const warnings = [];
  if (unlinked) warnings.push({ path: '/steps', message: unlinked + (unlinked === 1 ? ' saved note has' : ' saved notes have') + ' no link and will not be sent' });
  return {
    spec: {
      projectName: String(outcome.title || 'Untitled outcome'),
      links: [...links.values()].map((l) => ({ url: l.url, title: l.title, rawSnippet: [outcome.goal, ...l.steps].filter(Boolean).join(' · ') })),
    },
    warnings,
  };
}

// Rows for the route matrix: how each execution phase is routed (agent role, MCP tools, model route and budget).
export function routeMatrix(blueprint) {
  const miserly = blueprint.miserly_integration || {};
  const route = miserly.enabled ? 'Miserly.io proxy' : 'Direct (no proxy)';
  return [...(blueprint.execution_phases || [])]
    .sort((a, b) => a.phase_index - b.phase_index)
    .map((phase) => ({
      phase: phase.phase_index,
      name: phase.phase_name,
      role: phase.agent_role,
      tools: phase.required_mcp_tools || [],
      route,
      endpoint: miserly.enabled ? miserly.proxy_endpoint || '' : '',
      budget: miserly.enabled ? miserly.budget_cap_usd : null,
    }));
}

// Deploy & Execute: one prompt step per execution phase, carrying the phase and blueprint context, run as a
// sub-agent task loop (so the breaker guards every phase and the monitor shows its progress).
export function blueprintToTaskSteps(blueprint) {
  return [...(blueprint.execution_phases || [])]
    .sort((a, b) => a.phase_index - b.phase_index)
    .map((phase) => ({
      step_id: 'phase-' + phase.phase_index,
      action: 'prompt',
      params: {
        prompt: phase.prompt_template,
        context: {
          blueprint_id: blueprint.blueprint_id,
          project_name: blueprint.project_name,
          phase_index: phase.phase_index,
          phase_name: phase.phase_name,
          agent_role: phase.agent_role,
          required_mcp_tools: phase.required_mcp_tools || [],
          sources: (blueprint.sources || []).map((s) => ({ url: s.url, summary: s.scraped_summary })),
        },
      },
    }));
}

export const isProTier = (tier) => String(tier || '').toLowerCase() === 'pro';
