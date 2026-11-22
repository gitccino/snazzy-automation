# Implementation plan

1. Add validated mapping schema, client preset and a product-scoped fetch adapter. Test translated formulas, query/body fields, responses, metadata, failures and isolation.
2. Integrate stored/runtime/captured settings, acknowledgment and connection validation. Wire every product adapter including owner recovery and setup checks using captured settings.
3. Expand status reads, restrict sales to In/Reserve, preserve revert snapshots, and show extended status in search. Test sales and reports.
4. Self-review wiring and mutation safety. Run typecheck, focused tests and full suite; record baseline failures and production handoff requirements. Commit local changes.

## Completed local implementation and evidence

All four implementation steps are complete. Mapping covers inventory/search/sales/revert/reporting, import and import verification, publication product/image reads and writes, messenger product lookup, setup/sequence checks, and historical owner recovery. Captured settings retain the mapping; pending mutation comparisons use resolved field names. Missing publication data is described using client field names.

Self-review corrected an owner-recovery compatibility issue: its provider adapter now receives the exact context already captured by the evidence verifier, including legacy partial evidence, rather than independently parsing or rereading a different context. Unknown inventory status expectations were updated to the approved display-and-block behavior. Mapping remains API-configured; no visual editor or schema automation was introduced.

Validation on 2026-11-22:
- Typecheck and diff check passed.
- Mapping, inventory, settings/context, owner-recovery and revert focused checks passed; additional status/validation edge regressions passed.
- Settings application: 19 tests passed and production build passed.
- Seeded local Node/Wrangler owner CLI check passed.
- Final complete Vitest suite: 1,426 passed, 9 failed across 129 files. The nine known baseline failures are two LINE parser expectations (`/search A1234`, `/soldout A1234 ราคา 1290`), one daily-sales requested-fields expectation, and six invalid sold-price wording expectations. No additional failing tests remain. These unrelated failures are not claimed fixed or accepted for release.

No remote schema, settings, record or deployment changes were made. Live client field types/options, calculated fields, reciprocal links and provider behavior still require production handoff validation. See `docs/runbooks/airtable-product-mapping.md`. No D1 migration is required; both Workers must understand the optional settings/context field before enabling it. Preserve old physical fields until captured operations finish.
