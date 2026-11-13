import { expect, it } from "vitest";
import { messengerOverviewCard } from "../../src/messenger/card";
import { delivery } from "./fixtures";
it("renders compact two-line rows with right-aligned responsibility and persistent Done state", () => {
  const done = {
    ...delivery,
    id: "d2",
    productId: "A-10",
    status: "Done" as const,
  };
  const card = messengerOverviewCard(
    {
      day: "2026-11-14",
      page: 1,
      total: 2,
      done: 1,
      items: [delivery, done],
      actions: {
        [delivery.id]: { quote: "q1", complete: "c1" },
        d2: { quote: "q2", complete: null },
      },
    },
    "2026-11-14",
  );
  const json = JSON.stringify(card.contents);
  expect(json).toContain("ผู้รับผิดชอบ · เจ");
  expect(json).toContain('"align":"end"');
  expect(json).toContain("✓ เสร็จแล้ว");
  expect(json).toContain("A-10");
  expect(json).not.toContain('"type":"image"');
  expect(json.match(/messenger=complete/g)).toHaveLength(1);
  expect(json.match(/messenger=quote/g)).toHaveLength(2);
  expect(json).toContain("/mess-overview 15/11/2026 1");
  expect(card.text).toContain("2 รายการ");
});
it("limits rendering to five and truncates long names without changing the source data", () => {
  const name = "ยาว".repeat(100);
  const d = { ...delivery, responsibleName: name };
  const card = messengerOverviewCard(
    {
      day: "2026-11-14",
      page: 1,
      total: 7,
      done: 0,
      items: [d],
      actions: { [d.id]: { quote: "q", complete: "c" } },
    },
    "2026-11-14",
  );
  expect(JSON.stringify(card)).not.toContain(name);
  expect(d.responsibleName).toBe(name);
  expect(JSON.stringify(card)).toContain("/mess-overview 14/11/2026 2");
});
