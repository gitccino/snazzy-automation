import { fakeMutationCoordinator } from "../helpers/mutation";
import { expect, it, vi } from "vitest";
import { createLineRepository } from "../../src/db/line-repository";
import { createInventoryClient, type InventoryClient } from "../../src/line/airtable-inventory";
import { prepareSoldout, resolveSoldout } from "../../src/line/soldout";
import { prepareRevert, resolveRevert } from "../../src/line/revert";
import { processLineEvents, type WebhookDeps } from "../../src/line/webhook";
import type { InventoryProduct, SaleValues, SupportedLineEvent } from "../../src/line/types";
import { testEnv } from "../helpers/env";
import { sequentialIdGenerator } from "../helpers/fakes";

let sequence = 99000;
function setup(legacy: Partial<SaleValues> = {}) {
  const productId = `A-${sequence++}`;
  const ids = sequentialIdGenerator(productId);
  let now = new Date("2026-09-01T10:00:00.000Z");
  const clock = { now: () => now };
  const actor = { groupId: `C-${productId}`, userId: "U1", displayName: "Mint" };
  let state: InventoryProduct = {
    recordId: `rec-${productId}`, productId, uploadDate: null, airtableUrl: "https://airtable/r",
    inventoryStatus: "In", soldPrice: null, soldAt: null, soldBy: null, ...legacy,
  };
  const writes: SaleValues[] = [];
  const inventory = {
    listSalesForDay: vi.fn().mockResolvedValue([]),
    findByProductId: vi.fn(async () => ({ ...state })),
    updateSaleValues: vi.fn(async (_recordId: string, values: SaleValues) => {
      writes.push(values);
      state = { ...state, ...values };
    }),
  } satisfies InventoryClient;
  const d = { repo: createLineRepository(testEnv().DB, ids, clock), inventory, ids, clock, mutation: fakeMutationCoordinator(inventory) };
  const source = (name: string) => `${productId}-${name}`;
  return { d, actor, productId, source, writes, state: () => state, setTime: (iso: string) => { now = new Date(iso); } };
}

it("serializes concurrent soldout preparations and approvals by product across groups", async () => {
  const h = setup();
  const replies = await Promise.all([
    prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("one"), true, h.d),
    prepareSoldout({ productId: h.productId, soldPrice: 200 }, { ...h.actor, groupId: "other-group" }, h.source("two"), true, h.d),
  ]);
  expect(replies.filter(reply => reply.kind === "buttons")).toHaveLength(1);
  const pending = await Promise.all([h.d.repo.findPendingBySourceEvent(h.source("one")), h.d.repo.findPendingBySourceEvent(h.source("two"))]);
  const owner = pending.find(p => p !== null)!;
  await Promise.all([
    resolveSoldout("approve", owner.token, { ...h.actor, groupId: owner.groupId }, h.source("apply-one"), "corr-one", h.d),
    resolveSoldout("approve", owner.token, { ...h.actor, groupId: owner.groupId }, h.source("apply-two"), "corr-two", h.d),
  ]);
  expect(h.writes).toHaveLength(1);
  expect((await testEnv().DB.prepare("SELECT count(*) AS n FROM line_actions WHERE product_id = ?").bind(h.productId).first<{ n: number }>())?.n).toBe(1);
});

it("replaces elapsed pending soldout commands but retains uncertain applying ownership", async () => {
  const h = setup();
  await prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("one"), true, h.d);
  h.setTime("2026-09-01T10:11:00.000Z");
  expect((await prepareSoldout({ productId: h.productId, soldPrice: 200 }, h.actor, h.source("two"), true, h.d)).kind).toBe("buttons");
  expect((await h.d.repo.findPendingBySourceEvent(h.source("one")))?.status).toBe("expired");
  const pending = (await h.d.repo.findPendingBySourceEvent(h.source("two")))!;
  h.d.inventory.updateSaleValues.mockRejectedValueOnce(new Error("write uncertain"));
  await expect(resolveSoldout("approve", pending.token, h.actor, h.source("apply"), "corr", h.d)).rejects.toThrow("write uncertain");
  h.setTime("2026-09-01T11:00:00.000Z");
  expect((await prepareSoldout({ productId: h.productId, soldPrice: 300 }, h.actor, h.source("three"), true, h.d)).kind).toBe("text");
  expect((await h.d.repo.findPendingBySourceEvent(h.source("two")))?.status).toBe("applying");
  await resolveSoldout("approve", pending.token, h.actor, h.source("apply"), "corr", h.d);
  expect(h.state().soldPrice).toBe(200);
});

