# Handoff — Import pipeline explanation + image-matching POC

**Date:** 2026-09-06
**Branch:** `feature/snazzy-import-pipeline`
**Next session focus:** continue explaining the import pipeline (Task 2 onward), and optionally continue the CLIP/Vectorize image-matching thread.

---

## What this session was

Explanation work, not implementation. **No production code was written or changed.** Two deliverables landed in `docs/explained/`, plus a throwaway POC that ran entirely in the job scratch directory.

### Artifacts produced

| Path | What |
|---|---|
| `docs/explained/import-pipeline.md` | Task-by-task walkthrough of all 17 tasks in the plan — purpose, code, how each connects to the system |
| `docs/explained/story.md` | The same pipeline as one narrated import with concrete values (album `a3f9`, run `run-abc`, groups `grp-1`/`grp-2`, IDs `A-502`/`A-503`/`A-504`) |

Source plan (unchanged): `docs/superpowers/plans/2026-09-01-snazzy-import-pipeline.md`

---

## Where the explanation got to

Covered in depth, in conversation:

- **Whole-system flow** — trigger → snapshot → download/dedupe → group → allocate ID → Airtable → LINE
- **Task 1 (D1 schema)** — every column of all six tables, why each exists, what breaks without it
- **`sequences`** — asked about repeatedly; needed several passes before it landed
- **Task 12/13 mechanics** — checkpoint vs cutoff, why grouping re-reads from D1 rather than using the in-memory eligible list, the `findBySystemGroupId` crash-adoption path, why `product_id` is cleared on a cross-run reset

**Not yet explained in depth:** Tasks 2–16 individually. Task 1 got the full treatment; the rest have only the overview in `import-pipeline.md`.

### Questions this user asked that are worth re-reading before continuing

They probe design *rationale*, not syntax — and several of my first answers were too terse and had to be redone:

- "so it wont work right, is there any solution here?"
- "why we need to clear the product ID?"
- "so the product ID A-502 is missing forever right?" (they meant A-503 — the burned one)
- "this mean that worker only run once at a time for each album right?"

### What worked in explaining, and what didn't

- The user asked for `/huh` style — **short definition, then how it applies here**. That format works well for them.
- **Long structured explanations were rejected once** ("still confusing explain like Im a junior"). The fix was dropping diagrams and telling a linear story with real numbers. That became `story.md`.
- Concrete values beat abstractions every time. `A-502`, `a3f9`, `grp-1` land; `productId`, `sourceAlbumId` don't.
- Confirm-or-correct questions ("X is Y right?") want a direct yes/no first, then the correction if any. Don't bury the answer.

---

## The image-matching POC

Question that started it: *"if someone screenshots our Instagram post, can we trace it back to the Product ID?"*

### Setup

- Catalog: 100 real photos from `dataset/icloud-shared-album-mock-raw/` + 1 true original (`~/Downloads/DSCF9419.JPG`, a tan Prada bucket bag). Verified the original is **not** duplicated inside the dataset folder.
- Query: an Instagram screenshot of that same bag — tested both raw (with IG UI chrome) and cropped to the photo panel.

### Results

| Method | True match rank |
|---|---|
| pHash, raw screenshot | 79 / 101 |
| pHash, cropped to panel | 22 / 101 |
| dHash, cropped | 22 / 101 |
| Global colour histogram | 39 / 101 |
| 4×4 spatial colour grid | 4 / 101 |
| Multi-crop pHash (5 crops × 101) | 26 / 101 |
| **Caption → text-embed → cosine** | **1 / 101** ✅ |

Caption→embed detail:

```
cropped panel :  true 0.8855  |  best distractor 0.8041  |  gap +0.081  |  5.1σ
raw screenshot:  true 0.8833  |  best distractor 0.8097  |  gap +0.074  |  5.2σ
```

### Why every pixel method failed

Instagram **re-framed** the photo, it didn't just recompress. Controls proved the implementation was sound:

```
original vs itself                     d = 0
original vs JPEG recompressed to q30   d = 0     ← pHash handles this fine
original vs resized to 400px           d = 6     ← and this
original vs 78% centre-crop of itself  d = 24    ← but not this
```

Direct pixel correlation at 16×16: original vs screenshot = **0.042**, while the best unrelated distractor scored **0.158**. The screenshot correlates *less* with its own original than random photos do. Below-noise, not a tuning problem.

The dataset makes it maximally hard — every photo shares the same beige blanket, same hand, same window light, same 2048×2048 crop. At 8×8 they're all "warm blob, upper-left highlight".

### What actually ran (not CLIP)

