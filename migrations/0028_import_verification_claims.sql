CREATE TABLE import_verification_claims (
  import_run_id TEXT PRIMARY KEY REFERENCES import_runs(id),
  source_album_id TEXT NOT NULL,
  origin_workflow_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  verifier_id TEXT NOT NULL UNIQUE
);
