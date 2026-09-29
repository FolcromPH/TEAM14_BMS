CREATE TABLE IF NOT EXISTS battery_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  name TEXT NOT NULL,
  voltage_v REAL NOT NULL,
  capacity_mah REAL NOT NULL,
  created_at_ms INTEGER NOT NULL
);

INSERT INTO battery_identities (slot, name, voltage_v, capacity_mah, created_at_ms)
SELECT slot, name, voltage_v, capacity_mah, updated_at_ms
FROM battery_specs;

ALTER TABLE battery_specs
ADD COLUMN identity_id INTEGER REFERENCES battery_identities(id);

UPDATE battery_specs
SET identity_id = (
  SELECT id
  FROM battery_identities
  WHERE battery_identities.slot = battery_specs.slot
  ORDER BY id DESC
  LIMIT 1
);

ALTER TABLE readings
ADD COLUMN battery1_identity_id INTEGER REFERENCES battery_identities(id);

ALTER TABLE readings
ADD COLUMN battery2_identity_id INTEGER REFERENCES battery_identities(id);

UPDATE readings
SET battery1_identity_id = (
      SELECT id FROM battery_identities WHERE slot = 1 ORDER BY id DESC LIMIT 1
    ),
    battery2_identity_id = (
      SELECT id FROM battery_identities WHERE slot = 2 ORDER BY id DESC LIMIT 1
    );

CREATE INDEX IF NOT EXISTS battery_identities_slot_created_idx
  ON battery_identities(slot, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS readings_battery_identity_timestamp_idx
  ON readings(battery1_identity_id, battery2_identity_id, timestamp_ms DESC);