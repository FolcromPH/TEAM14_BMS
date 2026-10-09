CREATE INDEX IF NOT EXISTS readings_battery1_timestamp_idx
  ON readings(battery1_identity_id, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS readings_battery2_timestamp_idx
  ON readings(battery2_identity_id, timestamp_ms DESC);
