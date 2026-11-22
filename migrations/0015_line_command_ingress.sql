CREATE TABLE line_command_ingress (
  event_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);
