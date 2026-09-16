CREATE TABLE publication_jobs (
  publication_run_id TEXT PRIMARY KEY,
  publication_date TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('locked', 'validating', 'validation_failed', 'generating', 'succeeded', 'failed')),
  correlation_id TEXT NOT NULL,
  google_doc_id TEXT,
  google_doc_url TEXT,
  temp_doc_id TEXT,
  validation_result_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE publication_product_cache (
  publication_run_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  collage_r2_key TEXT,
  collage_input_fingerprint TEXT,
  captions_json TEXT,
  captions_input_fingerprint TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (publication_run_id, product_id),
  FOREIGN KEY (publication_run_id) REFERENCES publication_jobs (publication_run_id)
);

CREATE INDEX idx_publication_product_cache_run ON publication_product_cache (publication_run_id);
