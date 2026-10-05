-- Existing agreements remain hourly; no historical balances or dates change.
ALTER TABLE tasks ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'hourly' CHECK(pricing_model IN ('fixed','hourly'));
ALTER TABLE tasks ADD COLUMN fixed_credits INTEGER CHECK(fixed_credits>0 AND fixed_credits<=10000);
ALTER TABLE tasks ADD COLUMN budget_credits INTEGER CHECK(budget_credits>0 AND budget_credits<=10000);
CREATE TABLE project_charges (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), occurred_at TEXT NOT NULL,
 credits INTEGER NOT NULL CHECK(credits>0 AND credits<=10000), note TEXT NOT NULL,
 created_by TEXT NOT NULL, actor_email TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE time_entries (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), occurred_at TEXT NOT NULL,
 hours REAL NOT NULL CHECK(hours>0 AND hours<=2500 AND hours*4=CAST(hours*4 AS INTEGER)), note TEXT NOT NULL,
 source_type TEXT, source_id TEXT,
 created_by TEXT NOT NULL, actor_email TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((source_type IS NULL AND source_id IS NULL) OR (source_type IN ('email','text','call','meeting','other') AND source_id IS NOT NULL)),
 UNIQUE(task_id,source_type,source_id)
);
CREATE TABLE project_agreement_changes (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 approval_note TEXT NOT NULL, created_by TEXT NOT NULL, actor_email TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_terms_guard BEFORE INSERT ON tasks BEGIN
 SELECT RAISE(ABORT,'Invalid project agreement') WHERE
 (NEW.pricing_model='fixed' AND (NEW.fixed_credits IS NULL OR NEW.credits!=0 OR NEW.budget_credits IS NOT NULL OR NEW.billing_mode!='entries'))
 OR (NEW.pricing_model='hourly' AND (NEW.fixed_credits IS NOT NULL OR (NEW.budget_credits IS NOT NULL AND NEW.credits>NEW.budget_credits)));
END;
CREATE TRIGGER project_terms_update_guard BEFORE UPDATE ON tasks BEGIN
 SELECT RAISE(ABORT,'Invalid project agreement') WHERE
 (NEW.pricing_model='fixed' AND (NEW.fixed_credits IS NULL OR NEW.fixed_credits<NEW.credits OR NEW.budget_credits IS NOT NULL))
 OR (NEW.pricing_model='hourly' AND (NEW.fixed_credits IS NOT NULL OR (NEW.budget_credits IS NOT NULL AND NEW.credits>NEW.budget_credits)));
 SELECT RAISE(ABORT,'Agreement changes require approval') WHERE
 (NEW.pricing_model!=OLD.pricing_model OR NEW.fixed_credits IS NOT OLD.fixed_credits OR NEW.budget_credits IS NOT OLD.budget_credits)
 AND NOT EXISTS(SELECT 1 FROM project_agreement_changes WHERE task_id=OLD.id AND before_json=json_object('pricingModel',OLD.pricing_model,'fixedCredits',OLD.fixed_credits,'budgetCredits',OLD.budget_credits,'version',OLD.details_version)
 AND after_json=json_object('pricingModel',NEW.pricing_model,'fixedCredits',NEW.fixed_credits,'budgetCredits',NEW.budget_credits,'version',NEW.details_version));
END;
CREATE TRIGGER work_entry_agreement_guard BEFORE INSERT ON work_entries WHEN NEW.kind='debit' BEGIN
 SELECT RAISE(ABORT,'Fixed-price hours do not deduct credits; use time entries') WHERE (SELECT pricing_model FROM tasks WHERE id=NEW.task_id)='fixed';
 SELECT RAISE(ABORT,'Approved hourly budget exceeded') WHERE EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND budget_credits IS NOT NULL AND credits+NEW.credits>budget_credits);
END;
CREATE TRIGGER time_entry_guard BEFORE INSERT ON time_entries BEGIN
 SELECT RAISE(ABORT,'Internal time entries require an active fixed-price project') WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND pricing_model='fixed' AND status!='cancelled');
