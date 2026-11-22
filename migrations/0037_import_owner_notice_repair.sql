CREATE TABLE import_owner_notice_repairs (
  result_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER import_owner_notice_materialize AFTER INSERT ON import_owner_notice_repairs BEGIN
  INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at)
    VALUES(NEW.result_key,NEW.group_id,NEW.result_json,NEW.created_at);
  UPDATE workflow_feedback_results SET materialized=1 WHERE result_key=NEW.result_key AND group_id=NEW.group_id;
END;
