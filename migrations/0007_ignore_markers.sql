CREATE TABLE photo_assets_next (
  id TEXT PRIMARY KEY,
  source_album_id TEXT NOT NULL,
  apple_photo_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT,
  position INTEGER NOT NULL,
  is_marker INTEGER NOT NULL DEFAULT 0,
  marker_kind TEXT CHECK (marker_kind IN ('product_start', 'ignore_start', 'none')),
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_album_id, apple_photo_id)
);
INSERT INTO photo_assets_next
  (id, source_album_id, apple_photo_id, content_hash, r2_key, position,
   is_marker, marker_kind, import_run_id, created_at)
SELECT id, source_album_id, apple_photo_id, content_hash, r2_key, position,
  is_marker, CASE WHEN is_marker = 1 THEN 'product_start' ELSE 'none' END,
  import_run_id, created_at
FROM photo_assets;
DROP TABLE photo_assets;
ALTER TABLE photo_assets_next RENAME TO photo_assets;
CREATE INDEX idx_photo_assets_content_hash ON photo_assets(content_hash);
CREATE INDEX idx_photo_assets_album_position ON photo_assets(source_album_id, position);
