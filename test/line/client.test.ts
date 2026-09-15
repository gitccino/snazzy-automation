import { describe, expect, it } from "vitest";
import { createLineClient } from "../../src/line/client";
import { fakeFetch } from "../helpers/fakes";

describe("line client", () => {
  it("pushMessage posts the group id and text to the LINE push endpoint with bearer auth", async () => {
    let capturedRequest: {
      url: string;
      method: string;
      headers: Headers;
      body: unknown;
    } | null = null;
    const getCapturedRequest = () => capturedRequest;
    const fetchFake = fakeFetch([
      {
        match: (req) => req.url === "https://api.line.me/v2/bot/message/push",
        respond: async (req) => {
          capturedRequest = {
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: await req.json(),
          };
          return new Response("{}", { status: 200 });
        },
      },
    ]);
    const client = createLineClient({
      channelAccessToken: "test-token",
      fetch: fetchFake,
    });

    await client.pushMessage("group-1", "นำเข้าสำเร็จ 3 รายการ");

    expect(getCapturedRequest()?.url).toBe(
      "https://api.line.me/v2/bot/message/push",
    );
    expect(getCapturedRequest()?.method).toBe("POST");
    expect(getCapturedRequest()?.headers.get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(getCapturedRequest()?.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(getCapturedRequest()?.body).toEqual({
      to: "group-1",
      messages: [{ type: "text", text: "นำเข้าสำเร็จ 3 รายการ" }],
    });
  });

  it("throws a retryable OperationalError when LINE returns a 5xx", async () => {
    const fetchFake = fakeFetch([
      { match: () => true, respond: () => new Response("{}", { status: 503 }) },
    ]);
    const client = createLineClient({
      channelAccessToken: "test-token",
      fetch: fetchFake,
    });

    await expect(client.pushMessage("group-1", "text")).rejects.toMatchObject({
      code: "line_push_failed",
      retryable: true,
    });
  });

  it("throws a retryable OperationalError when LINE returns 429", async () => {
    const fetchFake = fakeFetch([
      { match: () => true, respond: () => new Response("{}", { status: 429 }) },
    ]);
    const client = createLineClient({
      channelAccessToken: "test-token",
      fetch: fetchFake,
    });

    await expect(client.pushMessage("group-1", "text")).rejects.toMatchObject({
      code: "line_push_failed",
      retryable: true,
    });
  });

  it("throws a non-retryable OperationalError when LINE returns a 4xx", async () => {
    const fetchFake = fakeFetch([
      { match: () => true, respond: () => new Response("{}", { status: 400 }) },
    ]);
    const client = createLineClient({
      channelAccessToken: "test-token",
      fetch: fetchFake,
    });

    await expect(client.pushMessage("group-1", "text")).rejects.toMatchObject({
      code: "line_push_failed",
      retryable: false,
    });
  });
});
