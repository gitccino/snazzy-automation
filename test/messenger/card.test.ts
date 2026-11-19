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
    new Date("2026-11-14T04:00:00Z"),
  );
  const json = JSON.stringify(card.contents);
  expect(json).toContain("ผู้รับผิดชอบ · เจ");
  expect(json).toContain('"align":"end"');
  expect(json).not.toContain("✓");
  expect(json).not.toContain("MESSENGER");
  expect(json).not.toContain("ทันที");
  expect(json).toContain('"text":"1/2"');
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
  expect(body.contents[0]).toMatchObject({
    text: "แมสเซนเจอร์วันนี้",
    color: "#2C2C2C",
  });
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
  expect(actions.contents[0]).toMatchObject({ backgroundColor: "#FFFFFF" });
  expect(actions.contents[1]).toMatchObject({
    backgroundColor: "#F0F0F1",
    cornerRadius: "20px",
  });
  const doneLabel = rows[1].contents[1].contents[1].contents[1];
  expect(doneLabel).toMatchObject({
    text: "เสร็จสิ้น",
    color: "#178647",
    align: "center",
    gravity: "center",
    size: "12px",
    flex: 1,
  });
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
    new Date("2026-11-14T04:00:00Z"),
  );
  expect(JSON.stringify(card)).not.toContain(name);
  expect(d.responsibleName).toBe(name);
  expect(JSON.stringify(card)).toContain("/mess-overview 2");
});

it.each([
  [
    "Pending",
    "Scheduled",
    "2026-11-14T02:00:00.001Z",
    "09:00 · เกินกำหนด",
    "#CF3030",
  ],
  [
    "Pending",
    "Immediate",
    "2026-11-14T02:00:01Z",
    "09:00 · เกินกำหนด",
    "#CF3030",
  ],
  ["Pending", "Scheduled", "2026-11-14T02:00:00Z", "09:00", "#2C2C2C"],
  ["Pending", "Scheduled", "2026-11-14T01:59:00Z", "09:00", "#2C2C2C"],
  ["Done", "Immediate", "2026-11-14T04:00:00Z", "09:00", "#2C2C2C"],
] as const)(
  "colors only overdue unfinished times: %s %s %s",
  (status, scheduleType, now, label, color) => {
    const card = messengerOverviewCard(
      {
        day: "2026-11-14",
        page: 1,
        total: 1,
        done: status === "Done" ? 1 : 0,
        items: [{ ...delivery, status, scheduleType }],
        actions: {
          [delivery.id]: {
            quote: "q",
            complete: status === "Pending" ? "c" : null,
          },
        },
      },
      new Date(now),
    );
    const body = card.contents.body as { contents: any[] };
    const row = body.contents.find(
      (n) => n.type === "box" && n.layout === "vertical",
    );
    expect(row.contents[0].contents[0]).toMatchObject({ text: label, color });
  },
);
