import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { sampleView } from "./sample";
import { App } from "../src/app";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("searches technical keys and keeps changes local until Save", async () => {
  const view = sampleView();
  const fetcher = vi.fn(async () => Response.json({ ok: true, value: view }));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByLabelText("Google Docs template");
  fireEvent.change(screen.getByLabelText("Search settings"), {
    target: { value: "GOOGLE_TEMPLATE_DOC_ID" },
  });
  expect(screen.getByLabelText("Google Docs template")).toBeTruthy();
  expect(screen.queryByLabelText("Airtable base")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search settings"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  fireEvent.click(screen.getByLabelText("AI auto-captioning"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(
    (screen.getByLabelText("AI auto-captioning") as HTMLInputElement).checked,
  ).toBe(false);
});
it("saves only the edited section and preserves a draft in another section", async () => {
  const view = sampleView();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      expect(body.section).toBe("documents");
      expect(body.changes).not.toHaveProperty("AIRTABLE_BASE_ID");
      return Response.json({
        ok: true,
        value: {
          ...view,
          record: {
            ...view.record,
            revision: 2,
            settings: { ...view.record.settings, AI_CAPTIONS_ENABLED: true },
          },
        },
      });
    }
    return Response.json({ ok: true, value: view });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  const input = await screen.findByLabelText("Airtable base");
  fireEvent.change(input, { target: { value: "appDraft" } });
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  fireEvent.click(screen.getByLabelText("AI auto-captioning"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Saved"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect(
    (screen.getByLabelText("Airtable base") as HTMLInputElement).value,
  ).toBe("appDraft");
});
it("retains a failed draft and offers reload on a revision conflict", async () => {
  const view = sampleView();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      Response.json(
        init?.method === "PATCH"
          ? { ok: false, code: "revision_conflict" }
          : { ok: true, value: view },
      ),
    ),
  );
  render(<App />);
  await screen.findByLabelText("Airtable base");
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  fireEvent.click(screen.getByLabelText("AI auto-captioning"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Reload settings" });
  expect(
    (screen.getByLabelText("AI auto-captioning") as HTMLInputElement).checked,
  ).toBe(true);
});
it("requires review of changed Airtable targets before saving", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, value: sampleView() })),
  );
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Airtable base"), {
    target: { value: "appNew" },
  });
  expect(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByText("Review the Airtable connection change"),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByLabelText(
      "I understand these effects and want to use this connection.",
    ),
  );
  expect(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
