import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemePicker } from "../src/components/theme-picker";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it("follows system changes, supports an explicit override, and restores the saved choice", () => {
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = true;
  vi.stubGlobal("matchMedia", () => media);
  const { unmount } = render(<ThemePicker />);
  expect(document.documentElement.dataset.theme).toBe("dark");
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.change(screen.getByLabelText("Appearance"), { target: { value: "dark" } });
  expect(localStorage.getItem("snazzy-settings-theme")).toBe("dark");
  media.dispatchEvent(new Event("change"));
  expect(document.documentElement.dataset.theme).toBe("dark");
  unmount();
  render(<ThemePicker />);
  expect(screen.getByDisplayValue("Dark")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Appearance"), { target: { value: "system" } });
  expect(document.documentElement.dataset.theme).toBe("light");
});
