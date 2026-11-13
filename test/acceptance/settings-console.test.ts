import { expect, it, vi } from "vitest";
import { createTestEnv, testEnv } from "../helpers/env";
import { handleSettingsBootstrap } from "../../src/routes/settings-bootstrap";
import {
  getSettingsView,
  SettingsService,
} from "../../src/settings/entrypoint";
import { saveSettingsSection } from "../../src/settings/service";
import {
  loadSettingsSnapshot,
  resolveImportContext,
  resolvePublicationContext,
} from "../../src/settings/runtime";
import {
  saveImportContextIfAbsent,
  savePublicationAttemptContext,
} from "../../src/db/execution-context-repository";
import { handleLineRoute } from "../../src/routes/line";
import { validateSettingsConnections } from "../../src/settings/validation";
import { reopenFailedJobForRestart } from "../../src/db/publication-repository";

it("seeds effective values once, saves new revisions, pins accepted work, and fails closed without settings", async () => {
  const env = {
    ...testEnv(),
    ...createTestEnv(),
    WORKFLOW_RETRY_LIMIT: "0",
    CONFIGURATION_MODE: "legacy" as "legacy" | "d1",
    PUBLIC_BASE_URL: "https://assets.example",
    ENVIRONMENT: "staging",
  };
  await env.DB.prepare("DELETE FROM app_settings").run();
  const req = new Request("https://worker/setup/settings-bootstrap", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` },
  });
  expect((await handleSettingsBootstrap(req, env)).status).toBe(200);
  env.CONFIGURATION_MODE = "d1";
  const first = await loadSettingsSnapshot(env);
  expect(first.config.importRetryLimit).toBe(0);
  await env.DB.prepare(
    "INSERT INTO import_runs (id,source_album_id,trigger,status,started_at) VALUES ('context-acceptance','context-album','admin','running','now')",
  ).run();
  const original = { settings: first, replyGroupId: "C1" };
  await saveImportContextIfAbsent(env.DB, "context-acceptance", original);
  const result = await saveSettingsSection(
    env.DB,
    {
      expectedRevision: 1,
      section: "documents",
      changes: { AI_CAPTIONS_ENABLED: false, PUBLICATION_RETRY_LIMIT: 5 },
    },
    new Date().toISOString(),
    (a, b, keys) => validateSettingsConnections(env, a, b, keys),
  );
  expect(result).toMatchObject({ ok: true, value: { revision: 2 } });
  expect((await loadSettingsSnapshot(env)).config.publicationRetryLimit).toBe(
    5,
  );
  expect(
    await resolveImportContext(env, {
      importRunId: "context-acceptance",
      sourceAlbumId: "context-album",
      trigger: "admin",
    }),
  ).toEqual(original);
  expect(
    await saveSettingsSection(
      env.DB,
      {
        expectedRevision: 1,
        section: "advanced",
        changes: { MONTHLY_BUDGET_THB: 3000 },
      },
      new Date().toISOString(),
      async () => ({ ok: true, value: undefined }),
    ),
  ).toMatchObject({ ok: false, code: "revision_conflict" });
  await env.DB.prepare("UPDATE app_settings SET settings_json='{}'").run();
  await expect(loadSettingsSnapshot(env)).rejects.toThrow(
    "settings_unavailable",
  );
});
it("admits two allowed groups with separate captured destinations and ignores an unauthorized group", async () => {
  const legacy = JSON.parse(createTestEnv().APP_CONFIG_JSON);
  const env = {
    ...testEnv(),
    ...createTestEnv(),
    LINE_CHANNEL_SECRET: "secret",
    CONFIGURATION_MODE: "legacy" as "legacy" | "d1",
    PUBLIC_BASE_URL: "https://assets.example",
    ENVIRONMENT: "staging",
  };
  await env.DB.prepare("DELETE FROM app_settings").run();
  await handleSettingsBootstrap(
    new Request("https://worker/setup/settings-bootstrap", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` },
    }),
    env,
  );
  await saveSettingsSection(
    env.DB,
    {
      expectedRevision: 1,
      section: "line",
      changes: { LINE_ALLOWED_GROUP_IDS: ["C1", "C2"] },
    },
    new Date().toISOString(),
    async () => ({ ok: true, value: undefined }),
  );
  env.CONFIGURATION_MODE = "d1";
  const createBatch = vi.fn(
    async (_batch: { params: { context: { replyGroupId: string } } }[]) => [],
  );
  env.LINE_COMMAND_WORKFLOW = { createBatch } as never;
  const body = JSON.stringify({
    events: ["C1", "C2", "C3"].map((groupId, i) => ({
      type: "message",
      webhookEventId: `group-${i}`,
      replyToken: `reply-${i}`,
      source: { type: "group", groupId, userId: "U1" },
      message: { type: "text", id: `msg-${i}`, text: "/help" },
    })),
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
      ),
    ),
  );
  expect(
    (
      await handleLineRoute(
        new Request("https://worker/line/webhook", {
          method: "POST",
          body,
          headers: { "x-line-signature": signature },
        }),
        env,
        {} as ExecutionContext,
      )
    ).status,
  ).toBe(200);
  expect(createBatch.mock.calls[0]?.[0]).toHaveLength(2);
  expect(
    createBatch.mock.calls[0]?.[0]?.map(
      (entry: any) => entry.params.context.replyGroupId,
    ),
  ).toEqual(["C1", "C2"]);
});
it("a terminal publication adopts new settings only without saved document work; restarted payload cannot override it", async () => {
  const env = { ...testEnv(), ...createTestEnv() };
  const snapshot = await loadSettingsSnapshot(env);
  const old = { settings: snapshot, replyGroupId: "C1" };
  const next = {
    settings: {
      ...snapshot,
      revision: 9,
      config: { ...snapshot.config, googleDriveFolderId: "newFolder" },
    },
    replyGroupId: "C2",
  };
  for (const id of ["snapshot-restart", "snapshot-resume"]) {
    await env.DB.prepare(
      "INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at) VALUES (?,'locked',?,'now','now')",
    )
      .bind(id, `publication-${id}`)
      .run();
    expect(await savePublicationAttemptContext(env.DB, id, 1, old)).toBe(true);
    expect(await savePublicationAttemptContext(env.DB, id, 2, old)).toBe(false);
    await env.DB.prepare(
      "UPDATE publication_jobs SET state='failed',temp_doc_id=? WHERE publication_run_id=?",
    )
      .bind(id.endsWith("resume") ? "existing-doc" : null, id)
      .run();
    expect(
      await reopenFailedJobForRestart(
        env.DB,
        { now: () => new Date() },
        id,
        `publication-${id}`,
        1,
        next,
      ),
    ).toBe(true);
    expect(
      await resolvePublicationContext(env, {
        publicationRunId: id,
        trigger: "line",
        context: old,
      }),
    ).toEqual(id.endsWith("resume") ? old : next);
  }
});
