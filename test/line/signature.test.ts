import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "../../src/line/signature";

async function sign(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return btoa(String.fromCharCode(...bytes));
}

describe("verifyLineSignature", () => {
  it("accepts exact raw bytes and rejects a changed body", async () => {
    const body = new TextEncoder().encode('{"events":[]}');
    const signature = await sign(body, "channel-secret");

    expect(await verifyLineSignature(body.buffer as ArrayBuffer, signature, "channel-secret")).toBe(true);
    expect(
      await verifyLineSignature(
        new TextEncoder().encode('{"events":[1]}').buffer as ArrayBuffer,
        signature,
        "channel-secret",
      ),
    ).toBe(false);
  });

  it("rejects missing or malformed base64", async () => {
    expect(await verifyLineSignature(new ArrayBuffer(0), "", "secret")).toBe(false);
    expect(await verifyLineSignature(new ArrayBuffer(0), "%%%", "secret")).toBe(false);
  });
});
