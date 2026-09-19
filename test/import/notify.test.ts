import { describe, expect, it, vi } from "vitest";
import {
  buildImportSummaryMessage,
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

  it("builds the exact mixed-failure summary with group, Product ID, error, and retry detail", () => {
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
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 1 รายการ\nA-501\nล้มเหลว 1 รายการ\n- กลุ่ม group-2 (A-502): airtable_rate_limited\nแก้ไขแล้วพิมพ์ /upload เพื่อลองใหม่",
    );
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
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 0 รายการ\nพบรูปก่อนมาร์กเกอร์แรก 3 รูป (apple-1 ถึง apple-3) — ยังไม่สร้างสินค้า",
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
      "- กลุ่ม group-3 (ไม่ทราบรหัส): missing_product_id",
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
      replyText: async () => undefined,
      replyButtons: async () => undefined,
      getGroupMemberProfile: async () => ({ userId: "unused", displayName: "unused" }),
    }, "group-1", input);

    expect(pushMessage).toHaveBeenCalledExactlyOnceWith(
      "group-1",
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 1 รายการ\nA-501",
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
          replyText: async () => undefined,
          replyButtons: async () => undefined,
          getGroupMemberProfile: async () => ({ userId: "unused", displayName: "unused" }),
        },
        "group-1",
        { result, orphanRange: null, nowThaiText },
      ),
    ).rejects.toBe(pushError);

    expect(pushMessage).toHaveBeenCalledExactlyOnceWith(
      "group-1",
      "นำเข้ารูปภาพ — 1 กันยายน 2569 09:00\nสำเร็จ 0 รายการ",
    );
  });
});
