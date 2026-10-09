-- Approvals asked over Telegram: the engine sends one when a workflow run waits for you; tapping Approve or Stop in the chat
-- records the answer here, and the engine picks it up (it only ever calls out) and answers the run. One row per question.
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  question TEXT,
  options TEXT NOT NULL,
  chosen INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_user ON approval_requests (user_id, delivered, chosen);
