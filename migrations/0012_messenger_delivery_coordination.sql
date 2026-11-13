CREATE TABLE messenger_write_intents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'completion')),
  business_key TEXT NOT NULL UNIQUE,
  source_key TEXT UNIQUE,
  payload_json TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared', 'dispatched', 'observed')),
  record_id TEXT
);
CREATE TABLE messenger_action_tokens (
  token TEXT PRIMARY KEY,
  binding_json TEXT NOT NULL
);
