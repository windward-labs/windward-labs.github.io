CREATE TABLE wire_receipts (
  ledger_id TEXT PRIMARY KEY REFERENCES ledger(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  received_at TEXT NOT NULL,
  verification_note TEXT NOT NULL
);