it("does not mistake a stale prepare matching another completed sale for its own recovered write", async () => {
  const h = setup();
  const staleProduct = { ...h.state() };
  await prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("first"), false, h.d);
  h.d.inventory.findByProductId.mockResolvedValueOnce(staleProduct);
  await prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("late"), false, h.d);
  expect(h.writes).toHaveLength(1);
  expect((await testEnv().DB.prepare("SELECT count(*) AS n FROM line_actions WHERE product_id = ?").bind(h.productId).first<{ n: number }>())?.n).toBe(1);
  expect((await h.d.repo.findPendingBySourceEvent(h.source("late")))?.status).toBe("rejected");
});

it("replaces an unclicked revert after eleven minutes without expiring applying reverts", async () => {
  const h = setup();
  await prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("sale"), false, h.d);
  await prepareRevert(h.actor, h.source("revert-one"), h.d);
  h.setTime("2026-09-01T10:11:00.000Z");
  expect((await prepareRevert(h.actor, h.source("revert-two"), h.d)).kind).toBe("buttons");
  expect((await h.d.repo.findPendingBySourceEvent(h.source("revert-one")))?.status).toBe("expired");
  const pending = (await h.d.repo.findPendingBySourceEvent(h.source("revert-two")))!;
  await h.d.repo.claimPending(pending.token, h.actor.groupId, "revert", h.source("apply"), h.d.clock.now().toISOString());
  h.setTime("2026-09-01T11:00:00.000Z");
  expect((await prepareRevert(h.actor, h.source("revert-three"), h.d)).kind).toBe("text");
  expect((await h.d.repo.findPendingBySourceEvent(h.source("revert-two")))?.status).toBe("applying");
});

it("retains revert ownership through uncertain write, recovery read failure, and expiry", async () => {
  const h = setup();
  await prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("sale"), false, h.d);
  await prepareRevert(h.actor, h.source("revert"), h.d);
  const pending = (await h.d.repo.findPendingBySourceEvent(h.source("revert")))!;
  const realWrite = h.d.inventory.updateSaleValues.getMockImplementation()!;
  h.d.inventory.updateSaleValues.mockImplementationOnce(async (...args) => { await realWrite(...args); throw new Error("response lost"); });
  const retry = () => resolveRevert("approve", pending.token, h.actor, h.source("apply"), "corr", h.d);
  await expect(retry()).rejects.toThrow("response lost");
  h.d.inventory.findByProductId.mockRejectedValueOnce(new Error("read unavailable"));
  await expect(retry()).rejects.toThrow("read unavailable");
  expect((await h.d.repo.findPendingBySourceEvent(h.source("revert")))?.status).toBe("applying");
  h.setTime("2026-09-01T11:00:00.000Z");
  expect(await h.d.repo.claimPending(pending.token, h.actor.groupId, "revert", "intruder", h.d.clock.now().toISOString())).toBeNull();
  expect((await retry()).text).toContain("สำเร็จ");
  expect(h.writes).toHaveLength(2);
  expect(await h.d.repo.latestReversible(h.actor.groupId)).toBeNull();
});

it("restores exact legacy In values through the real Airtable writer and D1 audit", async () => {
  const legacy: SaleValues = { inventoryStatus: "In", soldPrice: 800, soldAt: "2026-08-01", soldBy: "Previous operator" };
  const h = setup(legacy);
  let fields: Record<string, unknown> = { "Product ID": h.productId, "Inventory Status": "In", "Sold Price": 800, "Sold At": "2026-08-01", "Sold By": "Previous operator" };
  const inventory = createInventoryClient({ baseId: "app", tableId: "tbl", token: "test", fetch: async (_url, init) => {
    if (init?.method === "PATCH") {
      fields = { ...fields, ...JSON.parse(String(init.body)).fields };
      return Response.json({});
    }
    return Response.json({ records: [{ id: "rec1", fields }] });
  } });
  const d = { ...h.d, inventory, mutation: fakeMutationCoordinator(inventory) };
  await prepareSoldout({ productId: h.productId, soldPrice: 100 }, h.actor, h.source("sale"), false, d);
  await prepareRevert(h.actor, h.source("revert"), d);
  const pending = (await d.repo.findPendingBySourceEvent(h.source("revert")))!;
  await resolveRevert("approve", pending.token, h.actor, h.source("apply"), h.source("corr"), d);
  expect(await inventory.findByProductId(h.productId)).toMatchObject(legacy);
  const audit = await testEnv().DB.prepare("SELECT after_value FROM audit_events WHERE correlation_id = ?").bind(h.source("corr")).first<{ after_value: string }>();
  expect(JSON.parse(audit!.after_value)).toEqual(legacy);
});

