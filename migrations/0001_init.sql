-- Initial schema for the Aether Portal D1 database (aether_context_db).
-- Matches the table as it already existed in production; later columns are added by 0002+.
-- Must keep the implicit rowid (no WITHOUT ROWID): /api/recluster pages by rowid.
CREATE TABLE IF NOT EXISTS saved_nodes (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  category TEXT DEFAULT 'general',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
