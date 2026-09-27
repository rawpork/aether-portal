-- Spatial view Phase 2 (SPATIAL_ARCHITECTURE.md, sections 1.1-1.3): hybrid groups and tags.

-- Groups: one list for concept groups suggested by the daily miner (source 'ai') and groups the user creates
-- from a card's group picker (source 'user'). Renaming an 'ai' group makes it 'user'. Named node_groups because
-- GROUPS is an SQL keyword. Names are 1-40 characters, unique per user regardless of case.
CREATE TABLE IF NOT EXISTS node_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_groups_user_name ON node_groups (user_id, name COLLATE NOCASE);

-- Each node's group. group_source 'user' means the user chose it and the miner must never change it; 'ai' means
-- the miner chose it and may move it on a later run. Both NULL: unsorted, laid out by category as today.
ALTER TABLE saved_nodes ADD COLUMN group_id TEXT;
ALTER TABLE saved_nodes ADD COLUMN group_source TEXT;
CREATE INDEX IF NOT EXISTS idx_saved_nodes_user_group ON saved_nodes (user_id, group_id);

-- Tags: many per node. source 'user' comes from #hashtags in the node's note and is never removed by the miner;
-- source 'miner' holds 3-5 keywords from the daily miner (weight 0-1) and is replaced when the node is re-mined.
-- Tags are lowercased, without the leading '#', 2-40 characters.
CREATE TABLE IF NOT EXISTS node_tags (
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  user_id TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  weight REAL DEFAULT 1,
  PRIMARY KEY (node_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_node_tags_user_tag ON node_tags (user_id, tag);
