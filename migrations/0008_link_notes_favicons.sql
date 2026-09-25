-- Text attached to a link (sent with it, or in a Telegram message shortly after) and the site's favicon URL.
ALTER TABLE saved_nodes ADD COLUMN user_note TEXT;
ALTER TABLE saved_nodes ADD COLUMN favicon_url TEXT;
