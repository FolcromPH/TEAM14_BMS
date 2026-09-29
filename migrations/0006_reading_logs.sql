CREATE TABLE IF NOT EXISTS reading_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'completed'))
);

ALTER TABLE readings ADD COLUMN log_id INTEGER REFERENCES reading_logs(id);

CREATE INDEX IF NOT EXISTS readings_log_timestamp_idx
  ON readings(log_id, timestamp_ms DESC);