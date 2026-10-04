CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  revoked_at TEXT
);
CREATE TABLE update_sources (
  update_id TEXT PRIMARY KEY REFERENCES task_updates(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_type TEXT NOT NULL CHECK(source_type IN ('email','text','meeting','other')),
  external_id TEXT NOT NULL,
  source_url TEXT,
  UNIQUE(task_id,source_type,external_id)
);
CREATE TABLE agent_activity (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES agent_keys(id),
  actor_email TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  response_status INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX agent_activity_key_time ON agent_activity(key_id,created_at);
CREATE TRIGGER update_source_task_match BEFORE INSERT ON update_sources
WHEN NOT EXISTS(SELECT 1 FROM task_updates WHERE id=NEW.update_id AND task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'Source reference must belong to the same project update'); END;
