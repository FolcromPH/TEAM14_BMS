ALTER TABLE readings ADD COLUMN system_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS device_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode INTEGER NOT NULL CHECK (mode IN (1, 2, 3)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'applied', 'failed')),
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  acknowledged_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT
);

CREATE INDEX IF NOT EXISTS device_commands_status_idx
  ON device_commands(status, created_at_ms);
