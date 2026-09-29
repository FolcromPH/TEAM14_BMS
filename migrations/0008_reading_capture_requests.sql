CREATE TABLE IF NOT EXISTS reading_capture_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'captured')),
  captured_at_ms INTEGER,
  reading_id INTEGER REFERENCES readings(id)
);

ALTER TABLE readings
ADD COLUMN capture_request_id INTEGER REFERENCES reading_capture_requests(id);

CREATE INDEX IF NOT EXISTS readings_capture_request_idx
  ON readings(capture_request_id);