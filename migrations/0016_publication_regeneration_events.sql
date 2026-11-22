CREATE TABLE publication_regeneration_events (
  event_id TEXT PRIMARY KEY,
  publication_run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'regenerate'),
  job_json TEXT NOT NULL
);
