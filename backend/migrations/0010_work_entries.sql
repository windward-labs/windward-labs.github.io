PRAGMA defer_foreign_keys = ON;
DROP TRIGGER task_charge;
DROP TRIGGER task_refund;
DROP TRIGGER task_no_recharge;
DROP TRIGGER task_no_delete;
DROP TRIGGER project_work_date_locked;
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('email','text','call','meeting','other')),
  credits INTEGER NOT NULL CHECK(credits>=0),
  status TEXT NOT NULL CHECK(status IN ('queued','in_progress','completed','cancelled')),
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  updated_by TEXT,
  updated_actor_email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  details_version INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT,
  billing_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(billing_mode IN ('legacy','entries')),
  original_credits INTEGER NOT NULL DEFAULT 0 CHECK(original_credits>=0)
);
INSERT INTO tasks_new SELECT id,client_id,title,description,requested_by,source,credits,status,created_by,actor_email,updated_by,updated_actor_email,created_at,updated_at,details_version,occurred_at,'legacy',credits FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_client ON tasks(client_id,created_at);

CREATE TABLE work_reallocations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  credits INTEGER NOT NULL CHECK(credits>0),
  payload TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE work_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  occurred_at TEXT NOT NULL,
  hours REAL NOT NULL CHECK(hours>0),
  credits INTEGER NOT NULL CHECK(credits>0 AND credits<=10000 AND hours*4=credits),
  note TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('debit','allocation')),
  reallocation_id TEXT REFERENCES work_reallocations(id),
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((source_type IS NULL AND source_id IS NULL) OR (source_type IN ('email','text','call','meeting','other') AND source_id IS NOT NULL)),
  CHECK((kind='allocation' AND reallocation_id IS NOT NULL) OR (kind='debit' AND reallocation_id IS NULL)),
  UNIQUE(task_id,source_type,source_id)
);
CREATE INDEX work_entries_project_date ON work_entries(task_id,occurred_at,id);
CREATE TABLE work_entry_changes (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES work_entries(id),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE invoices ADD COLUMN attribution_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(attribution_mode IN ('legacy','monthly'));
CREATE TRIGGER invoice_attribution_immutable BEFORE UPDATE OF attribution_mode ON invoices
WHEN NEW.attribution_mode!=OLD.attribution_mode BEGIN SELECT RAISE(ABORT,'Invoice attribution is immutable'); END;

-- Legacy charges remain the sole attribution until the entire charge is
-- allocated atomically. Converted projects contribute only their dated entries.
CREATE VIEW billable_work AS
  SELECT 'legacy:'||id AS id,client_id,id AS task_id,COALESCE(occurred_at,created_at) AS occurred_at,credits
  FROM tasks WHERE billing_mode='legacy' AND status!='cancelled'
  UNION ALL
  SELECT e.id,t.client_id,t.id,e.occurred_at,e.credits
  FROM work_entries e JOIN tasks t ON t.id=e.task_id
  WHERE t.billing_mode='entries' AND t.status!='cancelled';

CREATE TRIGGER task_charge AFTER INSERT ON tasks
WHEN NEW.billing_mode='legacy' AND NEW.credits>0 BEGIN
  -- Old Worker versions omit original_credits during the migration/deploy gap.
  UPDATE tasks SET original_credits=NEW.credits WHERE id=NEW.id;
  INSERT INTO ledger(id,client_id,task_id,kind,credits,note,created_by,actor_email)
  VALUES('work:'||NEW.id,NEW.client_id,NEW.id,'work',-NEW.credits,NEW.title,NEW.created_by,NEW.actor_email);
END;
CREATE TRIGGER task_refund AFTER UPDATE OF status ON tasks
WHEN NEW.status='cancelled' AND OLD.status!='cancelled' AND NEW.credits>0 BEGIN
  INSERT INTO ledger(id,client_id,task_id,kind,credits,note,created_by,actor_email)
  VALUES('refund:'||NEW.id,NEW.client_id,NEW.id,'refund',NEW.credits,'Cancelled: '||NEW.title,NEW.updated_by,NEW.updated_actor_email);
END;
CREATE TRIGGER task_no_recharge BEFORE UPDATE ON tasks
WHEN NEW.client_id!=OLD.client_id OR NEW.id!=OLD.id
  OR (NEW.original_credits!=OLD.original_credits AND NOT (OLD.billing_mode='legacy' AND OLD.original_credits=0 AND NEW.original_credits=OLD.credits AND NOT EXISTS(SELECT 1 FROM ledger WHERE task_id=OLD.id AND kind='work')))
  OR (OLD.status='cancelled' AND NEW.status!='cancelled')
  OR (OLD.billing_mode='entries' AND NEW.billing_mode!='entries')
  OR (NEW.billing_mode='legacy' AND NEW.credits!=OLD.credits)
  OR (NEW.billing_mode='entries' AND NEW.credits!=NEW.original_credits+COALESCE((SELECT SUM(credits) FROM work_entries WHERE task_id=NEW.id AND kind='debit'),0))
  OR (OLD.billing_mode='legacy' AND NEW.billing_mode='entries' AND NEW.original_credits!=COALESCE((SELECT SUM(credits) FROM work_entries WHERE task_id=NEW.id AND kind='allocation'),0))
BEGIN SELECT RAISE(ABORT,'Work charge and cancellation are immutable'); END;
CREATE TRIGGER task_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'Work records cannot be deleted'); END;
CREATE TRIGGER project_work_date_locked BEFORE UPDATE OF occurred_at ON tasks
WHEN COALESCE(NEW.occurred_at,NEW.created_at)!=COALESCE(OLD.occurred_at,OLD.created_at)
AND (OLD.billing_mode='entries' OR EXISTS(SELECT 1 FROM invoices i WHERE i.client_id=OLD.client_id AND i.status IN ('issuing','open','paid') AND
  ((i.attribution_mode='legacy' AND i.cutoff>MIN(COALESCE(OLD.occurred_at,OLD.created_at),COALESCE(NEW.occurred_at,NEW.created_at)))
   OR (i.attribution_mode='monthly' AND i.period IN (substr(COALESCE(OLD.occurred_at,OLD.created_at),1,7),substr(COALESCE(NEW.occurred_at,NEW.created_at),1,7))))))
