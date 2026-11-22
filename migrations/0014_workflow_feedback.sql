CREATE TABLE workflow_feedback (
  kind TEXT NOT NULL CHECK(kind IN ('import','publication')),
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  event_id TEXT,
  stage TEXT NOT NULL,
  failure_code TEXT,
  references_json TEXT NOT NULL DEFAULT '{}',
  repair_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(kind, run_id, generation, notification_cycle)
);
CREATE INDEX workflow_feedback_group ON workflow_feedback(group_id);
CREATE TABLE workflow_feedback_results (
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  notification_cycle INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  result_key TEXT NOT NULL UNIQUE,
  outcome_json TEXT NOT NULL,
  group_id TEXT NOT NULL,
  materialized INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, run_id, generation, notification_cycle, revision),
  FOREIGN KEY(kind, run_id, generation, notification_cycle) REFERENCES workflow_feedback(kind, run_id, generation, notification_cycle)
);
CREATE INDEX workflow_feedback_pending_group ON workflow_feedback_results(group_id, materialized, revision);
CREATE TABLE workflow_feedback_group_evidence (
  kind TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL, notification_cycle INTEGER NOT NULL,
  evidence_key TEXT NOT NULL, evidence_json TEXT NOT NULL,
  PRIMARY KEY(kind, run_id, generation, notification_cycle, evidence_key),
  FOREIGN KEY(kind, run_id, generation, notification_cycle) REFERENCES workflow_feedback(kind, run_id, generation, notification_cycle)
);
