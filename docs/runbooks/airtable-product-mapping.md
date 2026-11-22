# Client product schema handoff

Configure each environment independently. No table or field is renamed by this feature. Leave staging's map absent or `{}` to retain English fields.

1. Verify the client base/table IDs and field names, including capitalization. Add missing English system fields: `System Group ID`, `4-in-1 Image`, `Condition Type`, `Publication Run`, `Sold At`, `Sold By`, `Last System Update`, `Data Complete`, `Missing Fields`. Configure the reciprocal Publication Run link and existing completeness formulas for the actual client fields. Publication Runs and Messenger Deliveries retain the existing English schemas. Brand/model may be single select or text. Existing single-select options are preserved; no automatic typecast is used.
2. Ensure `สถานะ` has `In` and `Out`; `Reserve`, `Rent`, `Trade`, `Pledge` and other options are allowed. Only `In` and `Reserve` permit /soldout. Only `Out` counts as a sale. Upload creates `In`; revert restores the pre-sale state.
3. Deploy compatible automation and settings Workers before saving the map. Inventory active jobs and pending confirmations first. Captured operations keep their old field mapping; retain those fields until they finish. Do not rename physical fields during running work.
4. Through the authenticated settings site's existing API, PATCH `/api/settings/sections/connections` with the current `expectedRevision`, `section: "connections"`, `acknowledgeAirtableChange: true`, and this `changes` object:

```json
{
  "AIRTABLE_PRODUCT_FIELD_MAP": {
    "Product ID": "รหัสสินค้าstock",
    "Upload Date": "วันที่อัพโหลดรูป",
    "Product Images": "รูปสินค้า",
    "Inventory Status": "สถานะ",
    "Sold Price": "ราคาขาย",
    "Brand Name": "ชื่อแบรนด์",
    "Model Name": "ชื่อรุ่น",
    "Description": "รายละเอียดสินค้า",
    "LINE Square Price": "ราคาLinesquare",
    "IG Price": "ราคาIG",
    "Product Cost": "ราคารับซื้อ"
  }
}
```

Omitted names, including Size, keep their English names. The mapping is available through the settings API and export; there is no new visual mapping editor. A save checks metadata and rejects missing fields or incompatible brand/model types. It creates no fields, options or records. Formula field names containing braces/control characters and duplicate resolved names are rejected.

5. In isolated client-shaped fixtures verify /search, one import, /docs with complete and missing fields, In and Reserve sales, confirmation after an intervening edit, /revert back to Reserve, blocked Rent/Trade/Pledge/unknown statuses, Out-only daily reports, and messenger product lookup. Verify that new system fields and the existing client fields receive the correct values.

To roll back a mapping, drain pending work first, then restore the previous saved map using a new settings revision. Old code cannot read the new settings key; remove it before reverting to an incompatible Worker version. Preserve exported settings and D1 evidence. Production schema and provider verification are separate handoff work.