BEGIN SELECT RAISE(ABORT,'Work date is covered by an issued invoice'); END;

CREATE TRIGGER work_entry_guard BEFORE INSERT ON work_entries BEGIN
  SELECT RAISE(ABORT,'Cancelled projects cannot record work') WHERE EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND status='cancelled');
  SELECT RAISE(ABORT,'Reallocate the original project charge first') WHERE NEW.kind='debit' AND (SELECT billing_mode FROM tasks WHERE id=NEW.task_id)!='entries';
  SELECT RAISE(ABORT,'Allocation exceeds original charge') WHERE NEW.kind='allocation' AND ((SELECT billing_mode FROM tasks WHERE id=NEW.task_id)!='legacy'
    OR COALESCE((SELECT SUM(credits) FROM work_entries WHERE task_id=NEW.task_id AND kind='allocation'),0)+NEW.credits>(SELECT original_credits FROM tasks WHERE id=NEW.task_id));
  SELECT RAISE(ABORT,'Work entry is covered by an issued invoice') WHERE EXISTS(SELECT 1 FROM invoices i JOIN tasks t ON t.client_id=i.client_id WHERE t.id=NEW.task_id AND i.status IN ('issuing','open','paid')
    AND ((i.attribution_mode='legacy' AND i.cutoff>NEW.occurred_at) OR (i.attribution_mode='monthly' AND i.period=substr(NEW.occurred_at,1,7))));
END;
CREATE TRIGGER work_entry_charge AFTER INSERT ON work_entries WHEN NEW.kind='debit' BEGIN
  INSERT INTO ledger(id,client_id,task_id,kind,credits,note,created_by,actor_email)
    SELECT 'work-entry:'||NEW.id,client_id,id,'work',-NEW.credits,NEW.note,NEW.created_by,NEW.actor_email FROM tasks WHERE id=NEW.task_id;
  UPDATE tasks SET credits=credits+NEW.credits,details_version=details_version+1,updated_at=NEW.created_at,updated_by=NEW.created_by,updated_actor_email=NEW.actor_email WHERE id=NEW.task_id;
END;
CREATE TRIGGER work_entry_immutable BEFORE UPDATE ON work_entries
WHEN NEW.id!=OLD.id OR NEW.task_id!=OLD.task_id OR NEW.credits!=OLD.credits OR NEW.hours!=OLD.hours OR NEW.kind!=OLD.kind
  OR NEW.source_type IS NOT OLD.source_type OR NEW.source_id IS NOT OLD.source_id OR NEW.reallocation_id IS NOT OLD.reallocation_id
  OR NEW.created_at!=OLD.created_at OR NEW.created_by!=OLD.created_by OR NEW.actor_email!=OLD.actor_email
BEGIN SELECT RAISE(ABORT,'Work entry charge is immutable'); END;
CREATE TRIGGER work_entry_locked BEFORE UPDATE ON work_entries
WHEN (NEW.occurred_at!=OLD.occurred_at OR NEW.note!=OLD.note) AND EXISTS(SELECT 1 FROM invoices i JOIN tasks t ON t.client_id=i.client_id WHERE t.id=OLD.task_id AND i.status IN ('issuing','open','paid')
  AND ((i.attribution_mode='legacy' AND i.cutoff>MIN(OLD.occurred_at,NEW.occurred_at))
    OR (i.attribution_mode='monthly' AND i.period IN (substr(OLD.occurred_at,1,7),substr(NEW.occurred_at,1,7)))))
BEGIN SELECT RAISE(ABORT,'Work entry is covered by an issued invoice'); END;
CREATE TRIGGER work_entry_no_delete BEFORE DELETE ON work_entries BEGIN SELECT RAISE(ABORT,'Work entries cannot be deleted'); END;
CREATE TRIGGER reallocation_locked BEFORE UPDATE OF billing_mode ON tasks
WHEN OLD.billing_mode='legacy' AND NEW.billing_mode='entries' AND EXISTS(SELECT 1 FROM invoices i WHERE i.client_id=OLD.client_id AND i.status IN ('issuing','open','paid')
  AND ((i.attribution_mode='legacy' AND i.cutoff>COALESCE(OLD.occurred_at,OLD.created_at))
    OR (i.attribution_mode='monthly' AND i.period=substr(COALESCE(OLD.occurred_at,OLD.created_at),1,7))))
BEGIN SELECT RAISE(ABORT,'Work entry is covered by an issued invoice'); END;
CREATE TABLE _work_migration_check(violations INTEGER CHECK(violations=0));
INSERT INTO _work_migration_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE _work_migration_check;
PRAGMA defer_foreign_keys = OFF;
