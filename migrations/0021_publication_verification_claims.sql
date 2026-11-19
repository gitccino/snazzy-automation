CREATE TABLE publication_verification_claims (
  publication_run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  origin_workflow_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  verifier_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (publication_run_id, generation, notification_cycle),
  FOREIGN KEY (publication_run_id) REFERENCES publication_jobs(publication_run_id)
);
