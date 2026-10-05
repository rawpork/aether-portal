-- Aether-hosted websites (src/sites.js), served at /s/<slug>. A site has a draft (written by Mission Control from a
-- project run) and a live copy. Only the owner's explicit Publish in Mission Control copies the draft to live_html,
-- so a changed draft never reaches the public page without a fresh approval. status: 'draft' | 'live'.
CREATE TABLE IF NOT EXISTS sites (
  slug TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  draft_html TEXT NOT NULL,
  live_html TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  outcome_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites (user_id, updated_at);
