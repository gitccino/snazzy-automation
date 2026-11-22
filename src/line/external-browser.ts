// Apply at card construction so stored URLs and import source identities stay canonical.
export function externalBrowserUri(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return value;
    url.searchParams.set("openExternalBrowser", "1");
    return url.toString();
  } catch { return value; }
}
