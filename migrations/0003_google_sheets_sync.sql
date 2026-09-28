CREATE TABLE IF NOT EXISTS integration_cursors (
  name TEXT PRIMARY KEY,
  last_reading_id INTEGER NOT NULL DEFAULT 0
);
