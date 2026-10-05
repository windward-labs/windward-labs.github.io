ALTER TABLE tasks ADD COLUMN occurred_at TEXT;
CREATE TABLE project_date_changes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  previous_date TEXT,
  occurred_at TEXT NOT NULL,
  source_message_id TEXT,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Protect issued/paid invoice attribution even when issuing races a correction.
CREATE TRIGGER project_work_date_locked BEFORE UPDATE OF occurred_at ON tasks
WHEN COALESCE(NEW.occurred_at,NEW.created_at)!=COALESCE(OLD.occurred_at,OLD.created_at)
AND EXISTS(SELECT 1 FROM invoices i WHERE i.client_id=OLD.client_id
  AND i.status IN ('issuing','open','paid')
  AND i.cutoff>MIN(COALESCE(OLD.occurred_at,OLD.created_at),COALESCE(NEW.occurred_at,NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'Work date is covered by an issued invoice'); END;
