ALTER TABLE publication_jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE publication_jobs ADD COLUMN successful_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publication_jobs ADD COLUMN finalization_json TEXT;
UPDATE publication_jobs SET successful_generation = 1
WHERE google_doc_id IS NOT NULL AND google_doc_url IS NOT NULL;
