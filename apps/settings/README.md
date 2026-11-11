# Snazzy settings

From the implementation worktree root:

```sh
npm --prefix apps/settings ci
npm --prefix apps/settings run dev
```

Open the localhost URL Vite prints (normally http://127.0.0.1:5173).

Local development uses disposable in-memory sample settings. Restart Vite to reset them. Save, Discard, search, group entry, connection acknowledgement and saved-configuration export work locally. Connection checks deliberately return unavailable because the local server never contacts providers. No staging database or credentials are loaded.

```sh
npm --prefix apps/settings test
npm --prefix apps/settings run typecheck
npm --prefix apps/settings run build
npm --prefix apps/settings run deploy:dry-run
```

The production Worker has no auth bypass and no D1/provider-secret bindings. Its private service binding calls SettingsService on the automation Worker. Before exposure, configure its own Cloudflare Access policy and the real ACCESS_TEAM_DOMAIN (hostname only), ACCESS_AUD and SETTINGS_ORIGIN (exact HTTPS origin). Every page and API request verifies the Access JWT. Alternate origins are rejected. Preview URLs and workers.dev are disabled.

See ../../docs/runbooks/settings-console.md for bootstrap, cutover and rollback. Do not deploy the settings site before the automation cutover is verified.
