import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProductNumber } from "../src/components/product-number";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = () => ({ current: 100, revision: 2, onSaved: vi.fn(), onReload: vi.fn(), onDirty: vi.fn() });
it("blocks backwards and fractional edits and saves only the live counter request", async () => {
  const p = props();
  const fetcher = vi.fn(async () => Response.json({ ok: true, value: { nextProductNumber: 200 } }));
  vi.stubGlobal("fetch", fetcher);
  render(<ProductNumber {...p} />);
  const input = screen.getByLabelText("Next product number");
  fireEvent.change(input, { target: { value: "99" } });
  expect((screen.getByRole("button", { name: "Save next number" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "100.5" } });
  expect((screen.getByRole("button", { name: "Save next number" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: "Save next number" }));
  await screen.findByText("Saved. The next product will use A-200.");
  expect(p.onSaved).toHaveBeenCalledWith(200);
  const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe("/api/settings/next-product-number");
  expect(JSON.parse(String(call[1].body))).toEqual({ expectedRevision: 2, expectedNextValue: 100, nextValue: 200 });
});
it("retains a conflicted draft and requires a reload", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, code: "sequence_conflict" }, { status: 409 })));
  const p = props(); render(<ProductNumber {...p} />);
  fireEvent.change(screen.getByLabelText("Next product number"), { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: "Save next number" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload settings" }));
  expect(p.onReload).toHaveBeenCalled();
  expect(screen.getByDisplayValue("200")).toBeTruthy();
  expect(p.onSaved).not.toHaveBeenCalled();
});
it("disables editing until the sequence is bootstrapped", () => {
  render(<ProductNumber {...props()} current={null} />);
  expect((screen.getByLabelText("Next product number") as HTMLInputElement).disabled).toBe(true);
});