Two blockers:
1. `@cf/openai/clip-vit-base-patch32` → `5018: This account is not allowed to access` — gated on this account.
2. **Workers AI has no image-embedding models at all.** Every embedding model in the catalog is text-only.

So the tested pipeline was the documented workaround:

```
image → @cf/meta/llama-3.2-11b-vision-instruct  → caption text
      → @cf/baai/bge-base-en-v1.5               → 768-dim vector
      → cosine similarity
```

Confirmed accessible on this account: `llama-3.2-11b-vision-instruct`, `llava-1.5-7b-hf`, `microsoft/resnet-50`, `bge-base-en-v1.5`, `bge-m3`.
Confirmed unavailable: `clip-vit-base-patch32` (gated), `uform-gen2-qwen-500m` (deprecated 2026-05-30).

### Caveats attached to that result

- **N=1.** One query, one product. Needs 20+ screenshots across products, especially two tan bags in one catalog.
- **Matches products, not photos.** Runners-up were sneakers and a scarf, so different items separate well — but the 9–15 photos *of the same bag* will caption near-identically and cluster ~0.95. Fine for "which product", useless for "which photo".
- **Vision model is nondeterministic and sometimes wrong.** It called the Prada logo "a stylized 'G' or 'V' shape" and invented dimensions. Re-runs give different captions and slightly different vectors.
- **Cost.** Two AI calls, ~2s per image. At 500 photos/day that's ~17 min extra per import plus per-neuron billing. A real image-embedding model would be one call, ~100ms.
- **No threshold set.** 0.88 vs 0.80 is a workable gap; where to cut needs more data.

### Standing recommendation

Not built, and shouldn't be until a workflow needs it. Costs a new binding, a vector index, per-photo AI spend, and a new failure path in the import loop.

The alternative raised but never tested: **watermark the 4-in-1 composite at publication time** with the Product ID. Gives certainty rather than similarity for photos you posted yourself. Also fails on heavy re-crop.

Also noted: `photo_assets` has no `group_id` column, so even an exact byte-match can't currently answer "which product is this photo from?" One-column migration if ever needed.

### POC artifacts — EPHEMERAL

Everything lived in `$CLAUDE_JOB_DIR/tmp` (`/Users/gitccino/.claude/jobs/a8af2bfc/tmp`) — `vectors/` (103 JSON files with captions + 768-dim vectors), `clip-poc/` (Worker source), `embed_all.sh`, `poc.py`, `poc2.py`, `poc3.py`, `diag.py`, `phash.py`.

**These are deleted when the job is deleted.** Nothing was copied into the repo. Re-running means redoing ~103 AI calls (a few minutes).

The scratch Worker `clip-poc-scratch` was deployed to the user's Cloudflare account with their explicit approval, then **deleted** (`wrangler delete --force`, confirmed successful). Nothing is left running.

---

## Environment notes

- `python3` 3.14.7 available, but **no PIL, no numpy, no scipy**. The pHash implementation is pure-Python DCT using `sips` for decoding — that's why it exists.
- Image tooling: `sips` only. No ImageMagick, no ffmpeg.
- `npx wrangler` 4.129.0, authenticated. Account ID is in `wrangler whoami` output — not repeated here.
- Heredocs into `$CLAUDE_JOB_DIR/tmp` sometimes hang on shell init (zoxide warning) and get backgrounded. The files still write correctly; verify with `ls` rather than re-running.
- A stale `<task-notification>` may arrive for a killed background job from this session. It's the hung heredoc — harmless, already verified.

---

## Suggested next steps

**If continuing the explanation** (the stated primary focus):
Pick up at **Task 2 (Product ID sequence repository)** and work forward. Task 1 is fully covered. Match the format of `docs/explained/import-pipeline.md` and reuse the story's concrete names.

**If continuing the image-matching thread:**
The open question is no longer "does it work" — it's "is it worth building". Useful next moves, in order of value:
1. Ask the user to name the actual workflow (customer DM lookup? counterfeit hunting? duplicate detection?). The answer changes the design substantially.
2. Validate with more queries before trusting N=1.
3. Compare against the watermarking alternative, which was never prototyped.

---

## Suggested skills

- **`huh`** — the user explicitly asked for this format and it's the reason the explanations landed. Invoke it for term definitions.
- **`ponytail:ponytail`** — active by session hook. Kept the POC from becoming an implementation; keep it driving if the AI-matching thread resumes.
- **`superpowers:brainstorming`** — only if the user decides to actually build image matching. That's a new subsystem and would need proper design before code.
- **`mattpocock-skills:writing-for-agents`** — if editing `docs/explained/*` or CLAUDE.md.

Do **not** invoke implementation skills unprompted. This session's work was explanation and one throwaway experiment; the user has not asked for the import pipeline to be built.
