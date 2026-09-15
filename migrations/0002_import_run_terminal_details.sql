ALTER TABLE import_runs ADD COLUMN checkpoint_position INTEGER;
ALTER TABLE import_runs ADD COLUMN failure_reason TEXT;
