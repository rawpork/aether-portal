// Blueprint spec parsing, validation (mirrors blueprint_schema.json#/definitions/compile_request) and the
// compiled-blueprint helpers.
import { describe, expect, it } from 'vitest';
import { EXAMPLE_SPEC, MAX_SPEC_BYTES, blueprintToTaskSteps, findJsonErrorIndex, isProTier, parseBlueprintSpec, routeMatrix, validateCompileRequest } from '../../public/js/engine/blueprint-spec.js';

const messages = (list) => list.map((e) => e.path + ' ' + e.message);

const COMPILED = {
  blueprint_id: 'bp_0a1b2c3d_1790000000000',
  project_name: 'Demo',
  status: 'APPROVED_FOR_EXECUTION',
  metadata: { creator: 'Kenneth Olson', lod_spatial_level: 2, created_at: '2026-10-01T12:00:00.000Z' },
  interview_responses: { database: 'local_sqlite', hosting: 'local_node', miserly_budget_cap_usd: 1, unresolved_connectors: [] },
  sources: [{ source_id: 'src_1_abc', url: 'https://a.test', scraped_summary: 'A', content_type: 'web_link' }],
  execution_phases: [
    { phase_index: 2, phase_name: 'Scaffold', agent_role: 'System Architect', required_mcp_tools: ['file_system_writer'], prompt_template: 'Build it.' },
    { phase_index: 1, phase_name: 'Ingest', agent_role: 'Data Synthesizer', required_mcp_tools: ['fetch_url_content', 'sanitize_text'], prompt_template: 'Read the sources.' },
  ],
  project_scaffold: [{ path: 'CLAUDE.md', template: 'claude_md_standard', required: true }],
  miserly_integration: { enabled: true, proxy_endpoint: 'https://miserly-io.klo377.workers.dev', budget_cap_usd: 1 },
};

describe('parseBlueprintSpec', () => {
  it('accepts the example spec with no problems', () => {
    const result = parseBlueprintSpec(JSON.stringify(EXAMPLE_SPEC));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.spec).toEqual(EXAMPLE_SPEC);
  });

  it('reports JSON syntax errors with line and column', () => {
    const result = parseBlueprintSpec('{\n  "links": [\n    { "url": "https://a.test" },\n  ]\n}');
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toBe('Invalid JSON at line 4, column 3.');
  });

  it('locates JSON errors itself, independent of the browser’s error wording', () => {
    const at = (text) => findJsonErrorIndex(text);
    expect(at('{"a": 1}')).toBe(-1);
    expect(at('{"a": [1, 2, {"b": "c\\n\\u00e9"}], "d": -1.5e3, "e": null}')).toBe(-1);
    // A raw newline inside a JSON string is invalid.
    expect(at('{"b": "c\nd"}')).toBe(8);
    expect(at('{"a": 1,}')).toBe(8);
    expect(at("{'a': 1}")).toBe(1);
    expect(at('{"a": tru}')).toBe(6);
    expect(at('{"a": "open')).toBe(11);
    expect(at('{"a": 01}')).toBe(7);
    expect(at('{"a": 1} x')).toBe(9);
  });

  it('rejects empty input and oversized specs', () => {
    expect(parseBlueprintSpec('   ').errors[0].message).toMatch(/Paste or upload/);
    expect(parseBlueprintSpec('"' + 'x'.repeat(MAX_SPEC_BYTES) + '"').errors[0].message).toMatch(/larger than 256 KB/);
  });

  it('normalizes a bare list of links and plain URL strings, saying so', () => {
    const result = parseBlueprintSpec('["https://a.test", { "url": "https://b.test", "title": "B" }]');
    expect(result.ok).toBe(true);
    expect(result.spec.links).toEqual([{ url: 'https://a.test' }, { url: 'https://b.test', title: 'B' }]);
    expect(result.notes).toEqual(['Treated the top-level list as "links".', 'Turned plain URL strings into { "url": ... } links.']);
  });

  it('points out an already compiled blueprint pasted by mistake', () => {
    const result = parseBlueprintSpec(JSON.stringify(COMPILED));
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/already compiled blueprint \(bp_0a1b2c3d_1790000000000\)/);
  });
});

