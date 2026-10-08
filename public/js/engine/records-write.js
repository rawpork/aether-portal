// The write half of the retrieval layer: a compiled blueprint enters the portal's records index (POST /api/records) so Elarion can
// find it by what it says. Cards, outcomes and websites are indexed by the database itself; blueprints live in the engine, so the
// page reports them here. Best effort: the project works the same if this fails.
const SUMMARY_MAX = 600;

export function blueprintRecord(blueprintId, blueprint) {
  const phases = Array.isArray(blueprint && blueprint.execution_phases) ? blueprint.execution_phases : [];
  const summary = phases.map((p) => [p.phase_name, p.description].filter(Boolean).join(': ')).filter(Boolean).join('. ').slice(0, SUMMARY_MAX);
  return {
    id: String(blueprintId),
    type: 'blueprint',
    title: String((blueprint && blueprint.project_name) || 'Untitled project'),
    summary,
    project_id: String(blueprintId),
    tags: ['blueprint', ...phases.map((p) => p.agent_persona).filter(Boolean)].slice(0, 12),
  };
}

export async function saveBlueprintRecord(portalFetch, blueprintId, blueprint) {
  if (!blueprintId || !portalFetch) return false;
  try {
    const response = await portalFetch('/api/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blueprintRecord(blueprintId, blueprint)),
    });
    return Boolean(response && response.ok);
  } catch {
    return false;
  }
}
