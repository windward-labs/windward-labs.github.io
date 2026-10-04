CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 10485760),
  sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX attachments_task ON attachments(task_id, created_at);
