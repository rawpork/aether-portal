-- Initial schema for the Aether Portal D1 database (aether_context_db).
-- Must keep the implicit rowid (no WITHOUT ROWID): /api/recluster pages by rowid.
CREATE TABLE IF NOT EXISTS saved_nodes (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  category TEXT DEFAULT 'general',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ai_processed_at DATETIME
);
