-- Complete recall: richer card records and groups, so anything saved or changed in the portal is searchable the moment it is written.
-- The triggers run inside the write that fires them, so a card, tag, group or site is in records and records_fts before the request
-- that made it returns. (Engine output, blueprints and conversations are filed through /api/records; see src/records.js.)
-- A card's summary is its description (or synopsis) plus the note, up to 600 characters; its tags are category, site and every tag.

DROP TRIGGER IF EXISTS records_from_node_ai;
DROP TRIGGER IF EXISTS records_from_node_au;
DROP TRIGGER IF EXISTS records_from_tag_ai;
DROP TRIGGER IF EXISTS records_from_tag_ad;

CREATE TRIGGER records_from_node_ai AFTER INSERT ON saved_nodes BEGIN
  INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
  VALUES (new.id, new.user_id, CASE WHEN new.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(new.title, ''),
    substr(trim(COALESCE(NULLIF(new.description, ''), NULLIF(new.synopsis, ''), '') || ' ' || COALESCE(new.user_note, '')), 1, 600),
    'saved_nodes:' || new.id, trim(COALESCE(new.category, '') || ' ' || COALESCE(new.site_name, '')),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary, tags = excluded.tags, updated_at = excluded.updated_at;
END;

CREATE TRIGGER records_from_node_au AFTER UPDATE OF title, description, synopsis, user_note, category, site_name ON saved_nodes BEGIN
  INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
  VALUES (new.id, new.user_id, CASE WHEN new.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(new.title, ''),
    substr(trim(COALESCE(NULLIF(new.description, ''), NULLIF(new.synopsis, ''), '') || ' ' || COALESCE(new.user_note, '')), 1, 600),
    'saved_nodes:' || new.id,
    trim(COALESCE(new.category, '') || ' ' || COALESCE(new.site_name, '') || ' ' || COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = new.id), '')),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, summary = excluded.summary, tags = excluded.tags, updated_at = excluded.updated_at;
END;

CREATE TRIGGER records_from_tag_ai AFTER INSERT ON node_tags BEGIN
  UPDATE records SET tags = (
    SELECT trim(COALESCE(n.category, '') || ' ' || COALESCE(n.site_name, '') || ' ' || COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = n.id), ''))
    FROM saved_nodes n WHERE n.id = new.node_id)
  WHERE id = new.node_id AND EXISTS (SELECT 1 FROM saved_nodes WHERE id = new.node_id);
END;

CREATE TRIGGER records_from_tag_ad AFTER DELETE ON node_tags BEGIN
  UPDATE records SET tags = (
    SELECT trim(COALESCE(n.category, '') || ' ' || COALESCE(n.site_name, '') || ' ' || COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = n.id), ''))
    FROM saved_nodes n WHERE n.id = old.node_id)
  WHERE id = old.node_id AND EXISTS (SELECT 1 FROM saved_nodes WHERE id = old.node_id);
END;

-- Groups (the named collections cards are sorted into) are records too.
CREATE TRIGGER IF NOT EXISTS records_from_group_ai AFTER INSERT ON node_groups BEGIN
  INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
  VALUES ('group:' || new.id, new.user_id, 'note', new.name, 'A group of cards named ' || new.name || '.', 'node_groups:' || new.id, 'group ' || COALESCE(new.source, ''),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS records_from_group_au AFTER UPDATE OF name ON node_groups BEGIN
  UPDATE records SET title = new.name, summary = 'A group of cards named ' || new.name || '.', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE id = 'group:' || new.id;
END;
CREATE TRIGGER IF NOT EXISTS records_from_group_ad AFTER DELETE ON node_groups BEGIN
  DELETE FROM records WHERE id = 'group:' || old.id;
END;

-- Bring every existing card and group up to the richer form, and file the groups that predate their trigger.
INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
SELECT n.id, n.user_id, CASE WHEN n.category = 'outcome' THEN 'deliverable' ELSE 'card' END, COALESCE(n.title, ''),
  substr(trim(COALESCE(NULLIF(n.description, ''), NULLIF(n.synopsis, ''), '') || ' ' || COALESCE(n.user_note, '')), 1, 600),
  'saved_nodes:' || n.id,
  trim(COALESCE(n.category, '') || ' ' || COALESCE(n.site_name, '') || ' ' || COALESCE((SELECT group_concat(tag, ' ') FROM node_tags WHERE node_id = n.id), '')),
  COALESCE(CAST(strftime('%s', n.created_at) AS INTEGER) * 1000, 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM saved_nodes n WHERE true
ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, summary = excluded.summary, tags = excluded.tags;

INSERT INTO records (id, user_id, type, title, summary, body_ref, tags, created_at, updated_at)
SELECT 'group:' || g.id, g.user_id, 'note', g.name, 'A group of cards named ' || g.name || '.', 'node_groups:' || g.id, 'group ' || COALESCE(g.source, ''),
  COALESCE(CAST(strftime('%s', g.created_at) AS INTEGER) * 1000, 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM node_groups g WHERE true
ON CONFLICT (id) DO NOTHING;
