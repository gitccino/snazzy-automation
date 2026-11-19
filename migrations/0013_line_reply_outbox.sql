CREATE TABLE line_result_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  result_key TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','dispatched','accepted','uncertain','blocked')),
  owner_event_id TEXT
);
CREATE INDEX line_result_outbox_group_sequence ON line_result_outbox(group_id, sequence);
CREATE TABLE line_reply_dispatches (
  event_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  candidate_sequence INTEGER REFERENCES line_result_outbox(sequence),
  messages_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','accepted','rejected','uncertain','abandoned')),
  updated_at TEXT NOT NULL,
  request_id TEXT,
  http_status INTEGER,
  disposition TEXT
);
ALTER TABLE publication_jobs ADD COLUMN notification_cycle INTEGER NOT NULL DEFAULT 1;
