CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ms INTEGER NOT NULL,
  mode TEXT,
  switching INTEGER NOT NULL DEFAULT 0,
  wifi_json TEXT NOT NULL DEFAULT '{}',
  battery1_json TEXT NOT NULL DEFAULT '{}',
  battery2_json TEXT NOT NULL DEFAULT '{}',
  battery1_soc REAL,
  battery2_soc REAL,
  battery1_soh REAL,
  battery2_soh REAL
);

CREATE INDEX IF NOT EXISTS readings_timestamp_idx ON readings(timestamp_ms DESC);