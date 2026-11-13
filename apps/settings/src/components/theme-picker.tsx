import React, { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const storageKey = "snazzy-settings-theme";

export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* Appearance still works when storage is unavailable. */ }
    return "system";
  });

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system"
        ? media?.matches ? "dark" : "light"
        : theme;
    };
    apply();
    media?.addEventListener("change", apply);
    try { localStorage.setItem(storageKey, theme); } catch { /* Session-only preference. */ }
    return () => media?.removeEventListener("change", apply);
  }, [theme]);

  return <label className="theme-picker">
    <span className="sr-only">Appearance</span>
    <select aria-label="Appearance" value={theme} onChange={event => setTheme(event.target.value as Theme)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
    <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
  </label>;
}
