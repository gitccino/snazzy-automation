# Daily Sales Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegated execution. Implement task by task and use checkbox tracking.

**Goal:** Add an on-demand `/report` LINE Flex reply listing current valid sales and complete revenue for a Bangkok calendar day.

**Architecture:** Query the existing Airtable Products table through the inventory adapter, follow every offset, and validate records before calculating totals. Route the new command through the existing read-only LINE handler and render ten products per page with full-day totals. Reuse the injected clock and current Flex delivery; add no workflow, database table, cache, dependency, or scheduled task.

**Tech Stack:** TypeScript, Cloudflare Workers, Airtable REST API, LINE Flex messages, existing Zod and Vitest tooling.

**Spec:** `docs/superpowers/specs/2026-10-07-daily-sales-report-design.md`

## Global Constraints

- Current Airtable records marked `Out` only; date determined by Sold At.
- Bangkok day is midnight inclusive through the next midnight exclusive.
- Display Gregorian dates in zero-padded `DD/MM/YYYY` form.
- Ten products per page; every page shows full-day count and revenue.
- Missing brand/model displays `ไม่พบข้อมูล`; invalid required sale data prevents a total.
- Positive safe-integer sold prices in baht and safe-integer total.
- No imports, Docs jobs, inventory updates, historical ledger, or `/testreport` in scope.
- Preserve unrelated local `.gitignore`, `package.json`, and workspace files.
- No product images or new icon; use the established white Flex styling.
- Do not add or run automated tests without user authorization. Test steps below are the proposed validation scope for approval, not actions performed while writing this plan.

## Review Focus

1. Dates at month/year rollover and leap days: include the correct Bangkok interval; owned by Tasks 1–2.
2. Airtable returns repeated offsets or fails after the first page: show a warning, never partial revenue; owned by Task 2.
3. Same timestamp with IDs A-2 and A-10: deterministic numeric product ordering; owned by Task 3.
4. Midnight arrives between page clicks: explicit navigation dates keep the selected day; owned by Tasks 3–4.
5. Long model names or a changed result count between clicks: bounded display and a clear invalid-page reply; owned by Tasks 3–4.

## File map

| File | Responsibility |
| --- | --- |
| `src/line/types.ts` | Report command, parse-error code, and daily-sale record type |
| `src/line/parser.ts` | Parse command/date/page and validate calendar dates |
| `src/line/messages.ts` | Invalid report command warning |
| `src/line/airtable-inventory.ts` | Authenticated, paginated current-sales read and validation |
| `src/line/report-card.ts` (new) | Validate/sort/aggregate report input and render page/navigation |
| `src/line/search.ts` | Read-only report orchestration and friendly failure mapping |
| `src/line/help-card.ts` | `/report` help entry |
| Existing LINE tests and dependency stubs | Focused checks and compatibility with the new read method/clock |

Do not introduce a separate report service or date library. The existing webhook already provides `clock`; expose that same value in `ReadOnlyDeps`. Its inventory object is already the full inventory client, so the route should need no new runtime dependency construction.

### Task 1: Command and date contract

**Files:** Modify `src/line/types.ts`, `src/line/parser.ts`, `src/line/messages.ts`; proposed checks in `test/line/parser.test.ts`.

**Interfaces:**

```ts
// Add to ParsedCommand; normalized date is YYYY-MM-DD.
{ type: "report"; reportDate?: string; page: number }
// Add to ParseErrorCode.
"invalid_report_command"

export interface DailySaleProduct {
  recordId: string;
  productId: string;
  brandName: string | null;
  modelName: string | null;
  soldPrice: number;
  soldAt: string;
}
```

- [ ] Add the following approved checks to the existing parser table before implementing. Do not add a new test framework.

```ts
expect(parseLineCommand("/report")).toEqual({ ok: true, command: { type: "report", page: 1 } });
expect(parseLineCommand(" /report 7/10/2026 2 ")).toEqual({ ok: true, command: { type: "report", reportDate: "2026-10-07", page: 2 } });
expect(parseLineCommand("/report 29/2/2028")).toEqual({ ok: true, command: { type: "report", reportDate: "2028-02-29", page: 1 } });
for (const input of ["/report 29/2/2026", "/report 31/4/2026", "/report 7/10/0000", "/report 7/10/2026 0", "/report 7/10/2026 -1", "/report 7/10/2026 1.5", "/report 7/10/2026 9007199254740992", "/report 7/10/2026 2 extra", "/report 2"]) {
  expect(parseLineCommand(input)).toEqual({ ok: false, code: "invalid_report_command" });
}
```

