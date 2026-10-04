ALTER TABLE attachments ADD COLUMN update_id TEXT REFERENCES task_updates(id);
CREATE INDEX attachments_update ON attachments(update_id);
