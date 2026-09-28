DONE_WITH_CONCERNS: Task 15 local smoke-test deliverables.

Added `scripts/smoke-test.ts` for `npm run smoke` and `test/acceptance/smoke.test.ts`. The script checks `/health`, unauthenticated `/setup` rejection, authenticated `/setup` with all 11 expected named checks true, authenticated `/usage`, and a signed empty LINE webhook. It stops at the first failed step. The test covers the successful path and false-green setup responses with a missing or failed check. Corrected `docs/runbooks/credential-rotation.md`: `/setup` creates temporary R2 and Google Doc probes and cleans them up.

TDD: focused test initially failed because the script did not exist; after implementation, `npx vitest run test/acceptance/smoke.test.ts` passed (3 tests). `npm run check` exited 0: typecheck passed; 69 test files and 697 tests passed. Vitest printed Miniflare workflow uncaught-exception messages during teardown despite its successful exit.

Pending external rehearsal: no dedicated throwaway Cloudflare account, test Airtable base, LINE channel/group, Google Drive folder/template, Anthropic workspace key, or iCloud Shared Album credentials were supplied. No deployment, live smoke run, runbook gap audit against a fresh account, or external cleanup was attempted. This step remains necessary before claiming fresh-account deployment readiness.
