# Daily sales report through LINE

Status: Approved by the user on 2026-10-07; implementation completed on `feat/daily-sales-report`. Deployment and live LINE validation are pending.

## Intent and agreed requirements

The owner wants an on-demand daily sales summary in LINE. `/report` defaults to the current day. The report includes each product's Product ID, Brand Name, Model Name, and Sold Price, followed by total revenue for the selected day.

The user explicitly chose current valid sales: a product contributes only while its current Airtable Inventory Status is `Out`, with Sold At on the requested day. A sale reverted to `In` is excluded when the report is requested again. Corrections in Airtable are reflected in subsequent requests.

The displayed heading uses Gregorian dates: `สรุปยอดขายของวันที่ 07/10/2026`.

## Proposed choices for review

These extend the agreed requirements and need approval with this spec:

- `/report 07/10/2026` selects a day, using the existing `/docs` day/month/Gregorian-year convention.
- The response is a LINE Flex card using the existing white background, dark text, muted labels, and spacing.
- Ten products are displayed per page. Navigation uses message actions containing an explicit date and page number; each page shows the complete daily total.
- Missing brand/model values display `ไม่พบข้อมูล`. Invalid sale prices cause a warning instead of a misleading total.
- The report is available in the same allowed LINE group as existing commands.

## Approach and alternatives

### Recommended: read Airtable when requested

Extend the existing inventory adapter with a read operation for current sales in a day. Reuse LINE parsing, the allowed-group check, reply delivery, and the Bangkok clock helper. No new database tables, scheduled jobs, workflows, dependencies, or stored reports are needed.

This directly matches the agreed behavior, including manual corrections and reversions. Airtable read latency and limits apply.

### Alternative: reconstruct sales from the D1 command history

This can preserve transaction history, but direct Airtable edits are not necessarily represented. It would require reconciliation to match current valid sales. It does not fit this first version.

### Alternative: cache reports or generate scheduled summaries

This could reduce repeat queries or deliver automatic reports, but introduces stale totals and background behavior the user has not requested. Defer it.

## Command contract

| Command | Meaning |
| --- | --- |
| `/report` | Today's Bangkok date, first page |
| `/report 07/10/2026` | Selected Gregorian date, first page |
| `/report 07/10/2026 2` | Selected date, second page; used by navigation |

Accept one- or two-digit day/month and exactly four digits for the year, with real calendar validation. Trim surrounding whitespace and accept whitespace between arguments. Reject impossible dates, extra arguments, non-positive or non-integer pages, and unsafe page numbers. Do not silently normalize an impossible date.

Invalid syntax returns:

`⚠️ รูปแบบคำสั่งไม่ถูกต้อง ใช้ /report หรือ /report วัน/เดือน/ปี ค.ศ. เช่น /report 7/10/2026`

An out-of-range page returns a warning instructing the user to request the first page for that explicit date. No automatic report delivery or new `/testreport` command is included in this version.

## Date and sale rules

- Resolve the default date once using the existing injected clock and `todayBangkokDate`.
- A day is midnight inclusive through the next midnight exclusive in `Asia/Bangkok`.
- For 07/10/2026, the UTC interval is `[2026-10-06T17:00:00Z, 2026-10-07T17:00:00Z)`.
- Filter on the actual Sold At timestamp, not Upload Date, text display date, import time, or command receipt time.
- Include only records currently marked `Out`.
- Use the current Sold Price, Brand Name, and Model Name values.
- Sort by Sold At ascending, then Product ID using numeric ID order; use record ID as a final stable tie-breaker.
- Each matching Airtable product record represents one current sale. There is no historical transaction count.
- Duplicate Product IDs among matching records are a data error; do not silently deduplicate or double-count.

An `In` product may retain old sale fields under the existing inventory contract; it still contributes nothing. A product set back to `Out` with a retained old Sold At contributes to that old date. The report cannot infer a new sale date from a status edit.

## Retrieval and revenue calculation

Request only fields needed for the report: Product ID, Inventory Status, Brand Name, Model Name, Sold Price, and Sold At. Apply the status and timestamp-range filter server-side. Read every Airtable page by following its returned offset; never treat the first result page as the complete day.

Validate all matching records before rendering. Required values are a valid Product ID, `Out` status, a parseable matching Sold At timestamp, and a positive safe-integer Sold Price in baht, consistent with the current `/soldout` contract. Brand and model are optional strings. Check that the accumulated revenue remains a safe integer.

Calculate revenue from all matching records before selecting the display page. Format prices and the total with comma grouping and `บาท`.

If retrieval fails partway, validation fails, an offset repeats, or aggregation overflows, do not send a partial total or interpret the result as zero sales.

Current-record reads are not a transactional snapshot across Airtable pages. A sale or edit during retrieval can affect the results; the report represents data observed during that request. Do not label it an immutable accounting statement.

## Flex response

Use one bubble per requested page. Reuse the established visual style; no product images or newly generated icon are needed for this version.

Header:

- Muted `/report` label.
- Bold `สรุปยอดขายของวันที่ 07/10/2026`.

