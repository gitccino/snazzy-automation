CREATE TABLE publication_cleanup_intents (
  publication_run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  origin_workflow_id TEXT NOT NULL,
  context_json TEXT,
  doc_id TEXT NOT NULL,
  PRIMARY KEY (publication_run_id, generation, notification_cycle),
  FOREIGN KEY (publication_run_id) REFERENCES publication_jobs(publication_run_id)
);
