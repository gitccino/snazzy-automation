CREATE TABLE product_image_preparations (
  record_id TEXT PRIMARY KEY, owner_workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  state TEXT NOT NULL CHECK(state IN ('preparing','replacing','ready','failed','conflicted')),
  snapshot_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  intent_json TEXT, safe_error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE product_image_originals (
  record_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
  attachment_kind TEXT NOT NULL CHECK(attachment_kind IN ('source','preview')),
  original_filename TEXT NOT NULL, content_hash TEXT NOT NULL, r2_key TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type = 'image/jpeg'), byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  preview_filename TEXT NOT NULL, variant TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(record_id, attachment_id)
);
