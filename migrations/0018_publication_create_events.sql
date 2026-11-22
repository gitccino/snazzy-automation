CREATE TABLE publication_events_new (
  event_id TEXT PRIMARY KEY,
  publication_run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('regenerate', 'create')),
  job_json TEXT NOT NULL,
  handoff_status TEXT,
  group_id TEXT,
  ingress_operation TEXT
);
INSERT INTO publication_events_new (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json, handoff_status)
SELECT event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json, handoff_status FROM publication_regeneration_events;
DROP TABLE publication_regeneration_events;
ALTER TABLE publication_events_new RENAME TO publication_regeneration_events;
