import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorization,
  completeOAuthCallback,
  createSelectionCompletion,
  fetchAndValidateSelection,
  pickerPage,
  validateOAuthCallback,
  validatePickerSelection,
} from "../../scripts/google-drive-oauth-setup";

const credentials = { clientId: "client-id", clientSecret: "secret-value", redirectUri: "http://127.0.0.1:8765/oauth/callback" };
const callback = "http://127.0.0.1:8765/oauth/callback?code=code-value&state=expected-state";
const tokenResponse = { access_token: "access-value", refresh_token: "refresh-value", token_type: "Bearer", expires_in: 3600 };

describe("local Google Drive OAuth setup", () => {
  it("matches its session cookie when unrelated cookies are also present", async () => {
    const setup = await import("../../scripts/google-drive-oauth-setup") as unknown as {
      hasSessionCookie?: (cookieHeader: string | undefined, expected: string) => boolean;
    };
    expect(setup.hasSessionCookie).toBeTypeOf("function");
    if (!setup.hasSessionCookie) return;
    expect(setup.hasSessionCookie("_ga=analytics; setup=session-value", "session-value")).toBe(true);
    expect(setup.hasSessionCookie("setup=other; _ga=analytics", "session-value")).toBe(false);
    expect(setup.hasSessionCookie(undefined, "session-value")).toBe(false);
  });

  it("sends only the setup page origin as its referrer for Picker key validation", () => {
    expect(pickerPage("123456789", "api-key-value")).toContain('<meta name="referrer" content="origin">');
  });

  it("builds an offline drive.file authorization with a random state and S256 PKCE", () => {
    const first = buildAuthorization(credentials.clientId, credentials.redirectUri);
    const second = buildAuthorization(credentials.clientId, credentials.redirectUri);
    const url = new URL(first.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe(first.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });

  it.each([
    ["missing code", "http://127.0.0.1:8765/oauth/callback?state=expected-state"],
    ["OAuth denial", "http://127.0.0.1:8765/oauth/callback?error=access_denied&state=expected-state"],
    ["state mismatch", "http://127.0.0.1:8765/oauth/callback?code=code-value&state=wrong"],
    ["duplicate code", "http://127.0.0.1:8765/oauth/callback?code=a&code=b&state=expected-state"],
  ])("rejects %s before token exchange", async (_name, url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(completeOAuthCallback(url, "expected-state", "verifier", credentials, "owner@example.com", fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates the callback code without returning query details in errors", () => {
    expect(validateOAuthCallback(callback, "expected-state")).toBe("code-value");
    expect(() => validateOAuthCallback(callback.replace("expected-state", "secret-state"), "expected-state")).toThrow("OAuth state mismatch");
  });

  it("exchanges a validated code and confirms the userinfo email", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code")).toBe("code-value");
        expect(body.get("code_verifier")).toBe("verifier");
        expect(body.get("client_secret")).toBe("secret-value");
        return Response.json(tokenResponse);
      }
      expect(String(input)).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-value");
      return Response.json({ email: "Owner@Example.com", email_verified: true });
    });
    await expect(completeOAuthCallback(callback, "expected-state", "verifier", credentials, "owner@example.com", fetcher)).resolves.toEqual({
      accessToken: "access-value", refreshToken: "refresh-value", email: "Owner@Example.com",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects the wrong or unverified Google account", async () => {
    for (const userinfo of [{ email: "other@example.com", email_verified: true }, { email: "owner@example.com", email_verified: false }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(tokenResponse)).mockResolvedValueOnce(Response.json(userinfo));
      await expect(completeOAuthCallback(callback, "expected-state", "verifier", credentials, "owner@example.com", fetcher)).rejects.toThrow("expected owner");
    }
  });

  it("sanitizes Google errors and malformed token responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("secret-value refresh-value", { status: 400 }));
    await expect(completeOAuthCallback(callback, "expected-state", "verifier", credentials, "owner@example.com", fetcher)).rejects.toThrow("Google token exchange failed (400)");
    const malformed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "access-value" }));
    await expect(completeOAuthCallback(callback, "expected-state", "verifier", credentials, "owner@example.com", malformed)).rejects.toThrow("Invalid Google token response");
  });

  it("accepts only a My Drive folder and its Google Doc", () => {
    expect(validatePickerSelection(
      { id: "folder-1", mimeType: "application/vnd.google-apps.folder" },
      { id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"] },
    )).toEqual({ folderId: "folder-1", templateId: "template-1" });
    const folder = { id: "folder-1", mimeType: "application/vnd.google-apps.folder" };
    const template = { id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"] };
    expect(() => validatePickerSelection({ ...folder, driveId: "shared-drive" }, template)).toThrow();
    expect(() => validatePickerSelection({ ...folder, mimeType: "text/plain" }, template)).toThrow();
    expect(() => validatePickerSelection(folder, { ...template, mimeType: "application/pdf" })).toThrow();
    expect(() => validatePickerSelection(folder, { ...template, parents: ["other-folder"] })).toThrow();
    expect(() => validatePickerSelection(folder, { ...template, parents: undefined })).toThrow();
    expect(() => validatePickerSelection(folder, { ...template, driveId: "shared-drive" })).toThrow();
  });

  it("checks both Picker IDs against Drive metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "folder-1", mimeType: "application/vnd.google-apps.folder" }))
      .mockResolvedValueOnce(Response.json({ id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"] }));
    await expect(fetchAndValidateSelection("folder-1", "template-1", "access-value", fetcher)).resolves.toEqual({ folderId: "folder-1", templateId: "template-1" });
    for (const call of fetcher.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer access-value");
      expect(new URL(String(call[0])).searchParams.get("fields")).toBe("id,mimeType,parents,driveId");
    }
  });

  it("rejects failed Drive lookups without displaying Google response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("secret-value access-value", { status: 403 }));
    await expect(fetchAndValidateSelection("folder-1", "template-1", "access-value", fetcher)).rejects.toThrow("Google Drive metadata request failed (403)");
  });

  it("rejects incomplete Drive metadata with a safe error", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("null", { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(Response.json({ id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"] }));
    await expect(fetchAndValidateSelection("folder-1", "template-1", "access-value", fetcher)).rejects.toThrow("Invalid Google Drive metadata");
  });

  it("emits the refresh token once when two valid selections finish together", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      await gate;
      return new URL(String(input)).pathname.endsWith("/folder-1")
        ? Response.json({ id: "folder-1", mimeType: "application/vnd.google-apps.folder" })
        : Response.json({ id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"] });
    });
    let output = "";
    const complete = createSelectionCompletion("access-value", fetcher, () => { output += "refresh-value\n"; });
    const first = complete("folder-1", "template-1");
    const second = complete("folder-1", "template-1");
    release();
    const results = await Promise.all([first, second]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(output).toBe("refresh-value\n");
  });

  it("renders a Picker page without embedding credentials or tokens", () => {
    const html = pickerPage("project-123", "picker-api-key");
    expect(html).toContain("google.picker.PickerBuilder");
    expect(html).toContain("setOAuthToken");
    expect(html).toContain("project-123");
    expect(html).toContain("picker-api-key");
    expect(html).not.toContain("secret-value");
    expect(html).not.toContain("access-value");
    expect(html).not.toContain("refresh-value");
  });
});
