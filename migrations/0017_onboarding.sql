-- First-run onboarding (src/onboarding.js): the first /api/graph for a user with no nodes seeds a small tutorial graph,
-- once. onboarded_at records that the seed ran (or was not needed), so a user who later deletes everything is not
-- seeded again. Users who already have nodes count as onboarded.
ALTER TABLE users ADD COLUMN onboarded_at TIMESTAMP;
UPDATE users SET onboarded_at = CURRENT_TIMESTAMP WHERE id IN (SELECT DISTINCT user_id FROM saved_nodes WHERE user_id IS NOT NULL);
