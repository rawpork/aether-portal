-- Board view column for each node: inbox, active, reference or done. NULL reads as inbox, so new and existing nodes start there.
ALTER TABLE saved_nodes ADD COLUMN status TEXT;
