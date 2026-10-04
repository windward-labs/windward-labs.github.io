-- Event time is independent of the server's ingestion/audit timestamp.
ALTER TABLE task_updates ADD COLUMN occurred_at TEXT;
CREATE TABLE update_date_changes (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES task_updates(id),
  previous_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
