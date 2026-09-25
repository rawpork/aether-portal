-- Telegram photo nodes: the bot's permanent file_id, so /api/node-image/:id can fetch the image on demand
-- (Telegram download URLs embed the bot token and expire, so they are never stored).
ALTER TABLE saved_nodes ADD COLUMN telegram_file_id TEXT;
