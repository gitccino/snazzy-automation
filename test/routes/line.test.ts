import { expect, it, vi } from "vitest";
import { testEnv } from "../helpers/env";
import {
  handleLineRoute,
  parseUploadTriggerResponse,
  toLineDocsTriggerResult,
} from "../../src/routes/line";

const immediateContext = { waitUntil() {} } as unknown as ExecutionContext;

async function sign(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return btoa(String.fromCharCode(...bytes));
}

it("returns 401 before parsing an invalidly signed body", async () => {
  const process = vi.fn();

  const response = await handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": "bad" },
      body: "not-json",
    }),
    { ...testEnv(), LINE_CHANNEL_SECRET: "secret" },
    immediateContext,
    { process },
  );

  expect(response.status).toBe(401);
  expect(process).not.toHaveBeenCalled();
});

it("passes only schema-validated supported events", async () => {
  const body = new TextEncoder().encode(JSON.stringify({
    events: [
      {
        type: "message",
        webhookEventId: "evt-1",
        replyToken: "reply-1",
        source: { type: "group", groupId: "C1", userId: "U1" },
        message: { type: "text", id: "msg-1", text: "/help" },
      },
      { type: "follow", webhookEventId: "ignored" },
    ],
  }));
  const process = vi.fn().mockResolvedValue(undefined);

  const response = await handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": await sign(body, "secret") },
      body,
    }),
    { ...testEnv(), LINE_CHANNEL_SECRET: "secret" },
    immediateContext,
    { process },
  );

  expect(response.status).toBe(200);
  expect(process).toHaveBeenCalledWith([
    expect.objectContaining({ webhookEventId: "evt-1" }),
  ]);
});

it("acknowledges an upload before command processing finishes", async () => {
  const body = new TextEncoder().encode(JSON.stringify({
    events: [{
      type: "message",
      webhookEventId: "evt-slow-upload",
      replyToken: "reply-slow-upload",
      source: { type: "group", groupId: "C1", userId: "U1" },
      message: { type: "text", id: "msg-slow-upload", text: "/upload" },
    }],
  }));
  let finishProcessing!: () => void;
  const processing = new Promise<void>((resolve) => { finishProcessing = resolve; });
  let processed = false;
  const backgroundTasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(task: Promise<unknown>) { backgroundTasks.push(task); },
  } as ExecutionContext;
  const responsePromise = handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": await sign(body, "secret") },
      body,
    }),
    { ...testEnv(), LINE_CHANNEL_SECRET: "secret" },
    ctx,
    { async process() { await processing; processed = true; } },
  );

  try {
    const outcome = await Promise.race([
      responsePromise.then(() => "acknowledged"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(outcome).toBe("acknowledged");
    expect((await responsePromise).status).toBe(200);
    expect(processed).toBe(false);
  } finally {
    finishProcessing();
    await responsePromise;
    await Promise.all(backgroundTasks);
  }
  expect(processed).toBe(true);
});

it("returns 400 for a signed malformed top-level payload", async () => {
  const body = new TextEncoder().encode('{"events":"wrong"}');

  const response = await handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": await sign(body, "secret") },
      body,
    }),
    { ...testEnv(), LINE_CHANNEL_SECRET: "secret" },
    immediateContext,
    { process: vi.fn() },
  );

  expect(response.status).toBe(400);
});

it.each([
  [{ status: "started", importRunId: "import-1" }, { status: "started", importRunId: "import-1" }],
  [{ status: "already_running" }, { status: "already_running" }],
  [{ status: "sequence_not_bootstrapped" }, { status: "sequence_not_bootstrapped" }],
  [{ status: "workflow_start_failed" }, { status: "workflow_start_failed" }],
  [{ status: "import_trigger_failed" }, { status: "import_trigger_failed" }],
] as const)("preserves import trigger status %#", (body, expected) => {
  expect(parseUploadTriggerResponse(body)).toEqual(expected);
});

it.each([
  [{ status: "started", publicationRunId: "run-1" }, { status: "started", publicationRunId: "run-1" }],
  [{ status: "restarted", publicationRunId: "run-1" }, { status: "restarted", publicationRunId: "run-1" }],
  [{ status: "resumed", publicationRunId: "run-1" }, { status: "resumed", publicationRunId: "run-1" }],
  [{ status: "already_running", publicationRunId: "run-1" }, { status: "already_running", publicationRunId: "run-1" }],
  [{ status: "already_generated", publicationRunId: "run-1" }, { status: "already_generated", publicationRunId: "run-1" }],
  [{ status: "no_runnable_run" }, { status: "no_runnable_run" }],
] as const)("preserves publication trigger status %#", (result, expected) => {
  expect(toLineDocsTriggerResult(result)).toEqual(expected);
});

it("persists before acknowledging, deduplicates IDs, and returns 503 if persistence fails", async () => {
  const { createTestEnv } = await import("../helpers/env");
  const body = new TextEncoder().encode(JSON.stringify({ events: [{
    type: "message", webhookEventId: "evt-durable", replyToken: "reply",
    source: { type: "group", groupId: "CtestGroup", userId: "U1" },
    message: { type: "text", id: "msg", text: "/help" },
  }] }));
  const signature = await sign(body, "secret");
  const request = () => new Request("https://worker/line/webhook", {
    method: "POST", headers: { "x-line-signature": signature }, body,
  });
  let finish!: () => void;
  const createBatch = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("unavailable"));
  const env = { ...testEnv(), ...createTestEnv(), LINE_CHANNEL_SECRET: "secret", LINE_COMMAND_WORKFLOW: { createBatch } } as unknown as import("../../src/env").Env;
  let acknowledged = false;
  const first = handleLineRoute(request(), env, immediateContext).then(response => { acknowledged = true; return response; });
  await vi.waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));
  expect(acknowledged).toBe(false);
  finish();
  expect((await first).status).toBe(200);
  expect((await handleLineRoute(request(), env, immediateContext)).status).toBe(200);
  expect(createBatch.mock.calls[0]![0]).toEqual(createBatch.mock.calls[1]![0]);
  expect((await handleLineRoute(request(), env, immediateContext)).status).toBe(503);
});