END;
CREATE TRIGGER time_entry_no_update BEFORE UPDATE ON time_entries BEGIN SELECT RAISE(ABORT,'Internal time records are immutable'); END;
CREATE TRIGGER time_entry_no_delete BEFORE DELETE ON time_entries BEGIN SELECT RAISE(ABORT,'Internal time records are immutable'); END;
CREATE TRIGGER project_charge_guard BEFORE INSERT ON project_charges BEGIN
 SELECT RAISE(ABORT,'Fixed-price charge exceeds agreement or project is closed') WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND pricing_model='fixed' AND billing_mode='entries' AND status!='cancelled' AND credits+NEW.credits<=fixed_credits);
 SELECT RAISE(ABORT,'Work entry is covered by an issued invoice') WHERE EXISTS(SELECT 1 FROM invoices i JOIN tasks t ON t.client_id=i.client_id WHERE t.id=NEW.task_id AND i.status IN ('issuing','open','paid') AND ((i.attribution_mode='legacy' AND i.cutoff>NEW.occurred_at) OR (i.attribution_mode='monthly' AND i.period=substr(NEW.occurred_at,1,7))));
END;
CREATE TRIGGER project_charge_debit AFTER INSERT ON project_charges BEGIN
 INSERT INTO ledger(id,client_id,task_id,kind,credits,note,created_by,actor_email)
 SELECT 'project-charge:'||NEW.id,client_id,id,'work',-NEW.credits,NEW.note,NEW.created_by,NEW.actor_email FROM tasks WHERE id=NEW.task_id;
 UPDATE tasks SET credits=credits+NEW.credits,details_version=details_version+1,updated_at=NEW.created_at,updated_by=NEW.created_by,updated_actor_email=NEW.actor_email WHERE id=NEW.task_id;
END;
CREATE TRIGGER project_charge_no_update BEFORE UPDATE ON project_charges BEGIN SELECT RAISE(ABORT,'Fixed-price charges are immutable'); END;
CREATE TRIGGER project_charge_no_delete BEFORE DELETE ON project_charges BEGIN SELECT RAISE(ABORT,'Fixed-price charges are immutable'); END;
DROP TRIGGER task_no_recharge;
CREATE TRIGGER task_no_recharge BEFORE UPDATE ON tasks
WHEN NEW.client_id!=OLD.client_id OR NEW.id!=OLD.id
  OR (NEW.original_credits!=OLD.original_credits AND NOT (OLD.billing_mode='legacy' AND OLD.original_credits=0 AND NEW.original_credits=OLD.credits AND NOT EXISTS(SELECT 1 FROM ledger WHERE task_id=OLD.id AND kind='work')))
  OR (OLD.status='cancelled' AND NEW.status!='cancelled')
  OR (OLD.billing_mode='entries' AND NEW.billing_mode!='entries')
  OR (NEW.billing_mode='legacy' AND NEW.credits!=OLD.credits)
  OR (NEW.billing_mode='entries' AND NEW.credits!=NEW.original_credits+COALESCE((SELECT SUM(credits) FROM work_entries WHERE task_id=NEW.id AND kind='debit'),0)+COALESCE((SELECT SUM(credits) FROM project_charges WHERE task_id=NEW.id),0))
  OR (OLD.billing_mode='legacy' AND NEW.billing_mode='entries' AND NEW.original_credits!=COALESCE((SELECT SUM(credits) FROM work_entries WHERE task_id=NEW.id AND kind='allocation'),0))
BEGIN SELECT RAISE(ABORT,'Work charge and cancellation are immutable'); END;

DROP VIEW billable_work;
CREATE VIEW billable_work AS
 SELECT 'legacy:'||id AS id,client_id,id AS task_id,COALESCE(occurred_at,created_at) AS occurred_at,credits FROM tasks WHERE billing_mode='legacy' AND status!='cancelled'
 UNION ALL SELECT e.id,t.client_id,t.id,e.occurred_at,e.credits FROM work_entries e JOIN tasks t ON t.id=e.task_id WHERE t.billing_mode='entries' AND t.status!='cancelled'
 UNION ALL SELECT e.id,t.client_id,t.id,e.occurred_at,e.credits FROM project_charges e JOIN tasks t ON t.id=e.task_id WHERE t.billing_mode='entries' AND t.status!='cancelled';

CREATE TRIGGER agreement_history_no_update BEFORE UPDATE ON project_agreement_changes BEGIN SELECT RAISE(ABORT,'Agreement history is immutable'); END;
CREATE TRIGGER agreement_history_no_delete BEFORE DELETE ON project_agreement_changes BEGIN SELECT RAISE(ABORT,'Agreement history is immutable'); END;
