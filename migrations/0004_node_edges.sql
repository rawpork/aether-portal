-- Relationship edges mined by the daily Gemini cron. Undirected: stored with source_id < target_id.
CREATE TABLE IF NOT EXISTS node_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_node_edges_target ON node_edges (target_id);
