-- Web Content Fetcher: readable text extracted from a link node's page by /api/web-fetch.
ALTER TABLE saved_nodes ADD COLUMN content TEXT;

-- Google sign-in: accounts are matched by Google's stable subject id, then by verified email. New accounts
-- (allowlisted emails only) start on the free tier; existing username/password accounts read as free too.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'free';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email COLLATE NOCASE) WHERE email IS NOT NULL;
