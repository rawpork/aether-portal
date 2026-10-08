-- Elarion conversations, kept in D1 so a thread survives a reload, a new device and an engine restart (the engine keeps its
-- working history in memory only). A thread is "main" or "project:<blueprint id>"; src/conversations.js writes and reads it and
-- files each thread in records (type 'conversation') so Elarion's search_records can find past discussions.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_project ON conversations (user_id, project_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread ON conversation_messages (user_id, thread_id, id);
