-- User accounts (admin-created via POST /api/auth/users) and per-user scoping of nodes and edges.
-- password_hash NULL means the account cannot log in until a password is set.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  telegram_chat_id TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO users (id, username) VALUES ('user_owner', 'owner');

-- Nullable because SQLite can't add a NOT NULL column without a default; the worker always writes it.
ALTER TABLE saved_nodes ADD COLUMN user_id TEXT;
ALTER TABLE node_edges ADD COLUMN user_id TEXT;
UPDATE saved_nodes SET user_id = 'user_owner' WHERE user_id IS NULL;
UPDATE node_edges SET user_id = 'user_owner' WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_saved_nodes_user ON saved_nodes (user_id);
CREATE INDEX IF NOT EXISTS idx_node_edges_user ON node_edges (user_id);
