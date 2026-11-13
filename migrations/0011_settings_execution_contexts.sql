ALTER TABLE import_runs ADD COLUMN settings_context_json TEXT;
ALTER TABLE publication_jobs ADD COLUMN settings_context_json TEXT;
ALTER TABLE pending_line_commands ADD COLUMN settings_context_json TEXT;
