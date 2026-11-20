ALTER TABLE line_reply_dispatches ADD COLUMN rejection_proven INTEGER NOT NULL DEFAULT 0 CHECK(rejection_proven IN (0,1));
