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
  expect(json).toContain("✓ เสร็จสิ้น");
  expect(json).toContain("A-10");
  expect(json).not.toContain('"type":"image"');
  expect(json.match(/messenger=complete/g)).toHaveLength(1);
  expect(json.match(/messenger=quote/g)).toHaveLength(2);
  expect(json).not.toContain("พรุ่งนี้");
  expect(json).not.toContain('"label":"วันนี้"');
  expect(json).toContain('"label":"เสร็จสิ้น"');
  const body = card.contents.body as { contents: any[] };
  const rows = body.contents.filter(
    (n) => n.type === "box" && n.layout === "vertical",
  );
  const actionRow = rows[0].contents[1];
  expect(actionRow.contents[0].text).toBe("A-2");
  const actions = actionRow.contents[1];
  expect(actions).toMatchObject({ flex: 0, width: "152px", spacing: "8px" });
  expect(actions.contents.map((b: any) => b.action.label)).toEqual([
    "อ้างอิง",
    "เสร็จสิ้น",
  ]);
  expect(
    actions.contents.every(
      (b: any) => b.height === "40px" && b.contents[0].size === "12px",
    ),
  ).toBe(true);
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
  expect(JSON.stringify(card)).toContain("/mess-overview 2");
});
