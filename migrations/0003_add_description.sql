-- Short preview text for the node card: og:description for web links, "YouTube video by <author>" for videos.
ALTER TABLE saved_nodes ADD COLUMN description TEXT;
