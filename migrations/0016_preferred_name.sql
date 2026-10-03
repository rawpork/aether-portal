-- Preferred name (src/user-profile.js): the display name the Portal UI shows in the header, the Mission Control
-- greeting and the operator card. NULL falls back to the username, which stays the account identity.
-- Set it from Settings > Display name, or PATCH /api/settings { "preferred_name": "..." }.
ALTER TABLE users ADD COLUMN preferred_name TEXT;
