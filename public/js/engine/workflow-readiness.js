// What a workflow still needs before a run does what it says. Pure: the graph, the engine's connector list and its MCP servers
// go in, a list of plain-words problems comes out, each pointing at the card it is about. The Studio shows them on the cards
// and in a "Set up" panel when you press Run.

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// The agent that hands work to an action node, and whether an approval stands in front of that agent.
function gatedBefore(workflow, actionId) {
  const feeders = workflow.cables.filter((c) => c.to === actionId && c.kind === 'action').map((c) => workflow.nodes.find((n) => n.id === c.from)).filter(Boolean);
  const agents = feeders.filter((n) => n.kind === 'agent');
  if (!agents.length) return true; // nothing runs it, so there is nothing to guard
  return agents.every((agent) => workflow.cables.some((c) => c.to === agent.id && c.kind === 'start' && (workflow.nodes.find((n) => n.id === c.from) || {}).kind === 'human'));
}

export function workflowReadiness(workflow, connectors = [], mcpServers = []) {
  const issues = [];
  if (!workflow) return issues;
  const add = (node, problem, fix) => issues.push({ node_id: node.id, label: node.label, problem, fix });
  for (const node of workflow.nodes) {
    if (node.kind === 'action') {
      if (!node.connector || !node.action) {
        add(node, 'Not connected to anything, so it will only be proposed and nothing will happen.', 'Pick what it does in the Toolbox');
        continue;
      }
      const connector = connectors.find((c) => c.id === node.connector);
      const action = connector && connector.actions.find((a) => a.id === node.action);
      if (!connector || !action) {
        add(node, 'It uses ' + node.connector + '.' + node.action + ', which this engine does not have.', 'Pick another action in the Toolbox');
        continue;
      }
      if (connector.status !== 'ready') add(node, connector.name + ' is not ready. ' + (connector.status_detail || ''), connector.status === 'coming_soon' ? 'Not available yet: it will only be proposed' : 'Finish the ' + connector.name + ' setup');
      const missing = action.fields.filter((f) => f.required && !text((node.params || {})[f.id]) && !f.default).map((f) => f.label);
      if (missing.length) add(node, 'Fill in: ' + missing.join(', ') + '.', 'Open the card and fill the fields');
      if (action.outward && !gatedBefore(workflow, node.id)) add(node, 'This reaches outside Aether and nothing asks you first.', 'Put an approval in front of the agent that runs it');
    } else if (node.kind === 'mcp') {
      const server = mcpServers.find((s) => s.name === (node.server || node.label));
      if (server && server.status === 'missing_keys') add(node, 'Needs ' + (server.missing_env || []).join(', ') + ' in the engine .env before it can be used.', 'Add the key to the engine');
      else if (!server && mcpServers.length) add(node, 'This tool is not in the engine\'s mcp-config.json.', 'Remove it or add it to the engine');
    }
  }
  return issues;
}

// The issues for one card (the badge and the card's own panel).
export const issuesFor = (issues, nodeId) => issues.filter((i) => i.node_id === nodeId);
