-- YouTube Transcript Pipeline: the full transcript fetched for a video node, and a short AI synopsis made from it.
ALTER TABLE saved_nodes ADD COLUMN raw_transcript TEXT;
ALTER TABLE saved_nodes ADD COLUMN synopsis TEXT;
