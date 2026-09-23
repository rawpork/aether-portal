-- Enrichment tracking: /api/recluster only sends nodes with ai_processed_at IS NULL to Gemini.
-- ADD COLUMN can't use a non-constant default like CURRENT_TIMESTAMP, so updated_at is backfilled.
ALTER TABLE saved_nodes ADD COLUMN updated_at DATETIME;
ALTER TABLE saved_nodes ADD COLUMN ai_processed_at DATETIME;
UPDATE saved_nodes SET updated_at = created_at WHERE updated_at IS NULL;
