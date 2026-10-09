// What Elarion is told about what the operator is looking at, so "this", "it" and "that node" mean something. Each builder turns a page's
// live state into a small plain object (bounded: names and short notes, not whole documents). The dock sends it as the <context> of a
// typed message (brain-dock.js), and the engine's rules tell Elarion to use it (src/persona.ts).

const MAX_NODES = 40;
const MAX_CABLES = 60;
const NOTE_CHARS = 160;

const short = (value, max = NOTE_CHARS) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

// Studio's Workflow console: the workflow open, its nodes with what each does and how its last run went, how they are wired, which
// node or cable is selected, and the state of the latest run.
export function studioContext(state) {
  const workflow = state && state.workflow;
  if (!workflow) return { page: 'Studio', workflow: null, note: 'No workflow is open in the Studio yet.' };
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const cables = Array.isArray(workflow.cables) ? workflow.cables : [];
  const status = (state.run && state.run.node_status) || {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nameOf = (id) => (byId.get(id) ? byId.get(id).label || id : id);
  const selected = state.selected && state.selected.type === 'node' ? byId.get(state.selected.id) : null;
  const selectedCable = state.selected && state.selected.type === 'cable' ? cables.find((c) => c.id === state.selected.id) : null;
  return {
    page: 'Studio',
    workflow: {
      title: short(workflow.title, 120),
      goal: short(workflow.goal, 300),
      node_count: nodes.length,
      nodes: nodes.slice(0, MAX_NODES).map((n) => ({
        id: n.id,
        kind: n.kind,
        name: short(n.label, 80),
        ...(n.role ? { role: short(n.role) } : {}),
        ...(n.instructions ? { instructions: short(n.instructions) } : {}),
        ...(n.connector ? { connector: n.connector + '.' + n.action } : {}),
        ...(status[n.id] ? { last_run: status[n.id] } : {}),
      })),
      cables: cables.slice(0, MAX_CABLES).map((c) => ({ from: nameOf(c.from), to: nameOf(c.to), kind: c.kind })),
    },
    selected: selected
      ? { node: short(selected.label, 80), id: selected.id, kind: selected.kind, ...(selected.role ? { role: short(selected.role) } : {}), ...(selected.instructions ? { instructions: short(selected.instructions, 400) } : {}) }
      : selectedCable
        ? { cable: nameOf(selectedCable.from) + ' to ' + nameOf(selectedCable.to), kind: selectedCable.kind }
        : null,
    run: state.run ? { status: state.run.status, started_at: state.run.started_at, finished_at: state.run.finished_at || null } : null,
    editable: Boolean(state.editable),
  };
}

// Projects: the blueprint open, its phases and which agent does each.
export function projectContext(blueprint, page = 'Projects') {
  if (!blueprint) return { page };
  const phases = Array.isArray(blueprint.execution_phases) ? blueprint.execution_phases : [];
  return {
    page,
    project: short(blueprint.project_name, 120),
    blueprint_id: blueprint.blueprint_id,
    status: blueprint.status,
    phases: phases.slice(0, 20).map((p) => ({ name: short(p.phase_name, 80), agent: p.agent_persona, what: short(p.description) })),
  };
}
