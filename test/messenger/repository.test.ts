import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createMessengerRepository } from "../../src/messenger/repository";
import { connection, input } from "./fixtures";
const db = (env as unknown as { DB: D1Database }).DB;
it("atomically retains one registration intent and one dispatch across reload", async () => {
  const repo = createMessengerRepository(db);
  const claims = await Promise.all([
    repo.claimRegistration({ delivery: input, connection, day: "2026-11-14" }),
    repo.claimRegistration({
      delivery: { ...input, id: "different", sourceEventId: "e2" },
      connection,
      day: "2026-11-14",
    }),
  ]);
  expect(claims.filter((x) => x.created)).toHaveLength(1);
  expect(claims[0]!.intent.id).toBe(claims[1]!.intent.id);
  expect(
    await Promise.all(claims.map((x) => repo.beginDispatch(x.intent.id))),
  ).toEqual([true, false]);
  const again = await createMessengerRepository(db).claimRegistration({
    delivery: input,
    connection,
    day: "2026-11-14",
  });
  expect(again.intent.phase).toBe("dispatched");
});
it("preserves first completion metadata and scopes action bindings", async () => {
  const repo = createMessengerRepository(db);
  const first = {
    deliveryId: "delivery-1",
    recordId: "rec1",
    groupId: "C1",
    connection,
    completion: { at: "2026-11-14T04:00:00Z", userId: "book", name: "Book" },
  };
  const a = await repo.claimCompletion(first),
    b = await repo.claimCompletion({
      ...first,
      completion: { ...first.completion, userId: "other" },
    });
  expect(b.intent.completion).toEqual(a.intent.completion);
  const action = {
    token: "t",
    kind: "complete" as const,
    deliveryId: "delivery-1",
    recordId: "rec1",
    groupId: "C1",
    day: "2026-11-14",
    page: 1,
    connection,
  };
  await repo.putAction(action);
  expect(await repo.getAction("t")).toEqual(action);
  expect(await repo.getAction("forged")).toBeNull();
});
it("rolls over only a confirmed receipt atomically and retains its history", async () => {
  const repo = createMessengerRepository(db);
  const input = {
    deliveryId: "reopen",
    recordId: "recReopen",
    groupId: "C1",
    connection,
    completion: { at: "2026-11-14T04:00:00Z", userId: "book", name: "Book" },
  };
  const { intent: old } = await repo.claimCompletion(input);
  await repo.beginDispatch(old.id);
  const blocked = await repo.claimCompletion({
    ...input,
    previousObservedIntentId: old.id,
  });
  expect(blocked.intent.id).toBe(old.id);
  await repo.recordObserved(old.id, input.recordId);
  const claims = await Promise.all(
    [1, 2].map(() =>
      repo.claimCompletion({ ...input, previousObservedIntentId: old.id }),
    ),
  );
  expect(claims.filter((c) => c.created)).toHaveLength(1);
  expect(claims[0]!.intent.id).toBe(claims[1]!.intent.id);
  expect(claims[0]!.intent.id).not.toBe(old.id);
  expect(
    await Promise.all(claims.map((c) => repo.beginDispatch(c.intent.id))),
  ).toEqual([true, false]);
  expect(
    await db
      .prepare("SELECT phase FROM messenger_write_intents WHERE id=?")
      .bind(old.id)
      .first(),
  ).toEqual({ phase: "observed" });
});
