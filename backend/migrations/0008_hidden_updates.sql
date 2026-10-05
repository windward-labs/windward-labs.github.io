ALTER TABLE task_updates ADD COLUMN hidden_at TEXT;
ALTER TABLE task_updates ADD COLUMN hidden_by TEXT;
ALTER TABLE task_updates ADD COLUMN hidden_actor_email TEXT;

CREATE TABLE update_visibility_changes (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES task_updates(id),
  action TEXT NOT NULL CHECK(action IN ('hide','restore')),
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX update_visibility_history ON update_visibility_changes(update_id,created_at);
