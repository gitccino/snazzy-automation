import { describe, expect, it, vi } from "vitest";
import {
  buildImportSummaryMessage,
  buildImportSummaryCard,
  sendImportSummary,
} from "../../src/import/notify";
import type { ImportRunResult } from "../../src/import/types";

const nowThaiText = "1 กันยายน 2569 09:00";

describe("buildImportSummaryMessage", () => {
  it("builds the exact Thai clean-success summary with imported Product IDs", () => {
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: ["A-501", "A-502"],
      failedGroups: [],
    };

    expect(buildImportSummaryMessage({ result, orphanRange: null, nowThaiText })).toBe(
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 2 รายการ\nA-501, A-502",
    );
  });

  it("builds a mixed-failure summary with Product IDs, Thai reasons, and retry detail", () => {
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: ["A-501"],
      failedGroups: [
        {
          groupId: "group-2",
          productId: "A-502",
          errorCode: "airtable_rate_limited",
        },
      ],
    };

    expect(buildImportSummaryMessage({ result, orphanRange: null, nowThaiText })).toBe(
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 1 รายการ\nA-501\nล้มเหลว 1 รายการ\n- A-502: Airtable จำกัดจำนวนคำขอชั่วคราว\nแก้ไขแล้วพิมพ์ /upload เพื่อลองใหม่",
    );
    const card = JSON.stringify(buildImportSummaryCard({ result, orphanRange: null, nowThaiText }, "https://worker.example"));
    expect(card).toContain("นำเข้าสำเร็จบางรายการ");
    expect(card).toContain("alert-v1.png");
    expect(card).toContain("A-501");
    expect(card).toContain("A-502");
    expect(card).not.toContain("group-2");
    expect(card).not.toContain("airtable_rate_limited");
  });

  it("reports an orphan photo range separately", () => {
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: [],
      failedGroups: [],
    };

    expect(
      buildImportSummaryMessage({
        result,
        orphanRange: {
          firstApplePhotoId: "apple-1",
          lastApplePhotoId: "apple-3",
          count: 3,
        },
        nowThaiText,
      }),
    ).toBe(
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 0 รายการ\nพบภาพ 3 ภาพก่อนมาร์กเกอร์แรก — เพิ่มมาร์กเกอร์ก่อนภาพสินค้า แล้วลอง /upload อีกครั้ง",
    );
  });

  it("uses the unknown Product ID fallback for a failed group", () => {
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: [],
      failedGroups: [
        { groupId: "group-3", productId: null, errorCode: "missing_product_id" },
      ],
    };

    expect(buildImportSummaryMessage({ result, orphanRange: null, nowThaiText })).toContain(
      "- รายการที่ 1 (ยังไม่มีรหัสสินค้า): ระบบนำเข้ารายการนี้ไม่สำเร็จ",
    );
  });

  it("allowlists only displayed fields and excludes unused secret-like import-run text", () => {
    const result: ImportRunResult = {
      importRunId: "private-token=sentinel&sig=sentinel",
      succeededProductIds: ["A-501"],
      failedGroups: [],
    };

    const message = buildImportSummaryMessage({ result, orphanRange: null, nowThaiText });

    expect(message).toBe(
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 1 รายการ\nA-501",
    );
    expect(message).not.toContain("token=sentinel");
    expect(message).not.toContain("sig=sentinel");
  });
});

describe("sendImportSummary", () => {
  it("pushes the exact built message to the requested group", async () => {
    const pushMessage = vi.fn().mockResolvedValue(undefined);
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: ["A-501"],
      failedGroups: [],
    };
    const input = { result, orphanRange: null, nowThaiText };

    await sendImportSummary({
      pushMessage,
      replyFlex: async () => undefined,
      replyText: async () => undefined,
      replyButtons: async () => undefined,
      getGroupMemberProfile: async () => ({ userId: "unused", displayName: "unused" }),
    }, "group-1", input, "https://worker.example");

    expect(pushMessage).toHaveBeenCalledExactlyOnceWith(
      "group-1",
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 1 รายการ\nA-501",
      buildImportSummaryCard(input, "https://worker.example"),
    );
  });

  it("propagates a LINE push rejection", async () => {
    const pushError = new Error("LINE unavailable");
    const pushMessage = vi.fn().mockRejectedValue(pushError);
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: [],
      failedGroups: [],
    };

    await expect(
      sendImportSummary(
        {
          pushMessage,
          replyFlex: async () => undefined,
          replyText: async () => undefined,
          replyButtons: async () => undefined,
          getGroupMemberProfile: async () => ({ userId: "unused", displayName: "unused" }),
        },
        "group-1",
        { result, orphanRange: null, nowThaiText },
        "https://worker.example",
      ),
    ).rejects.toBe(pushError);

    expect(pushMessage).toHaveBeenCalledExactlyOnceWith(
      "group-1",
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nไม่มีสินค้าใหม่ให้นำเข้า",
      buildImportSummaryCard({ result, orphanRange: null, nowThaiText }, "https://worker.example"),
    );
  });
});
