-- Ask Elarion history for the node card: JSON array of { question, answer, sources: [{ title, uri }], asked_at }, newest last.
ALTER TABLE saved_nodes ADD COLUMN research TEXT;
