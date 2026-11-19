# /docs retest after Google refresh-token update

User reported updating GOOGLE_REFRESH_TOKEN and authorized another staging /docs attempt. Confirmed the current Worker deployment was `e074afa6-593b-4512-bc7e-ca7c314ffabb`, deployed at 11:02:03 UTC. No secret values were read or printed.

Restarted the existing publication Workflow for `rec9PHkzRunQ7820v`, after a guarded failed→locked transition and notification-cycle increment 3→4. Preserved generation 1, captured model/settings, document metadata, cached work and prior queued results.

The attempt ran 18:03:41–18:03:59 Asia/Bangkok and ended Errored:

- Caption request still returned HTTP 400 invalid_request_error from Claude Opus 5.5; request ID `req_011ChCB9c2tsh38zU7hXJA5U`. The known forced-tool request incompatibility remains unchanged.
- Google failure cleanup **succeeded**, including the token exchange and temporary-document discovery path. No google_token_exchange_failed or unconfirmed cleanup diagnostic occurred.
- Airtable and D1 both transitioned to Failed automatically. No manual reconciliation was needed this time.
- No temporary/final document ID was saved, and document-creation steps were not reached.
- Final failed result was persisted as outbox sequence 3, notification cycle 4, pending later same-group delivery. Earlier queued results were retained.

Google authentication is verified for cleanup/Drive discovery; successful document creation/filling is not yet verified because Claude failed first. No code, model or other settings were changed, and no additional deployment was performed. The temporary live log tail was stopped.
