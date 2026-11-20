ALTER TABLE publication_cleanup_intents ADD COLUMN deletion_acknowledged INTEGER CHECK (deletion_acknowledged IS NULL OR deletion_acknowledged = 1);