- [ ] If authorized, run `npx vitest run test/line/parser.test.ts`; confirm these checks fail for the unimplemented report command.
- [ ] Recognize only `/report` or `/report` followed by whitespace. Require either no arguments or date plus optional positive integer page. Normalize date, then round-trip its UTC ISO date to reject impossible dates, following the existing `/docs` approach. Reject year zero. Keep `/docs` behavior unchanged; no unrelated parser refactor.

```ts
const page = rawPage === undefined ? 1 : Number(rawPage);
if (!Number.isSafeInteger(page) || page < 1) return { ok: false, code: "invalid_report_command" };
const parsedDate = new Date(`${reportDate}T00:00:00Z`);
if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== reportDate) {
  return { ok: false, code: "invalid_report_command" };
}
```

- [ ] Add the exact invalid-command message from the spec under `invalid_report_command` in `parseErrorText`.
- [ ] Typecheck; if authorized, repeat the focused parser command and confirm success.
- [ ] Commit only Task 1 files: `feat: parse daily sales report commands`.

### Task 2: Complete Airtable daily-sales read

**Files:** Modify `src/line/airtable-inventory.ts`; update inventory mock objects required by type checking; proposed checks in `test/line/airtable-inventory.test.ts`.

**Interfaces:**

```ts
// Extend InventoryClient.
listSalesForDay(reportDate: string): Promise<DailySaleProduct[]>;
```

Consumes Task 1's `DailySaleProduct`. Existing sale/search/revert methods retain their behavior.

- [ ] Add one focused adapter check using the existing `Response`/fetch mock style. Return two pages with distinct IDs and an offset on page one; assert the method returns both records and follows that offset. Verify the requested fields, status filter, and UTC boundaries.

```ts
const calls: URL[] = [];
const fetcher = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push(url);
  return Response.json(url.searchParams.has("offset")
    ? { records: [{ id: "rec2", fields: { "Product ID": "A-2", "Inventory Status": "Out", "Sold Price": 14000, "Sold At": "2026-10-07T16:59:59.999Z" } }] }
    : { records: [{ id: "rec1", fields: { "Product ID": "A-1", "Inventory Status": "Out", "Sold Price": 12000, "Sold At": "2026-10-06T17:00:00Z" } }], offset: "page2" });
});
const client = createInventoryClient({ ...config, fetch: fetcher });
expect(await client.listSalesForDay("2026-10-07")).toHaveLength(2);
expect(calls[1]!.searchParams.get("offset")).toBe("page2");
expect(calls[0]!.searchParams.get("filterByFormula")).toContain("2026-10-06T17:00:00.000Z");
expect(calls[0]!.searchParams.get("filterByFormula")).toContain("2026-10-07T17:00:00.000Z");
```

- [ ] If authorized, run `npx vitest run test/line/airtable-inventory.test.ts` and observe the missing-method failure.
- [ ] Implement the method inside the existing adapter so it reuses authenticated headers, `requireOk`, and `parseList`. Validate normalized input before query construction. Calculate the interval without local-machine timezone dependence:

```ts
const start = new Date(`${reportDate}T00:00:00+07:00`);
const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
const formula = `AND({Inventory Status}="Out",{Sold At}>=DATETIME_PARSE("${start.toISOString()}"),{Sold At}<DATETIME_PARSE("${end.toISOString()}"))`;
```

- [ ] Request the six fields in the spec, with page size 100. Use a sequential loop following each returned offset; track seen offsets in a Set and fail on repetition. Collect all pages before returning. Reject any matching record with invalid ID/status/date/price and recheck that each date is within the half-open interval. Reject duplicated record IDs or Product IDs rather than double-counting. Normalize optional brand/model strings to trimmed string or null.
- [ ] Use `OperationalError("airtable_inventory_report_invalid_record", ..., false)` for record validation and duplicates, and `OperationalError("airtable_inventory_report_invalid_response", ..., false)` for repeated offsets. Use `requireOk(response, "report")` for HTTP failures. Existing parse-list malformed-response errors remain operational errors and map to retrieval failure later.
- [ ] Add compact parameterized checks to the same adapter test file for repeated offsets, second-page HTTP failure, duplicate IDs, missing price, an unexpected `In` record, invalid date, and a record at the exclusive end boundary. Include month/year rollover in the interval assertion.
- [ ] Search `rg -n 'findByProductId:|InventoryClient|createInventoryClient' test src` and add `listSalesForDay` stubs only to full inventory mocks that require it. Keep unrelated test expectations untouched.
- [ ] Typecheck; if authorized, repeat the focused adapter command.
- [ ] Commit only Task 2 files: `feat: read complete daily sales from Airtable`.

