import { expect, it, vi } from "vitest";
import type { AuditLog } from "../../src/db/audit";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import type { LineClient } from "../../src/line/client";
import { processLineEvents, type WebhookDeps } from "../../src/line/webhook";
import type { SupportedLineEvent } from "../../src/line/types";

const event: SupportedLineEvent = {
  type: "message",
  webhookEventId: "evt-1",
  replyToken: "reply-1",
  source: { type: "group", groupId: "C1", userId: "U1" },
  message: { type: "text", id: "msg-1", text: "/help" },
};

function deps(): WebhookDeps {
  const repo = {
    claimEvent: vi.fn().mockResolvedValue(true),
    releaseEvent: vi.fn().mockResolvedValue(undefined),
    findEventReply: vi.fn().mockResolvedValue(null),
    saveEventReply: vi.fn().mockResolvedValue(undefined),
    findPendingBySourceEvent: vi.fn(),
    createPending: vi.fn(),
    claimPending: vi.fn(),
    setPendingAfter: vi.fn(),
    resetPending: vi.fn(),
    resolvePending: vi.fn(),
    finalizeAction: vi.fn(),
    latestReversible: vi.fn(),
  } satisfies LineRepository;
  const line = {
    pushMessage: vi.fn(),
    replyFlex: vi.fn().mockResolvedValue(undefined),
    replyText: vi.fn().mockResolvedValue(undefined),
    replyButtons: vi.fn().mockResolvedValue(undefined),
    getGroupMemberProfile: vi.fn().mockResolvedValue({ userId: "U1", displayName: "Mint" }),
  } satisfies LineClient;
  const inventory = {
    listSalesForDay: vi.fn().mockResolvedValue([]),
    findByProductId: vi.fn(),
    updateSaleValues: vi.fn(),
  } satisfies InventoryClient;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } satisfies AuditLog;
  return {
    publicBaseUrl: "https://worker.example",
    allowedGroupId: "C1",
    confirmationEnabled: true,
    clock: { now: () => new Date("2026-09-01T10:00:00.000Z") },
    ids: { next: () => "corr-1" },
    repo,
    audit,
    inventory,
    line,
    triggerUpload: vi.fn(),
    triggerDocs: vi.fn(),
  };
}

it("claims, ignores, and audits a disallowed group once", async () => {
  const d = deps();
  const disallowed: SupportedLineEvent = { ...event, source: { ...event.source, groupId: "OTHER" } };

  await processLineEvents([disallowed], d);

  expect(d.repo.claimEvent).toHaveBeenCalledWith("evt-1", "OTHER");
  expect(d.line.replyFlex).not.toHaveBeenCalled();
  expect(d.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "line_disallowed_group" }));
});

it("deduplicates before profile lookup and command execution", async () => {
  const d = deps();
  vi.mocked(d.repo.claimEvent).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

  await processLineEvents([event, event], d);

  expect(d.line.getGroupMemberProfile).toHaveBeenCalledTimes(1);
  expect(d.line.replyFlex).toHaveBeenCalledTimes(1);
});

it("releases the event claim when command processing throws", async () => {
  const d = deps();
  vi.mocked(d.line.getGroupMemberProfile).mockRejectedValueOnce(new Error("LINE unavailable"));

  await expect(processLineEvents([event], d)).rejects.toThrow("LINE unavailable");

  expect(d.repo.releaseEvent).toHaveBeenCalledWith("evt-1");
});

it("passes source and applying webhook IDs into soldout lifecycle", async () => {
  const d = deps();
  const soldoutEvent: SupportedLineEvent = {
    ...event,
    message: { ...event.message, text: "/soldout A-1 ราคา 100" },
  };
  vi.mocked(d.inventory.findByProductId).mockResolvedValue({
    recordId: "rec1", productId: "A-1", uploadDate: null, airtableUrl: "https://airtable/r",
    inventoryStatus: "In", soldPrice: null, soldAt: null, soldBy: null,
  });
  vi.mocked(d.repo.findPendingBySourceEvent).mockResolvedValue(null);
  vi.mocked(d.repo.createPending).mockImplementation(async (value) => value);

  await processLineEvents([soldoutEvent], d);

  expect(d.repo.createPending).toHaveBeenCalledWith(expect.objectContaining({ sourceEventId: "evt-1" }));
});

it("uses the signed source user ID when LINE profile identity disagrees", async () => {
  const d = deps();
  const soldoutEvent: SupportedLineEvent = {
    ...event,
    message: { ...event.message, text: "/soldout A-1 ราคา 100" },
  };
  vi.mocked(d.line.getGroupMemberProfile).mockResolvedValue({
    userId: "U-profile-mismatch",
    displayName: "Mint",
  });
  vi.mocked(d.inventory.findByProductId).mockResolvedValue({
    recordId: "rec1", productId: "A-1", uploadDate: null, airtableUrl: "https://airtable/r",
    inventoryStatus: "In", soldPrice: null, soldAt: null, soldBy: null,
  });
  vi.mocked(d.repo.findPendingBySourceEvent).mockResolvedValue(null);
  vi.mocked(d.repo.createPending).mockImplementation(async (value) => value);

  await processLineEvents([soldoutEvent], d);

  expect(d.repo.createPending).toHaveBeenCalledWith(expect.objectContaining({
    requesterUserId: "U1",
  }));
});

it.each([
  ["duplicate action", "action=soldout&action=revert&decision=approve&token=tok"],
  ["duplicate decision", "action=soldout&decision=approve&decision=reject&token=tok"],
  ["duplicate token", "action=soldout&decision=approve&token=tok&token=other"],
  ["missing action", "decision=approve&token=tok"],
  ["missing decision", "action=soldout&token=tok"],
  ["missing token", "action=soldout&decision=approve"],
  ["empty action", "action=&decision=approve&token=tok"],
  ["empty decision", "action=soldout&decision=&token=tok"],
  ["empty token", "action=soldout&decision=approve&token="],
  ["unexpected key", "action=soldout&decision=approve&token=tok&extra=value"],
])("rejects postback with %s without consuming a token", async (_name, data) => {
  const d = deps();
  const postback: SupportedLineEvent = {
    type: "postback",
    webhookEventId: "evt-postback",
    replyToken: "reply-postback",
    source: { type: "group", groupId: "C1", userId: "U1" },
    postback: { data },
  };
  vi.mocked(d.repo.claimPending).mockResolvedValue(null);

  await processLineEvents([postback], d);

  expect(d.repo.claimPending).not.toHaveBeenCalled();
  expect(d.repo.resolvePending).not.toHaveBeenCalled();
  expect(d.line.replyText).toHaveBeenCalledWith(
    "reply-postback",
    "คำยืนยันไม่ถูกต้อง",
  );
});

it("delivers report Flex replies without inventory mutation or pipeline execution", async () => {
  const d = deps();
  await processLineEvents([{ ...event, message: { ...event.message, text: "/report" } }], d);
  expect(d.line.replyFlex).toHaveBeenCalledWith("reply-1", expect.stringContaining("สรุปยอดขาย"), expect.objectContaining({ type: "bubble" }));
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.triggerUpload).not.toHaveBeenCalled(); expect(d.triggerDocs).not.toHaveBeenCalled();
});
