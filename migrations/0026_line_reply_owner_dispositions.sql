CREATE TABLE line_reply_owner_dispositions (
  event_id TEXT NOT NULL REFERENCES line_reply_dispatches(event_id),
  sequence INTEGER NOT NULL REFERENCES line_result_outbox(sequence),
  group_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('confirmed_acceptance','close_unverifiable')),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id, sequence),
  UNIQUE(sequence)
);
CREATE TRIGGER line_reply_owner_dispositions_no_update BEFORE UPDATE ON line_reply_owner_dispositions BEGIN
  SELECT RAISE(ABORT, 'owner dispositions are immutable');
END;
CREATE TRIGGER line_reply_owner_dispositions_no_delete BEFORE DELETE ON line_reply_owner_dispositions BEGIN
  SELECT RAISE(ABORT, 'owner dispositions are immutable');
END;
