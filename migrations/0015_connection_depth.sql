-- Connection Depth (PROJECT_STATE.md, next step 2). Each user picks how far the engine reaches when it relates saves
-- ('obvious', 'logical' or 'abstract'); every mined edge records the depth it was found at, and its confidence (0-1),
-- so the portal can filter wires by level instantly and keep only the most confident abstract leaps per card.
-- Existing edges came from the old miner prompt, which asked for Logical relations.
ALTER TABLE users ADD COLUMN connection_depth TEXT NOT NULL DEFAULT 'logical';
ALTER TABLE node_edges ADD COLUMN depth TEXT NOT NULL DEFAULT 'logical';
ALTER TABLE node_edges ADD COLUMN confidence REAL;
