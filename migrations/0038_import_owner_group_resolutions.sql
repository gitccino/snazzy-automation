CREATE TABLE import_owner_group_resolutions (
  group_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_group_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER import_owner_group_resolutions_no_update BEFORE UPDATE ON import_owner_group_resolutions BEGIN
  SELECT RAISE(ABORT, 'immutable resolution audit');
END;
CREATE TRIGGER import_owner_group_resolutions_no_delete BEFORE DELETE ON import_owner_group_resolutions BEGIN
  SELECT RAISE(ABORT, 'immutable resolution audit');
END;
