CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL,
  bootstrapped_at TEXT
);

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  source_album_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'line', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_failures', 'start_failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  orphan_photo_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_import_runs_album ON import_runs(source_album_id, started_at);
CREATE UNIQUE INDEX idx_import_runs_one_running_album
  ON import_runs(source_album_id)
  WHERE status = 'running';

CREATE TABLE import_checkpoints (
  source_album_id TEXT PRIMARY KEY,
  last_position INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE photo_assets (
  id TEXT PRIMARY KEY,
  source_album_id TEXT NOT NULL,
  apple_photo_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_marker INTEGER NOT NULL DEFAULT 0,
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_album_id, apple_photo_id)
);
CREATE INDEX idx_photo_assets_content_hash ON photo_assets(content_hash);
CREATE INDEX idx_photo_assets_album_position ON photo_assets(source_album_id, position);

CREATE TABLE product_groups (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  ordinal INTEGER NOT NULL,
  group_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'importing', 'succeeded', 'failed')),
  product_id TEXT,
  airtable_record_id TEXT,
  first_photo_id TEXT NOT NULL,
  last_photo_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_product_groups_product_id ON product_groups(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_product_groups_airtable_record ON product_groups(airtable_record_id);
CREATE INDEX idx_product_groups_state ON product_groups(state);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_events_correlation ON audit_events(correlation_id);
