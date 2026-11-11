ALTER TABLE clients ADD COLUMN wire_enabled INTEGER NOT NULL DEFAULT 0 CHECK (wire_enabled IN (0,1));
ALTER TABLE clients ADD COLUMN wire_instructions TEXT NOT NULL DEFAULT '';
