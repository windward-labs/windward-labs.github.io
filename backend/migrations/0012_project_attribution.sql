-- Reporting-only overlay. No writes to work, tasks, billing, payments or ledger.
CREATE TABLE attribution_adjustments (
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES clients(id),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_by TEXT NOT NULL,
 actor_email TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE attribution_revisions (
 adjustment_id TEXT NOT NULL REFERENCES attribution_adjustments(id),
 entry_id TEXT NOT NULL REFERENCES work_entries(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 entry_version INTEGER NOT NULL,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 PRIMARY KEY(entry_id,revision),
 UNIQUE(adjustment_id,entry_id)
);
CREATE VIEW current_work_allocations AS
 SELECT e.id AS entry_id,e.task_id AS original_task_id,e.task_id, e.hours,e.credits,0 AS revision
 FROM work_entries e WHERE NOT EXISTS(SELECT 1 FROM attribution_revisions r WHERE r.entry_id=e.id)
 UNION ALL
 SELECT e.id,e.task_id,json_extract(a.value,'$.taskId'),json_extract(a.value,'$.hours'),json_extract(a.value,'$.credits'),r.revision
 FROM work_entries e JOIN attribution_revisions r ON r.entry_id=e.id, json_each(r.after_json) a
 WHERE r.revision=(SELECT MAX(latest.revision) FROM attribution_revisions latest WHERE latest.entry_id=e.id);

-- Each revision is a complete allocation, never a delta. Check against the
-- current state inside the same transaction that records the whole adjustment.
CREATE TRIGGER attribution_revision_guard BEFORE INSERT ON attribution_revisions BEGIN
 SELECT RAISE(ABORT,'Attribution conflict: stale entry or revision') WHERE NOT EXISTS(
  SELECT 1 FROM work_entries e JOIN tasks t ON t.id=e.task_id JOIN attribution_adjustments a ON a.id=NEW.adjustment_id
  WHERE e.id=NEW.entry_id AND t.client_id=a.client_id AND e.version=NEW.entry_version
  AND NEW.revision=1+COALESCE((SELECT MAX(revision) FROM attribution_revisions WHERE entry_id=e.id),0));
 SELECT RAISE(ABORT,'Attribution conflict: original allocations changed') WHERE NEW.before_json!=(
  SELECT json_group_array(json_object('taskId',task_id,'hours',hours,'credits',credits))
  FROM (SELECT * FROM current_work_allocations WHERE entry_id=NEW.entry_id ORDER BY task_id));
 SELECT RAISE(ABORT,'Attribution conflict: invalid allocations') WHERE json_type(NEW.after_json)!='array'
  OR json_array_length(NEW.after_json) NOT BETWEEN 1 AND 100
  OR EXISTS(SELECT 1 FROM json_each(NEW.after_json) j WHERE json_type(j.value)!='object'
   OR json_type(j.value,'$.taskId') IS NOT 'text'
   OR json_type(j.value,'$.credits') IS NOT 'integer'
   OR json_type(j.value,'$.hours') NOT IN ('integer','real')
   OR json_extract(j.value,'$.credits')<=0 OR json_extract(j.value,'$.hours')*4!=json_extract(j.value,'$.credits')
   OR (SELECT count(*) FROM json_each(j.value))!=3
   OR NOT EXISTS(SELECT 1 FROM tasks target JOIN attribution_adjustments a ON a.id=NEW.adjustment_id
     WHERE target.id=json_extract(j.value,'$.taskId') AND target.client_id=a.client_id AND target.status!='cancelled'))
  OR (SELECT count(*) FROM json_each(NEW.after_json))!=(SELECT count(DISTINCT json_extract(value,'$.taskId')) FROM json_each(NEW.after_json))
  OR (SELECT sum(json_extract(value,'$.hours')) FROM json_each(NEW.after_json))!=(SELECT hours FROM work_entries WHERE id=NEW.entry_id)
  OR (SELECT sum(json_extract(value,'$.credits')) FROM json_each(NEW.after_json))!=(SELECT credits FROM work_entries WHERE id=NEW.entry_id);
 SELECT RAISE(ABORT,'Attribution conflict: allocations already match') WHERE NOT EXISTS(SELECT task_id,hours,credits FROM current_work_allocations WHERE entry_id=NEW.entry_id EXCEPT SELECT json_extract(value,'$.taskId'),json_extract(value,'$.hours'),json_extract(value,'$.credits') FROM json_each(NEW.after_json));
END;
CREATE TRIGGER attribution_adjustment_apply AFTER INSERT ON attribution_adjustments BEGIN
 INSERT INTO attribution_revisions(adjustment_id,entry_id,revision,entry_version,before_json,after_json)
 SELECT NEW.id,json_extract(j.value,'$.entryId'),json_extract(j.value,'$.expectedRevision')+1,json_extract(j.value,'$.expectedVersion'),
  (SELECT json_group_array(json_object('taskId',task_id,'hours',hours,'credits',credits)) FROM
   (SELECT * FROM current_work_allocations WHERE entry_id=json_extract(j.value,'$.entryId') ORDER BY task_id)),
  json_extract(j.value,'$.allocations')
 FROM json_each(NEW.payload) j;
END;
CREATE TRIGGER attribution_adjustments_no_update BEFORE UPDATE ON attribution_adjustments BEGIN SELECT RAISE(ABORT,'Attribution audit is immutable'); END;
CREATE TRIGGER attribution_adjustments_no_delete BEFORE DELETE ON attribution_adjustments BEGIN SELECT RAISE(ABORT,'Attribution audit is immutable'); END;
CREATE TRIGGER attribution_revisions_no_update BEFORE UPDATE ON attribution_revisions BEGIN SELECT RAISE(ABORT,'Attribution audit is immutable'); END;
CREATE TRIGGER attribution_revisions_no_delete BEFORE DELETE ON attribution_revisions BEGIN SELECT RAISE(ABORT,'Attribution audit is immutable'); END;
