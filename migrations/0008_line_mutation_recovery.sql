CREATE TABLE pending_line_commands_recovery (
  token TEXT PRIMARY KEY, source_event_id TEXT NOT NULL UNIQUE, apply_event_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('soldout','revert')),
  status TEXT NOT NULL CHECK(status IN ('pending','applying','approved','rejected','expired','failed')),
  requester_user_id TEXT NOT NULL, group_id TEXT NOT NULL, product_id TEXT NOT NULL,
  sold_price INTEGER CHECK(sold_price IS NULL OR sold_price > 0),
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, target_action_id TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolver_actor TEXT,
  workflow_id TEXT, mutation_actor TEXT, mutation_correlation_id TEXT,
  resolution_reason TEXT, monitoring_state TEXT CHECK(monitoring_state IN ('registered','ended','unresolved'))
);
INSERT INTO pending_line_commands_recovery
  (rowid, token, source_event_id, apply_event_id, kind, status, requester_user_id, group_id,
   product_id, sold_price, before_json, after_json, target_action_id, expires_at, created_at, resolved_at, resolver_actor)
SELECT rowid, token, source_event_id, apply_event_id, kind, status, requester_user_id, group_id,
   product_id, sold_price, before_json, after_json, target_action_id, expires_at, created_at, resolved_at, resolver_actor
FROM pending_line_commands;
DROP TABLE pending_line_commands;
ALTER TABLE pending_line_commands_recovery RENAME TO pending_line_commands;
CREATE INDEX idx_pending_line_group_status ON pending_line_commands(group_id,status,expires_at);
CREATE UNIQUE INDEX idx_one_active_revert_per_action ON pending_line_commands(target_action_id)
  WHERE kind = 'revert' AND status IN ('pending','applying');
CREATE UNIQUE INDEX idx_one_active_line_mutation_per_product ON pending_line_commands(product_id)
  WHERE status IN ('pending','applying');
ALTER TABLE line_actions ADD COLUMN commit_seq INTEGER;
UPDATE line_actions SET commit_seq = rowid;
CREATE UNIQUE INDEX idx_line_action_commit_sequence ON line_actions(product_id,commit_seq);
CREATE TABLE line_mutation_attempts (
  id TEXT PRIMARY KEY, pending_token TEXT NOT NULL, record_id TEXT NOT NULL,
  intended_json TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'unknown'
    CHECK(outcome IN ('unknown','acknowledged','rejected')),
  started_at TEXT NOT NULL, completed_at TEXT, response_category TEXT
);
CREATE INDEX idx_line_mutation_attempt_token ON line_mutation_attempts(pending_token,outcome);
CREATE TABLE line_product_control (
  product_id TEXT PRIMARY KEY, owner_workflow_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('recovery','repair')), pending_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
