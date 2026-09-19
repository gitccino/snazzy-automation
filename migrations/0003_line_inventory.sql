CREATE TABLE line_events (
  event_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE pending_line_commands (
  token TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  apply_event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('soldout', 'revert')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'approved', 'rejected', 'expired')),
  requester_user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  sold_price INTEGER CHECK (sold_price IS NULL OR sold_price > 0),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  target_action_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_actor TEXT
);
CREATE INDEX idx_pending_line_group_status ON pending_line_commands(group_id, status, expires_at);
CREATE UNIQUE INDEX idx_one_active_revert_per_action
  ON pending_line_commands(target_action_id)
  WHERE kind = 'revert' AND status IN ('pending', 'applying');

CREATE TABLE line_actions (
  id TEXT PRIMARY KEY,
  pending_token TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('soldout', 'revert')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverted_by_action_id TEXT
);
CREATE INDEX idx_line_actions_group_created ON line_actions(group_id, created_at DESC);
