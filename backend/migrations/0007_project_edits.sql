ALTER TABLE tasks ADD COLUMN details_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE project_edits (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  previous_details TEXT NOT NULL CHECK(json_valid(previous_details)),
  updated_details TEXT NOT NULL CHECK(json_valid(updated_details)),
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
