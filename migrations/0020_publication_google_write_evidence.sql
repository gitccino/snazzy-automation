CREATE TABLE publication_google_write_evidence (
  publication_run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (publication_run_id, generation, notification_cycle)
);
