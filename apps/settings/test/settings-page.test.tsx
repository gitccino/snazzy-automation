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
  fireEvent.click(await screen.findByRole("button", { name: /Google Drive & Docs/ }));
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
  fireEvent.click(await screen.findByRole("button", { name: /^Airtable/ }));
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
  await screen.findByRole("button", { name: /^Airtable/ });
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
  fireEvent.click(await screen.findByRole("button", { name: /^Airtable/ }));
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

it("starts with compact connection summaries and reveals fields on demand", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, value: sampleView() })));
  render(<App />);
  const airtable = await screen.findByRole("button", { name: /^Airtable/ });
  expect(airtable.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByLabelText("Airtable base")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "System details" })).toBeNull();
  fireEvent.click(airtable);
  expect(screen.getByLabelText("Airtable base")).toBeTruthy();
  expect(screen.queryByLabelText("Google Docs template")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "GOOGLE_TEMPLATE_DOC_ID" } });
  expect(screen.getByLabelText("Google Docs template")).toBeTruthy();
});

it("retains edits and explains a network failure while saving", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PATCH") throw new TypeError("Network error");
    return Response.json({ ok: true, value: sampleView() });
  }));
  render(<App />);
  await screen.findByRole("button", { name: /^Airtable/ });
  fireEvent.click(screen.getByRole("button", { name: "Documents" }));
  fireEvent.click(screen.getByLabelText("AI auto-captioning"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/Could not save. Check your connection/);
  expect((screen.getByLabelText("AI auto-captioning") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
});

it("opens system details as a category and preserves edits when returning", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, value: sampleView() })));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Airtable/ }));
  fireEvent.change(screen.getByLabelText("Airtable base"), { target: { value: "appDraft" } });
  fireEvent.click(screen.getByRole("button", { name: "System details" }));
  expect(screen.getByRole("heading", { name: "System details" })).toBeTruthy();
  expect(screen.queryByLabelText("Airtable base")).toBeNull();
  expect(screen.queryByText("No settings found")).toBeNull();
  expect(screen.getByRole("link", { name: "Export saved settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect((screen.getByLabelText("Airtable base") as HTMLInputElement).value).toBe("appDraft");
});

it("sends connection checks to the live API contract with only provider fields", async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true, value: sampleView() }));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByRole("button", { name: /^Airtable/ });
  fireEvent.click(screen.getByText("Check connections"));
  fireEvent.click(screen.getByRole("button", { name: "Test Google connection" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const call = fetcher.mock.calls[1] as unknown as [string, RequestInit];
  expect(call[0]).toBe("/api/settings/test-connection");
  const body = JSON.parse(String(call[1].body));
  expect(body.expectedRevision).toBe(1);
  expect(body.connection).toBe("google");
  expect(Object.keys(body.changes).sort()).toEqual(["GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_TEMPLATE_DOC_ID"]);
});

it("saves the editable Claude model in Documents", async () => {
  const view = sampleView();
  let saved: unknown;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") saved = JSON.parse(String(init.body));
    return Response.json({ ok: true, value: view });
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
  const select = screen.getByRole("combobox", { name: "Claude model" }) as unknown as HTMLSelectElement;
  expect(select.value).toBe("claude-opus-5");
  expect(Array.from(select.querySelectorAll("optgroup")).map(group => group.label)).toEqual(["Haiku", "Sonnet", "Opus"]);
  expect(Array.from(select.options).map(option => option.text)).toEqual([
    "Claude Haiku 4.5", "Claude Haiku 5.5",
    "Claude Sonnet 5.5", "Claude Sonnet 5", "Claude Sonnet 4.6", "Claude Sonnet 4.5",
    "Claude Opus 5.5", "Claude Opus 5", "Claude Opus 4.8", "Claude Opus 4.7", "Claude Opus 4.6", "Claude Opus 4.5",
  ]);
  fireEvent.change(select, { target: { value: "claude-sonnet-4-5" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saved).toMatchObject({ section: "documents", changes: { CLAUDE_MODEL: "claude-sonnet-4-5" } }));
});

it("preserves an existing model outside the approved list without silently switching", async () => {
  const view = sampleView();
  view.record.settings.CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, value: view })));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
  const select = screen.getByRole("combobox", { name: "Claude model" }) as unknown as HTMLSelectElement;
  expect(select.value).toBe("claude-sonnet-4-5-20250929");
  expect(select.selectedOptions[0]?.text).toContain("Current");
  expect(select.selectedOptions[0]?.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});