### Task 3: Revenue, page rendering, and navigation

**Files:** Create `src/line/report-card.ts`; proposed focused check in `test/line/report-card.test.ts`.

**Interfaces:**

```ts
export function dailySalesReportCard(
  products: DailySaleProduct[], reportDate: string, page: number, isToday: boolean,
): SearchCardReply | string;
```

Consumes Task 1's type and existing `SearchCardReply`; returns a Flex reply or the out-of-range page warning. Unsafe totals throw `OperationalError("sales_report_invalid_total", ..., false)`.

- [ ] Add a focused check for eleven products, full-day total on page two, numeric tie ordering, and date-preserving navigation. Use a small local array; no new fixtures or dependencies.

```ts
const products = Array.from({ length: 11 }, (_, i) => ({
  recordId: `rec${i + 1}`, productId: `A-${i + 1}`, brandName: "CHANEL", modelName: "Classic",
  soldPrice: 100, soldAt: "2026-10-07T07:00:00Z",
}));
const first = dailySalesReportCard(products, "2026-10-07", 1, true);
const second = dailySalesReportCard(products, "2026-10-07", 2, true);
expect(JSON.stringify(first)).toContain("/report 07/10/2026 2");
expect(JSON.stringify(second)).toContain("A-11");
expect(JSON.stringify(second)).toContain("1,100 บาท");
expect(JSON.stringify(second)).toContain("11 รายการ");
```

- [ ] If authorized, run `npx vitest run test/line/report-card.test.ts` and observe the missing-module failure.
- [ ] Copy the established white background, dark `#2C2C2C`, muted `#949494`, and 24px padding into the minimal report card builder. Do not generalize every card in the repository.
- [ ] Sort a copy of the input by timestamp, then numeric Product ID, then record ID. Use string digit length and lexicographic comparison for numeric ID ordering so large ID suffixes do not lose precision. Sum all records before slicing, checking safe integers on prices and each accumulated total.

```ts
const PAGE_SIZE = 10;
const pageCount = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
if (page > pageCount) return `⚠️ ไม่พบหน้าที่เลือก กรุณาส่ง /report ${displayDate} เพื่อดูหน้าแรก`;
const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
```

- [ ] Render the specified header, two-column product rows, whole-day count, and whole-day revenue. Display missing brand/model placeholders. Bound brand/model display to 80 Unicode code points each with ellipsis and `wrap: true`; keep complete IDs and prices. Mark this display-only ceiling with a `ponytail:` comment. Keep a short date/count/total alt text.
- [ ] Add previous/next message actions, each with the explicit Gregorian date and target page. No postbacks, database snapshots, or new commands for navigation.
- [ ] Render zero-sales wording based on `isToday`, with zero count and revenue and no navigation.
- [ ] Add compact checks for zero sales, missing names, long names, stable ordering of A-2/A-10, full-day total across pages, invalid page, and unsafe total. Check input arrays remain unchanged.
- [ ] Verify the full ten-row payload against current official LINE Flex constraints before finalizing. If payload size requires reducing name display length, keep all required product IDs and amounts and record the deliberate ceiling. No silent removal of sales from total or navigation.
- [ ] Typecheck; if authorized, run the focused card check.
- [ ] Commit only Task 3 files: `feat: render paginated daily sales report cards`.

### Task 4: Read-only command integration and delivery

**Files:** Modify `src/line/search.ts`, `src/line/help-card.ts`, and affected dependency stubs; review `src/routes/line.ts` and `src/line/webhook.ts` for compatibility. Proposed checks in `test/line/search.test.ts`, `test/line/webhook.test.ts`, and `test/routes/line.test.ts` only where needed.

**Interfaces:**

```ts
// Extend the existing ReadOnlyDeps inventory pick and expose its existing clock.
inventory: Pick<InventoryClient, "findByProductId" | "listSalesForDay">;
clock: Clock;
// Extend handleReadOnlyCommand's accepted union with report.
```

Consumes `listSalesForDay`, `dailySalesReportCard`, and existing `todayBangkokDate`.

- [ ] Add one focused command-isolation check: freeze the clock at `2026-10-06T17:00:00Z`, request `/report`, and assert a call for `2026-10-07`; assert no upload/Docs trigger or inventory update. Check just-before-midnight with `2026-10-06T16:59:59.999Z`.
- [ ] If authorized, run `npx vitest run test/line/search.test.ts` and confirm the unimplemented routing check fails.
- [ ] Route report before the current final `/docs` branch so it cannot fall through into Docs. Resolve today's date once, use the supplied date if present, request all current sales, and invoke the report card builder.

