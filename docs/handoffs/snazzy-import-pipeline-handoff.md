# Handoff — Snazzy Automation: Start the Import Pipeline Plan

**Prepared:** after completing Plan 1 (Foundation & iCloud Feasibility).
**Next session focus:** implement `docs/superpowers/plans/2026-09-01-snazzy-import-pipeline.md` (Plan 2 of 5).

## Repo & branch

- Repo: `/Users/gitccino/Desktop/projects/snazzy-official-gpt`
- Branch: `feature/snazzy-foundation` (built on top of `main`, commit `a01c72e`)
- Master plan index: `docs/superpowers/plans/2026-09-01-snazzy-automation-implementation-index.md`
- Spec: `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`
- All five plans live in `docs/superpowers/plans/`.

## Where we are

**Plan 1 is complete.** Phase 0 feasibility gate is **PASS** — the authoritative evidence is:

- `docs/feasibility/icloud-phase-0-report.md` (all 10 gates PASS; decision: proceed with the iCloud `ImageSource`)
- `docs/feasibility/icloud-phase-0-result.json` (raw probe output; `sourceAlbumId: "[REDACTED]"`)

The full Foundation plan was executed task-by-task and is committed. All commits are on the branch (see `git log main..HEAD`); the last one is `7a4c502 "fix: send photoGuids (not checksums) to iCloud webasseturls"`.

## Critical learnings a fresh agent MUST know (not in the plans)

These were discovered during Phase 0 and are easy to trip on:

1. **iCloud `webasseturls` protocol fix** (`src/icloud/client.ts`, commit `7a4c502`): the request body must send **photo GUIDs** (`photoGuids`), NOT derivative checksums. The response `items` is keyed by checksum, with values `{ url_location, url_path, url_expiry }`. The plan's original snippet sent checksums and returned empty `items`.
2. **Ordering:** iCloud webstream returns photos **newest-first**. "Marker positions" must be expressed in *snapshot* order, not the user's app upload order. Also, staff double-shot the marker card at each boundary (sharp + blurry twins); two adjacent markers create an **empty product group** risk — flag during Import grouping.
3. **Tests run in workerd** (`@cloudflare/vitest-plugin`): `readFileSync` of repo fixture files fails (virtual `/bundle` fs). The plan's marker tests were adapted to generate JPEG fixtures in-memory via `test/helpers/marker-fixtures.ts`. Keep this in mind for any Import tests that would read binaries from disk.
4. **`noUncheckedIndexedAccess: true`** is set in `tsconfig.json`; several plan test snippets needed non-null assertions (`!`). Always run `npm run check` (typecheck + tests) — it is the gate that catches these.
5. **npm install-scripts:** on a fresh checkout, `esbuild` and `workerd` postinstall scripts are blocked; run `npm install-scripts approve esbuild workerd` before the test runner will work (only a fresh-env concern; already done here).
6. **Local Phase 0 runs** use a `.env` + Node's `--env-file` (the `phase-zero` script is `tsx --env-file=.env scripts/run-phase-zero.ts`). `.env` and `.debug/` are gitignored.

## Sensitive data (redacted on purpose)

- The iCloud Shared Album token is **not** in the repo. It lives only in the user's local `.env` (gitignored) and the public album URL (also sensitive). Do not paste, log, or commit either.
- Do not commit `/Users/gitccino/Downloads/*` sample images or any `.debug/` output.

## Current uncommitted state (leave or commit as the user directs)

- `M .gitignore` — added `.env` and `.debug/`
- `M package.json` — `phase-zero` now uses `--env-file=.env`
- `?? scripts/observe.ts` — personal debug helper (`saveJson` / `saveJsonSnapshot` / `loadJson`); **do not import from `src/`** (production must never write signed URLs / use `.debug`)
- `?? docs/feasibility/` — `icloud-phase-0-report.md` and `icloud-phase-0-result.json`
- Untracked user-owned dirs (leave alone unless asked): `dataset/`, `docs/explained/`, `others/`, `*.DS_Store`

## Suggested skills for the next agent

Invoke in this priority (Pi loads `SKILL.md` via `read`; there is no `Skill` tool and **no subagent tool** — do the work in-session):

- `superpowers:executing-plans` — required to drive the Import Pipeline plan task-by-task.
- `superpowers:using-git-worktrees` — confirm/continue isolation on `feature/snazzy-foundation` (or branch off it); get user consent before creating anything new.
- `superpowers:test-driven-development` — every import parser/state transition/money mutation/trust boundary starts from a failing test (the plans require this).
- `superpowers:systematic-debugging` — for any Cloudflare/D1/R2/Workflow runtime surprises like the Phase 0 protocol bug.
- `superpowers:verification-before-completion` — before claiming a task passes, run `npm run check` and confirm exit 0 (don't mask failures with `grep`).
- `superpowers:finishing-a-development-branch` — at the end of the Import plan, choose integration path.

## Starting point for the Import Pipeline plan

Read `docs/superpowers/plans/2026-09-01-snazzy-import-pipeline.md` in full first. It builds on:

- `src/icloud/client.ts` + `src/icloud/types.ts` (working `ImageSource`: `getSnapshot()` / `download()`)
- `src/import/marker.ts` (`isMarkerImage`)
- `src/shared/{ids,time,errors,logger,http}.ts`, `src/config.ts`, `src/env.ts`
- No D1/R2/Airtable/Workflow code exists yet — the Import plan creates those.