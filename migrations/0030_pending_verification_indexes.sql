CREATE INDEX import_verification_pending_group ON import_verification_claims(group_id, import_run_id) WHERE completed IS NULL;
CREATE INDEX publication_verification_pending_group ON publication_verification_claims(group_id, publication_run_id) WHERE completed=0;
