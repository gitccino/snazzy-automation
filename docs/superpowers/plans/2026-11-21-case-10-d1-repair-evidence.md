# Case 10: guarded D1 success repair

At b2bb17c, a real-D1 regression first failed because a verified success left the job generating with its previous document. Completion now atomically records the verification and reconciles the job to the saved finalization only while the claimed owner, group, generation, cycle, captured context, finalization and prior document ID, URL and successful generation still match. The regression exercises changed values and replay; the verifier integration exercises the next /docs request and confirms no provider writes or second workflow dispatch. Providers are simulated.

Local validation: typecheck and the four focused publication verification-claim, verification-entry, trigger and acceptance suites passed (121 tests). Miniflare logged Workflow engine/instance errors. Full npm test reported the same nine previously recorded LINE failures (two parser, one daily-sales fields, six invalid sold-price cases), then hung after a Workers runtime error and was interrupted; no full-suite result was obtained.

The Airtable Generating projection remains unconfirmed: Airtable has no conditional PATCH, so a read followed by a write cannot safely preserve an intervening manual edit. No remote operations were performed.