describe('validateCompileRequest (engine contract)', () => {
  it('requires a non-empty links array of objects with a url', () => {
    expect(messages(validateCompileRequest({}).errors)).toEqual(["/ must have required property 'links'"]);
    expect(messages(validateCompileRequest({ links: [] }).errors)).toEqual(['/links must NOT have fewer than 1 items']);
    expect(messages(validateCompileRequest({ links: [{ title: 'x' }, { url: '' }, { url: 5 }, 'x'] }).errors)).toEqual([
      "/links/0 must have required property 'url'",
      '/links/1/url must NOT have fewer than 1 characters',
      '/links/2/url must be string',
      '/links/3 must be an object',
    ]);
  });

  it('type-checks the optional fields', () => {
    const { errors } = validateCompileRequest({
      links: [{ url: 'https://a.test', title: 1 }],
      projectName: 2,
      lodLevel: 1.5,
      useMiserlyProxy: 'yes',
      interviewResponses: { miserlyBudgetCapUsd: -1, unresolvedConnectors: ['ok', 3] },
    });
    expect(messages(errors)).toEqual([
      '/links/0/title must be string',
      '/projectName must be string',
      '/lodLevel must be integer',
      '/useMiserlyProxy must be boolean',
      '/interviewResponses/miserlyBudgetCapUsd must be >= 0',
      '/interviewResponses/unresolvedConnectors/1 must be string',
    ]);
    expect(messages(validateCompileRequest({ links: [{ url: 'https://a.test' }], lodLevel: 0 }).errors)).toEqual(['/lodLevel must be >= 1']);
  });

  it('warns (without failing) about unknown keys, non-http URLs and a missing project name', () => {
    const { errors, warnings } = validateCompileRequest({ links: [{ url: 'ftp://a.test' }], extra: true, interviewResponses: { color: 'red' } });
    expect(errors).toEqual([]);
    expect(messages(warnings)).toEqual([
      '/links/0/url is not an http(s) URL; the compiler will keep it as written',
      '/interviewResponses/color is not part of the spec and will be ignored',
      '/extra is not part of the spec and will be ignored',
      '/projectName is missing; the engine will name it "Untitled Aether Project"',
    ]);
  });
});

describe('compiled blueprint helpers', () => {
  it('builds the route matrix in phase order with the Miserly route and cap', () => {
    expect(routeMatrix(COMPILED)).toEqual([
      { phase: 1, name: 'Ingest', role: 'Data Synthesizer', tools: ['fetch_url_content', 'sanitize_text'], route: 'Miserly.io proxy', endpoint: 'https://miserly-io.klo377.workers.dev', budget: 1 },
      { phase: 2, name: 'Scaffold', role: 'System Architect', tools: ['file_system_writer'], route: 'Miserly.io proxy', endpoint: 'https://miserly-io.klo377.workers.dev', budget: 1 },
    ]);
    expect(routeMatrix({ ...COMPILED, miserly_integration: { enabled: false, proxy_endpoint: null, budget_cap_usd: 0 } })[0]).toMatchObject({ route: 'Direct (no proxy)', budget: null });
  });

  it('turns phases into prompt steps for the task loop', () => {
    const steps = blueprintToTaskSteps(COMPILED);
    expect(steps.map((s) => s.step_id + ':' + s.action + ':' + s.params.prompt)).toEqual(['phase-1:prompt:Read the sources.', 'phase-2:prompt:Build it.']);
    expect(steps[0].params.context).toEqual({
      blueprint_id: 'bp_0a1b2c3d_1790000000000',
      project_name: 'Demo',
      phase_index: 1,
      phase_name: 'Ingest',
      agent_role: 'Data Synthesizer',
      required_mcp_tools: ['fetch_url_content', 'sanitize_text'],
      sources: [{ url: 'https://a.test', summary: 'A' }],
    });
  });

  it('recognizes only the pro tier', () => {
    expect([isProTier('pro'), isProTier('PRO'), isProTier('free'), isProTier(undefined)]).toEqual([true, true, false, false]);
  });
});
