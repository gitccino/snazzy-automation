# Airtable product field mapping and inventory statuses

Preserve the client's existing Products table and records. Configure a nonsecret `AIRTABLE_PRODUCT_FIELD_MAP` per environment through the existing connections settings API. Omitted fields keep their English names. Additional tables keep English names. Brand Name and Model Name accept existing single-select string values; never create options automatically.

Map Product ID → รหัสสินค้าstock; Upload Date → วันที่อัพโหลดรูป; Product Images → รูปสินค้า; Inventory Status → สถานะ; Sold Price → ราคาขาย; Brand Name → ชื่อแบรนด์; Model Name → ชื่อรุ่น; Size → Size; Description → รายละเอียดสินค้า; LINE Square Price → ราคาLinesquare; IG Price → ราคาIG; Product Cost → ราคารับซื้อ. Missing fields and additional system fields are added separately during production handoff. Publication Run is the singular product link field.

Translate product requests, formulas, projections and responses at the Airtable boundary. Scope translation to the configured base/product table and its metadata. Reject invalid, ambiguous or colliding mappings; preserve provider errors. Mapping is captured with accepted operations so retries and confirmations use the original schema. Legacy contexts retain English identity mapping. Changing mapping requires connection validation and acknowledgment.

Read and display any nonempty inventory status. Only In and Reserve may transition to Out through /soldout. Out remains already sold; Rent, Trade, Pledge and unknown statuses are blocked with the actual status. Recheck before mutation; revert restores the precise previous state, including Reserve. Reports count Out only.

Acceptance: Thai reads/writes/formulas, quoted formula literals, table isolation, mapping validation, saved-context compatibility, Reserve sale/revert, blocked statuses and Out-only reporting. No automatic field creation, record migration, option creation or production deployment.
