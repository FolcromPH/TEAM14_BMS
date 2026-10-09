-- Battery memory by name, per-cycle SOH history and the "same or new battery?" confirmation.

-- Rest voltage this battery shows at 100 % (learned from a Switching / SYSTEM OFF row after a full charge).
ALTER TABLE battery_identities ADD COLUMN full_voltage_v REAL;

-- One row per completed discharge cycle of one saved battery (identity).
-- soh_raw / soh_reported / cycle_number are NULL when the cycle ended without a rest-voltage reading
-- ('cc'): a coulomb-only SOC_final always reproduces the rated capacity and cannot show fade.
CREATE TABLE IF NOT EXISTS battery_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id INTEGER NOT NULL REFERENCES battery_identities(id),
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  cycle_number INTEGER,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  hours REAL NOT NULL,
  avg_load_a REAL NOT NULL,
  discharged_ah REAL NOT NULL,
  soc_start REAL NOT NULL,
  soc_final REAL NOT NULL,
  soc_final_source TEXT NOT NULL CHECK (soc_final_source IN ('ocv', 'cc', 'csv')),
  dod_percent REAL NOT NULL,
  capacity_ah REAL,
  soh_raw REAL,
  soh_reported REAL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS battery_cycles_identity_idx ON battery_cycles(identity_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS battery_cycles_identity_start_idx ON battery_cycles(identity_id, started_at_ms);

-- Running state of each sensor slot between telemetry posts (SOC chain, open discharge cycle, current SOH).
CREATE TABLE IF NOT EXISTS slot_state (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
  identity_id INTEGER,
  soc REAL,
  ts_ms INTEGER,
  connected INTEGER NOT NULL DEFAULT 0,
  tracker_json TEXT,
  soh REAL
);

-- Single row. pending = 1 means telemetry resumed after a break and the user has not yet said
-- whether the connected batteries are the same ones or new ones.
CREATE TABLE IF NOT EXISTS connection_sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pending INTEGER NOT NULL DEFAULT 0,
  since_reading_id INTEGER,
  gap_started_ms INTEGER,
  resumed_ms INTEGER,
  previous_identity1 INTEGER,
  previous_identity2 INTEGER,
  reason TEXT
);

INSERT OR IGNORE INTO connection_sessions (id, pending) VALUES (1, 0);
