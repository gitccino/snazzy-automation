ALTER TABLE publication_cleanup_intents ADD COLUMN saved_temp_doc INTEGER CHECK (saved_temp_doc IS NULL OR saved_temp_doc = 1);