function webhookSetup() {
  const h = setup();
  const line = { replyFlex: vi.fn(), pushMessage: vi.fn(), replyText: vi.fn().mockResolvedValue(undefined), replyButtons: vi.fn(), getGroupMemberProfile: vi.fn().mockResolvedValue({ userId: "U1", displayName: "Mint" }) };
  const d: WebhookDeps = { ...h.d, publicBaseUrl: "https://worker.example", line, allowedGroupId: h.actor.groupId, confirmationEnabled: false, audit: { record: vi.fn() }, triggerDocs: vi.fn(), triggerUpload: vi.fn() };
  const message = (name: string, text: string): SupportedLineEvent => ({ type: "message", webhookEventId: h.source(name), replyToken: `reply-${name}`, source: { type: "group", groupId: h.actor.groupId, userId: h.actor.userId }, message: { id: name, type: "text", text } });
  return { ...h, d, message, line };
}

it("attempts later events despite reply failure and retries the stored successful mutation outcome", async () => {
  const h = webhookSetup();
  const events = [h.message("sale", `/soldout ${h.productId} THB 100`), h.message("help", "/help")];
  h.line.replyFlex.mockRejectedValueOnce(new Error("reply response lost"));
  await expect(processLineEvents(events, h.d)).rejects.toThrow("reply response lost");
  expect(h.line.replyFlex.mock.calls.map(call => call[0])).toEqual(["reply-sale", "reply-help"]);
  expect(h.line.replyText).not.toHaveBeenCalled();
  const saleReply = h.line.replyFlex.mock.calls[0];
  await processLineEvents(events, h.d);
  expect(h.line.replyFlex.mock.calls.map(call => call[0])).toEqual(["reply-sale", "reply-help", "reply-sale"]);
  expect(h.line.replyText).not.toHaveBeenCalled();
  expect(h.line.replyFlex.mock.calls[2]).toEqual(saleReply);
  expect(h.writes).toHaveLength(1);
  expect(h.line.getGroupMemberProfile).toHaveBeenCalledTimes(2);
});

it("does not starve a later event on repeated invalid reply-token redeliveries", async () => {
  const h = webhookSetup();
  h.line.replyFlex.mockImplementation(async token => { if (token === "reply-one") throw new Error("invalid reply token"); });
  const events = [h.message("one", "/help"), h.message("two", "/help")];
  await expect(processLineEvents(events, h.d)).rejects.toThrow("invalid reply token");
  await expect(processLineEvents(events, h.d)).rejects.toThrow("invalid reply token");
  expect(h.line.replyFlex.mock.calls.map(call => call[0])).toEqual(["reply-one", "reply-two", "reply-one"]);
});

it.each(["soldout", "revert"] as const)("recovers completed %s when saving the delivery outcome failed", async kind => {
  const h = webhookSetup();
  let event = h.message("sale", `/soldout ${h.productId} THB 100`);
  if (kind === "revert") {
    await processLineEvents([event], h.d);
    await prepareRevert(h.actor, h.source("revert"), h.d);
    const pending = (await h.d.repo.findPendingBySourceEvent(h.source("revert")))!;
    event = { type: "postback", source: event.source, webhookEventId: h.source("approve"), replyToken: "reply-revert", postback: { data: `action=revert&decision=approve&token=${pending.token}` } };
  }
  const save = h.d.repo.saveEventReply.bind(h.d.repo);
  h.d.repo.saveEventReply = vi.fn().mockRejectedValueOnce(new Error("outcome unavailable")).mockImplementation(save);
  await expect(processLineEvents([event], h.d)).rejects.toThrow("outcome unavailable");
  h.setTime("2026-09-01T11:00:00.000Z");
  await processLineEvents([event], h.d);
  const delivered = h.line.replyFlex.mock.lastCall;
  expect(delivered?.[1]).toContain(kind === "soldout" ? "เป็น Out ราคา 100" : "สำเร็จ");
  expect(h.writes).toHaveLength(kind === "soldout" ? 1 : 2);
});

it("releases a claimed event when correlation ID generation fails", async () => {
  const h = webhookSetup();
  const event = h.message("one", "/help");
  h.d.ids = { next: () => { throw new Error("ID generator failed"); } };
  await expect(processLineEvents([event], h.d)).rejects.toThrow("ID generator failed");
  expect(await h.d.repo.claimEvent(event.webhookEventId, h.actor.groupId)).toBe(true);
});