Product rows:

- Left: bold Product ID, then Brand Name and Model Name on a wrapped muted line.
- Right: Sold Price, aligned to the right.
- Missing brand/model values use `ไม่พบข้อมูล` rather than omitting the required information.

Footer:

- Number of sales for the whole day, for example `ขายแล้ว 2 รายการ`.
- Prominent `ยอดขายรวม 26,000 บาท`.
- If there is more than one page, show the page number and previous/next controls where applicable. Actions send `/report <explicit date> <page>` so crossing midnight does not change the requested day.

Illustrative content:

```text
/report
สรุปยอดขายของวันที่ 07/10/2026

A-14                         12,000 บาท
CHANEL · Classic Card Holder

A-29                         14,000 บาท
POLÈNE · Numéro Neuf

ขายแล้ว 2 รายการ
ยอดขายรวม 26,000 บาท
```

Prices and products above are examples, not real Airtable results.

For zero matching sales, use the same report card with `ไม่มีรายการขายในวันนี้` for today or `ไม่มีรายการขายในวันที่เลือก` for another date, `ขายแล้ว 0 รายการ`, and `ยอดขายรวม 0 บาท`. No navigation is shown.

Use a short alternative text containing date, count, and total. Do not put the entire product list in alternative text. Bound lengthy brand/model display text with an ellipsis while keeping the complete ID and amount visible. Check the generated payload against the current LINE Flex constraints during implementation.

## Failures

- Invalid date or syntax: the usage warning above; no Airtable query.
- Page outside the available report: warning with the explicit date's first-page command.
- Matching data invalid or duplicated: `⚠️ สรุปยอดขายไม่ได้ เพราะข้อมูลการขายใน Airtable ไม่ครบหรือไม่ถูกต้อง กรุณาตรวจสอบแล้วลอง /report อีกครั้ง`.
- Airtable unavailable or incomplete read: `⚠️ ดึงข้อมูลยอดขายไม่สำเร็จ กรุณาลอง /report อีกครั้ง`.
- Keep technical diagnostics in the existing operational error path; do not expose credentials, raw responses, or internal exceptions in LINE.

Products with missing Sold At cannot be assigned to a day and therefore are not selected by the date query. Detecting all such products across the inventory would be a separate data-quality feature.

## Existing-code integration

Expected touchpoints:

- `src/line/types.ts`: parsed report command and minimal sale-report data shape.
- `src/line/parser.ts`: date/page parsing using the established date-validation approach.
- `src/line/airtable-inventory.ts`: paginated daily-sales read through the existing authenticated adapter.
- `src/line/search.ts`: route the read-only report command, resolve date, calculate totals, and select a page. Keep dedicated report formatting outside the existing command handler if it would obscure the flow.
- `src/line/report-card.ts`: compact report Flex builder.
- `src/routes/line.ts` / read-only dependency contract: expose the existing injected clock as needed.
- `src/line/help-card.ts`: add `/report` with a short Thai description.
- Existing tests and relevant dependency stubs: adjust for the inventory read operation and add focused coverage when implementation validation is authorized.

Reuse `LineClient.replyFlex` and the existing webhook allowed-group policy. There are no sales mutations, inventory updates, Docs workflows, imports, or new external storage writes. Normal webhook deduplication and saved replies remain in place.

A fresh command produces a fresh report; a redelivery of the same webhook event may reuse its saved reply, following existing behavior. Every navigation command performs a fresh query, so concurrent edits can shift the page's contents or totals. A stored pagination snapshot is out of scope.

## Acceptance criteria and planned validation

1. `/report` selects the correct Bangkok day before and after local midnight.
2. An explicit date uses Gregorian input and the required zero-padded heading.
3. Sales exactly at the start boundary are included; the next day's midnight is excluded.
4. Products marked `In` are excluded even if their historical sale fields are populated.
5. Reversions and price corrections change subsequent reports as agreed.
6. Every Airtable result page contributes to the count and total.
7. Missing brand/model values are displayed safely; invalid required sale values prevent a reported total.
8. Pagination makes all matching products reachable and keeps the full-day total on each page.
9. Zero sales produces a clear zero-sales card; retrieval failure never produces a zero-sales success card.
10. Report requests do not invoke imports/publication workflows or update inventory.
11. Duplicate IDs, repeated offsets, and unsafe totals fail clearly.
12. Payloads fit LINE constraints with long model names and a full display page.

During implementation, use the existing test tools for focused parser/date, adapter pagination, report calculation, and command-isolation checks if authorized. Run type checking and review the payload with real LINE previews before deployment. Creating this spec does not run tests or deploy code.

## Out of scope

Historical ledgers, refunds, profit/cost calculations, delivery fees, payment collection status, scheduled delivery, monthly reports, exports, persisted reports, and a new preview command. Total revenue here means the sum of current Sold Price fields, not verified cash received or net profit.

## Approval handoff

Review the proposed date syntax, Flex presentation, and pagination behavior. After spec approval, use Superpowers writing-plans to prepare a concrete implementation plan for review before coding.
