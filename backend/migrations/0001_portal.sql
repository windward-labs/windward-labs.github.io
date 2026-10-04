PRAGMA foreign_keys = ON;

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE client_members (
  client_id TEXT NOT NULL REFERENCES clients(id),
  email TEXT NOT NULL,
  PRIMARY KEY(client_id, email)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('email','text','call','meeting','other')),
  credits INTEGER NOT NULL CHECK(credits > 0),
  status TEXT NOT NULL CHECK(status IN ('queued','in_progress','completed','cancelled')),
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  updated_by TEXT,
  updated_actor_email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX tasks_client ON tasks(client_id, created_at);
CREATE TABLE task_updates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('purchase','work','refund')),
  credits INTEGER NOT NULL CHECK(credits != 0),
  reference TEXT UNIQUE,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK((kind = 'work' AND credits < 0) OR (kind IN ('purchase','refund') AND credits > 0))
);
CREATE INDEX ledger_client ON ledger(client_id, created_at);

-- A debit and its balance update are one statement/transaction. The balance
-- CHECK rejects overdrafts, rolling back the task and ledger together.
CREATE TRIGGER ledger_balance AFTER INSERT ON ledger BEGIN
  UPDATE clients SET balance = balance + NEW.credits WHERE id = NEW.client_id;
END;
CREATE TRIGGER task_charge AFTER INSERT ON tasks BEGIN
  INSERT INTO ledger (id,client_id,task_id,kind,credits,note,created_by,actor_email)
    VALUES ('work:' || NEW.id,NEW.client_id,NEW.id,'work',-NEW.credits,NEW.title,NEW.created_by,NEW.actor_email);
END;
CREATE TRIGGER task_refund AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'cancelled' AND OLD.status != 'cancelled' BEGIN
  INSERT INTO ledger (id,client_id,task_id,kind,credits,note,created_by,actor_email)
    VALUES ('refund:' || NEW.id,NEW.client_id,NEW.id,'refund',NEW.credits,'Cancelled: ' || NEW.title,NEW.updated_by,NEW.updated_actor_email);
END;
CREATE TRIGGER task_no_recharge BEFORE UPDATE ON tasks
WHEN NEW.credits != OLD.credits OR NEW.client_id != OLD.client_id OR NEW.id != OLD.id OR (OLD.status = 'cancelled' AND NEW.status != 'cancelled') BEGIN
  SELECT RAISE(ABORT, 'Work charge and cancellation are immutable');
END;
CREATE TRIGGER task_no_delete BEFORE DELETE ON tasks BEGIN
  SELECT RAISE(ABORT, 'Work records cannot be deleted');
END;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN
  SELECT RAISE(ABORT, 'Ledger entries are immutable');
END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN
  SELECT RAISE(ABORT, 'Ledger entries are immutable');
END;
