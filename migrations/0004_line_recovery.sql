-- Keep the oldest unclicked confirmation unless an applying owner exists.
-- Applying rows may represent an uncertain Airtable write and must never be expired.
UPDATE pending_line_commands AS candidate
SET status = 'expired', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE candidate.status = 'pending' AND EXISTS (
  SELECT 1 FROM pending_line_commands AS owner
  WHERE owner.product_id = candidate.product_id AND owner.token != candidate.token
    AND (owner.status = 'applying'
      OR (owner.status = 'pending' AND owner.rowid < candidate.rowid))
);

-- Fail closed if legacy data already contains multiple applying owners. Reconcile
-- those writes before retrying migration; do not automatically release any owner.
CREATE UNIQUE INDEX idx_one_active_line_mutation_per_product
  ON pending_line_commands(product_id)
  WHERE status IN ('pending', 'applying');

-- Independent of the event claim: releasing a failed delivery must not erase the
-- command result or rerun its side effects on webhook redelivery.
CREATE TABLE line_event_replies (
  event_id TEXT PRIMARY KEY,
  reply_json TEXT NOT NULL
);
