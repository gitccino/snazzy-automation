import { beforeEach, expect, it, vi } from "vitest";
import { handleLineRoute } from "../../src/routes/line";
import { createTestEnv, testEnv } from "../helpers/env";

const groupId = `C${"a".repeat(32)}`;
const secret = "discovery-test-secret";
const ctx = { waitUntil() {} } as unknown as ExecutionContext;

beforeEach(async () => {
  await testEnv().DB.prepare("DELETE FROM app_settings").run();
  await testEnv().DB.prepare("DELETE FROM audit_events").run();
});

async function request(events: unknown[], validSignature = true) {
  const body = JSON.stringify({ events });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
  return new Request("https://worker/line/webhook", { method: "POST", headers: { "x-line-signature": validSignature ? signature : "invalid" }, body });
}

const event = {
  type: "message", webhookEventId: "setup-event", replyToken: "private-reply-token",
  source: { type: "group", groupId, userId: "private-user-id" },
  message: { type: "text", id: "setup-message", text: "private message content" },
};

function bindings() {
  const createBatch = vi.fn();
  return { ...testEnv(), ...createTestEnv(), CONFIGURATION_MODE: "d1" as const, LINE_CHANNEL_SECRET: secret,
    LINE_COMMAND_WORKFLOW: { createBatch } as unknown as ReturnType<typeof testEnv>["LINE_COMMAND_WORKFLOW"] };
}

it("captures only the signed group ID before first settings initialization and deduplicates delivery", async () => {
  const env = bindings();
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await handleLineRoute(await request([event]), env, ctx)).status).toBe(200);
  }
  const rows = await env.DB.prepare("SELECT after_value FROM audit_events WHERE action = 'line_setup_group_observed'").all();
  expect(rows.results).toEqual([{ after_value: groupId }]);
  const audit = await env.DB.prepare("SELECT * FROM audit_events").all();
  expect(JSON.stringify(audit)).not.toContain("private-");
  expect(JSON.stringify(audit)).not.toContain("private message");
  expect(env.LINE_COMMAND_WORKFLOW.createBatch).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM app_settings").first("count")).toBe(0);
});

it("rejects an unsigned discovery request without writing an audit event", async () => {
  const env = bindings();
  expect((await handleLineRoute(await request([event], false), env, ctx)).status).toBe(401);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(0);
});

it("acknowledges LINE verification with no settings or group events", async () => {
  expect((await handleLineRoute(await request([]), bindings(), ctx)).status).toBe(200);
  expect(await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(0);
});

it("does not use discovery to bypass an existing invalid settings document", async () => {
  const env = bindings();
  await env.DB.prepare("INSERT INTO app_settings VALUES (1, 1, '{}', 1, '2026-11-23T00:00:00.000Z')").run();
  expect((await handleLineRoute(await request([event]), env, ctx)).status).toBe(503);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(0);
});
