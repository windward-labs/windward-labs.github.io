PRAGMA defer_foreign_keys = ON;

-- Rebuild only the two tables whose CHECK constraints change. IDs and all
-- ledger rows are preserved; child foreign keys keep their original targets.
DROP TRIGGER ledger_balance;
DROP TRIGGER task_charge;
DROP TRIGGER task_refund;
DROP TRIGGER ledger_no_update;
DROP TRIGGER ledger_no_delete;
CREATE TABLE clients_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO clients_new SELECT * FROM clients;
DROP TABLE clients;
ALTER TABLE clients_new RENAME TO clients;
CREATE TABLE ledger_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('purchase','work','refund','billing')),
  credits INTEGER NOT NULL CHECK(credits != 0),
  reference TEXT UNIQUE,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK(kind='billing' OR (kind='work' AND credits<0) OR (kind IN ('purchase','refund') AND credits>0))
);
INSERT INTO ledger_new SELECT * FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX ledger_client ON ledger(client_id, created_at);
CREATE TRIGGER ledger_balance AFTER INSERT ON ledger BEGIN
  UPDATE clients SET balance=balance+NEW.credits WHERE id=NEW.client_id;
END;
CREATE TRIGGER task_charge AFTER INSERT ON tasks BEGIN
  INSERT INTO ledger (id,client_id,task_id,kind,credits,note,created_by,actor_email)
    VALUES ('work:'||NEW.id,NEW.client_id,NEW.id,'work',-NEW.credits,NEW.title,NEW.created_by,NEW.actor_email);
END;
CREATE TRIGGER task_refund AFTER UPDATE OF status ON tasks
WHEN NEW.status='cancelled' AND OLD.status!='cancelled' BEGIN
  INSERT INTO ledger (id,client_id,task_id,kind,credits,note,created_by,actor_email)
    VALUES ('refund:'||NEW.id,NEW.client_id,NEW.id,'refund',NEW.credits,'Cancelled: '||NEW.title,NEW.updated_by,NEW.updated_actor_email);
END;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN
  SELECT RAISE(ABORT,'Ledger entries are immutable');
END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN
  SELECT RAISE(ABORT,'Ledger entries are immutable');
END;

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  period TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  email TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK(credits>0),
  amount_cents INTEGER NOT NULL CHECK(amount_cents=credits*7500),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issuing','open','paid','void')),
  stripe_mode TEXT NOT NULL CHECK(stripe_mode IN ('test','live')),
  stripe_customer_id TEXT,
  stripe_invoice_id TEXT UNIQUE,
  hosted_invoice_url TEXT,
  number TEXT,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX invoices_month ON invoices(client_id,period) WHERE status!='void';
CREATE TRIGGER invoice_transfer AFTER UPDATE OF status ON invoices
WHEN OLD.status='draft' AND NEW.status='issuing' BEGIN
  INSERT INTO ledger (id,client_id,kind,credits,reference,note,created_by,actor_email)
    VALUES ('invoice:'||NEW.id,NEW.client_id,'billing',NEW.credits,'invoice:'||NEW.id,
      NEW.credits||' credits moved to invoice for '||NEW.period,NEW.created_by,NEW.actor_email);
END;
CREATE TRIGGER invoice_void AFTER UPDATE OF status ON invoices
WHEN OLD.status IN ('issuing','open') AND NEW.status='void' BEGIN
  INSERT INTO ledger (id,client_id,kind,credits,reference,note,created_by,actor_email)
    VALUES ('invoice-void:'||NEW.id,NEW.client_id,'billing',-NEW.credits,'invoice-void:'||NEW.id,
      'Voided invoice for '||NEW.period||': credits returned to unbilled balance',NEW.created_by,NEW.actor_email);
END;
CREATE TRIGGER invoice_immutable BEFORE UPDATE ON invoices
WHEN NEW.id!=OLD.id OR NEW.client_id!=OLD.client_id OR NEW.credits!=OLD.credits OR NEW.amount_cents!=OLD.amount_cents OR NEW.period!=OLD.period OR NEW.cutoff!=OLD.cutoff OR NEW.email!=OLD.email OR NEW.stripe_mode!=OLD.stripe_mode
  OR (OLD.status IN ('paid','void') AND NEW.status!=OLD.status)
  OR (OLD.status='open' AND NEW.status NOT IN ('open','paid','void'))
  OR (OLD.status='issuing' AND NEW.status='draft') BEGIN
  SELECT RAISE(ABORT,'Invoice terms and settlements are immutable');
END;

-- Validate the final graph before clearing SQLite's deferred DROP counters.
CREATE TABLE _billing_migration_check (violations INTEGER CHECK(violations=0));
INSERT INTO _billing_migration_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE _billing_migration_check;
PRAGMA defer_foreign_keys = OFF;
