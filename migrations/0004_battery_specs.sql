CREATE TABLE IF NOT EXISTS battery_specs (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
  name TEXT NOT NULL,
  voltage_v REAL NOT NULL CHECK (voltage_v > 0),
  capacity_mah INTEGER NOT NULL CHECK (capacity_mah > 0),
  updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO battery_specs (slot, name, voltage_v, capacity_mah, updated_at_ms)
VALUES
  (1, 'Battery 1', 12, 10000, 0),
  (2, 'Battery 2', 12, 2200, 0);
