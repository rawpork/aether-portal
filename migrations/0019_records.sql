-- Context retrieval layer (aether_context_db): one searchable index over what a user has saved or produced, so the engine and
-- Elarion can find the right card, blueprint or deliverable by what it says instead of reading everything. src/records.js
-- queries it (search_records, get_record). Bodies stay where they live: body_ref points at them ("saved_nodes:<id>", "/s/<slug>").
-- user_id is added to the spec's columns: every query is scoped to one person.
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  project_id TEXT,
  run_id TEXT,
  type TEXT,
  title TEXT,
  summary TEXT,
  body_ref TEXT,
  tags TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_records_user_type ON records (user_id, type, updated_at);
CREATE INDEX IF NOT EXISTS idx_records_project ON records (user_id, project_id);

-- External-content FTS5 index over title, summary and tags. The triggers keep it in step with every records write.
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(title, summary, tags, content='records', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts (rowid, title, summary, tags) VALUES (new.rowid, new.title, new.summary, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts (records_fts, rowid, title, summary, tags) VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts (records_fts, rowid, title, summary, tags) VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
  INSERT INTO records_fts (rowid, title, summary, tags) VALUES (new.rowid, new.title, new.summary, new.tags);
END;

-- Write path: every card, outcome and website saved in the portal lands in records, whichever code path saved it.
-- A card is a saved_nodes row; an outcome (category 'outcome') is a deliverable. Upserts (never INSERT OR REPLACE, which skips
-- delete triggers) so the FTS index follows.
CREATE TRIGGER IF NOT EXISTS records_from_node_ai AFTER INSERT ON saved_nodes BEGIN
  INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
  VALUES (new.id, new.user_id, CASE WHEN new.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(new.title, ''),
    COALESCE(NULLIF(new.description, ''), new.user_note, ''), 'saved_nodes:' || new.id, COALESCE(new.category, ''),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS records_from_node_au AFTER UPDATE OF title, description, user_note, category ON saved_nodes BEGIN
  INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
  VALUES (new.id, new.user_id, CASE WHEN new.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(new.title, ''),
    COALESCE(NULLIF(new.description, ''), new.user_note, ''), 'saved_nodes:' || new.id,
    COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = new.id), COALESCE(new.category, '')),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, summary = excluded.summary, tags = excluded.tags, updated_at = excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS records_from_node_ad AFTER DELETE ON saved_nodes BEGIN
  DELETE FROM records WHERE id = old.id;
END;
-- Tags arrive after the card (the miner and #hashtags in notes): keep the record's tags current.
CREATE TRIGGER IF NOT EXISTS records_from_tag_ai AFTER INSERT ON node_tags BEGIN
  UPDATE records SET tags = (SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = new.node_id) WHERE id = new.node_id;
END;
CREATE TRIGGER IF NOT EXISTS records_from_tag_ad AFTER DELETE ON node_tags BEGIN
  UPDATE records SET tags = COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = old.node_id), '') WHERE id = old.node_id;
END;

CREATE TRIGGER IF NOT EXISTS records_from_site_ai AFTER INSERT ON sites BEGIN
  INSERT INTO records (id, user_id, project_id, type, title, summary, body_ref, tags, created_at, updated_at)
  VALUES ('site:' || new.slug, new.user_id, new.outcome_id, 'deliverable', new.title, 'Website, ' || new.status, '/s/' || new.slug, 'website',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS records_from_site_au AFTER UPDATE OF title, status ON sites BEGIN
  UPDATE records SET title = new.title, summary = 'Website, ' || new.status, updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE id = 'site:' || new.slug;
END;
CREATE TRIGGER IF NOT EXISTS records_from_site_ad AFTER DELETE ON sites BEGIN
  DELETE FROM records WHERE id = 'site:' || old.slug;
END;

-- Backfill what already exists (the triggers above fill the FTS index as these rows go in).
INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
SELECT n.id, n.user_id, CASE WHEN n.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(n.title, ''),
  COALESCE(NULLIF(n.description, ''), n.user_note, ''), 'saved_nodes:' || n.id,
  COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = n.id), COALESCE(n.category, '')),
  COALESCE(CAST(strftime('%s', n.created_at) AS INTEGER) * 1000, 0), COALESCE(CAST(strftime('%s', n.created_at) AS INTEGER) * 1000, 0)
FROM saved_nodes n WHERE true
ON CONFLICT (id) DO NOTHING;
INSERT INTO records (id, user_id, project_id, type, title, summary, body_ref, tags, created_at, updated_at)
SELECT 'site:' || s.slug, s.user_id, s.outcome_id, 'deliverable', s.title, 'Website, ' || s.status, '/s/' || s.slug, 'website',
  COALESCE(CAST(strftime('%s', s.created_at) AS INTEGER) * 1000, 0), COALESCE(CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000, 0)
FROM sites s WHERE true
ON CONFLICT (id) DO NOTHING;
