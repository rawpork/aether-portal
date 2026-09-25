-- Open Graph link previews for the node card header: cover image, site name and canonical source URL.
ALTER TABLE saved_nodes ADD COLUMN image_url TEXT;
ALTER TABLE saved_nodes ADD COLUMN site_name TEXT;
ALTER TABLE saved_nodes ADD COLUMN source_url TEXT;