```ts
const today = todayBangkokDate(deps.clock);
const date = command.reportDate ?? today;
const products = await deps.inventory.listSalesForDay(date);
return dailySalesReportCard(products, date, command.page, date === today);
```

- [ ] Catch only report operational errors at this boundary. Map invalid-record/duplicate/unsafe-total errors to the data warning; map Airtable HTTP, malformed response, repeated-offset, and fetch failures to the retrieval warning. Normalize fetch network exceptions inside the adapter into an operational error so programming errors are not silently swallowed. Preserve diagnostics through the existing error conventions without placing raw error text in LINE.
- [ ] Add `/report` with `สรุปยอดขายรายวัน` to the existing help list. Keep all preview menus unchanged.
- [ ] Update read-only stubs with the injected clock and daily-sales mock. Verify actual `WebhookDeps` and route wiring already satisfy the interface before changing runtime construction.
- [ ] Add compact checks for explicit dates, zero-sales replies, data failures, partial-read failures, and changed page counts; verify existing saved-reply handling and allowed-group behavior remain intact. Do not add a new report-specific workflow or database audit model.
- [ ] Typecheck; if authorized, run the focused LINE parser, inventory, report-card, search, webhook, and route files. Do not run unrelated acceptance suites by default.
- [ ] Run `git diff --check` and review the entire branch against all twelve acceptance criteria. Confirm no secrets, unintended configuration changes, or data mutations entered the diff.
- [ ] Commit only Task 4 files: `feat: integrate daily sales reports in LINE`.

## Final validation and handoff

- [ ] If native execution was selected, request one independent whole-branch review after implementation, as required by the selected Superpowers execution workflow.
- [ ] Report actual checks run and any unresolved limitations. Never describe planned tests as passing checks.
- [ ] With deployment authorization, deploy to staging using `npm run deploy:staging` and verify the active version.
- [ ] In LINE, manually review `/report`, an explicit date, a day with zero sales, and second-page navigation where data permits. Do not change inventory merely to produce a test case.
- [ ] Create/merge a PR only when the user requests it; preserve unrelated local files.

## Known practical limits

Reports use current records rather than a historical ledger. Airtable is not a consistent multi-page snapshot, and each navigation command queries again; edits may change totals/pages. Missing Sold At cannot be assigned to any date. Every request reads all matching records to avoid partial totals, so high-volume days increase latency; introduce a stored snapshot or background report only if measured volume requires it.

## Execution outcome — 2026-10-07

Tasks 1–4 are implemented and committed on `feat/daily-sales-report` in `/tmp/snazzy-daily-sales-report`. No deployment, push, PR, or merge has been performed for this feature.

Validation:

- Type checking and diff checking passed.
- Five focused inventory/card/search/webhook/route files: 99 tests passed after the review fix.
- The report parser check passed separately.
- Wider LINE/time regression run: 189 passed and 7 failed before the final diagnostics fix. All seven failures also reproduce in the original checkout: one existing `/soldout` THB parsing bug and six old warning-copy expectations. They are not report regressions.
- Independent review found one Important issue: friendly report errors discarded diagnostics. Fixed using the existing sanitized logger, with a regression check observed failing and then passing.
- A ten-row long-Unicode stress payload measured 11,239 bytes locally; the reviewer independently measured 12,349 bytes with both navigation buttons and large prices. Both fit the [official 30 KB LINE bubble limit](https://developers.line.biz/en/reference/messaging-api/nojs/#bubble).
- Real Airtable query behavior and live LINE visual rendering have not been exercised.

Rulings made:

- Used an isolated `/tmp` worktree and the installed dependencies to protect local changes. Cost if unsuitable: relocate the worktree.
- Ran the approved focused checks and related LINE regressions, without unrelated acceptance suites. Cost: regressions outside those checks are not ruled out.
- Kept the pre-existing soldout parser/copy failures outside this feature. Cost: those seven baseline failures remain.
- Grouped dependent interface mock updates with Task 4 integration rather than Task 2; intermediate commits require subsequent integration for type checking. Final branch type checking passes.
- Retained current-record semantics across page clicks and excluded records missing Sold At, as approved. Cost: edited totals can change and undated sales cannot be assigned to a report.
- Retained the existing group-member profile lookup dependency. Cost: a profile lookup failure can prevent a report reply, as for other commands.
- Deferred live Airtable and LINE validation until deployment. Cost: actual API filtering and device layout remain unverified.

Deferred minor finding:

- Expand the automated payload-size regression check from one product to ten long-Unicode rows with both navigation buttons. Manual stress checks cover the current payload, but do not protect every future rendering change.
