-- Agentic Synthesis Engine (SPATIAL_ARCHITECTURE.md section 8, Phase 7): Outcome Nodes.
-- An Outcome Node is an ordinary saved_nodes row with category 'outcome', so it inherits the graph, search, filters,
-- cards, groups, gallery and Board. These columns hold what only outcomes have.

-- proposed | accepted | dismissed | sent. Accepted outcomes are never rewritten by the miner; dismissed ones are hidden
-- and their fingerprint stops the same pattern being proposed again.
ALTER TABLE saved_nodes ADD COLUMN outcome_status TEXT;
-- Hash of the sorted input node ids, used for novelty and dismiss memory.
ALTER TABLE saved_nodes ADD COLUMN outcome_fingerprint TEXT;
-- The plan as JSON: { template, goal, why, effort, steps: [{ title, detail, inputs: [node ids] }] }.
ALTER TABLE saved_nodes ADD COLUMN outcome_plan TEXT;
CREATE INDEX IF NOT EXISTS idx_saved_nodes_user_outcome ON saved_nodes (user_id, outcome_fingerprint) WHERE outcome_fingerprint IS NOT NULL;

-- Provenance: the user's saves each outcome was synthesized from, drawn as gold synthesis links.
CREATE TABLE IF NOT EXISTS outcome_inputs (
  outcome_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT,
  PRIMARY KEY (outcome_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_outcome_inputs_node ON outcome_inputs (node_id);
