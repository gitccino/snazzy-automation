CREATE TABLE airtable_create_claims (
  group_id TEXT PRIMARY KEY REFERENCES product_groups(id),
  product_id TEXT NOT NULL,
  base_id TEXT NOT NULL,
  table_id TEXT NOT NULL
);
