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

  it("replies with text through the reply endpoint", async () => {
    let capturedRequest: Request | null = null;
    const getCapturedRequest = () => capturedRequest;
    const client = createLineClient({
      channelAccessToken: "token",
      fetch: fakeFetch([{
        match: (request) => true,
        respond: (request) => {
          capturedRequest = request;
          return new Response("{}", { status: 200 });
        },
      }]),
    });

    await client.replyText("reply-1", "พบสินค้า A-1");

    expect(getCapturedRequest()?.url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(getCapturedRequest()?.method).toBe("POST");
    expect(getCapturedRequest()?.headers.get("authorization")).toBe("Bearer token");
    expect(getCapturedRequest()?.headers.get("content-type")).toBe("application/json");
    expect(await getCapturedRequest()?.json()).toEqual({
      replyToken: "reply-1",
      messages: [{ type: "text", text: "พบสินค้า A-1" }],
    });
  });

  it("replies with buttons through the reply endpoint", async () => {
    let capturedRequest: Request | null = null;
    const getCapturedRequest = () => capturedRequest;
    const client = createLineClient({
      channelAccessToken: "token",
      fetch: fakeFetch([{
        match: (request) => true,
        respond: (request) => {
          capturedRequest = request;
          return new Response("{}", { status: 200 });
        },
      }]),
    });

    await client.replyButtons("reply-1", "เลือกสินค้า", "เลือกสินค้า", [
      { label: "A-1", data: "item=A-1", style: "primary" },
    ]);

    expect(getCapturedRequest()?.url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(getCapturedRequest()?.method).toBe("POST");
    expect(getCapturedRequest()?.headers.get("authorization")).toBe("Bearer token");
    expect(getCapturedRequest()?.headers.get("content-type")).toBe("application/json");
    expect(await getCapturedRequest()?.json()).toEqual({
      replyToken: "reply-1",
      messages: [{
        type: "template",
        altText: "เลือกสินค้า",
        template: {
          type: "buttons",
          text: "เลือกสินค้า",
          actions: [{
            type: "postback",
            label: "A-1",
            data: "item=A-1",
            displayText: "A-1",
          }],
        },
      }],
    });
  });

  it("loads group member display name", async () => {
    let capturedRequest: Request | null = null;
    const getCapturedRequest = () => capturedRequest;
    const client = createLineClient({
      channelAccessToken: "token",
      fetch: fakeFetch([{
        match: (request) => true,
        respond: (request) => {
          capturedRequest = request;
          return new Response(JSON.stringify({
            userId: "U/1 ?",
            displayName: "Mint",
            pictureUrl: "https://example.com/p.jpg",
          }), { status: 200 });
        },
      }]),
    });

    await expect(client.getGroupMemberProfile("C 1/?", "U/1 ?")).resolves.toEqual({
      userId: "U/1 ?",
      displayName: "Mint",
    });
    expect(getCapturedRequest()?.url).toBe(
      "https://api.line.me/v2/bot/group/C%201%2F%3F/member/U%2F1%20%3F",
    );
    expect(getCapturedRequest()?.method).toBe("GET");
    expect(getCapturedRequest()?.headers.get("authorization")).toBe("Bearer token");
  });

  it("rejects a malformed group member profile", async () => {
    const client = createLineClient({
      channelAccessToken: "token",
      fetch: async () => new Response(JSON.stringify({ userId: "U1" }), { status: 200 }),
    });

    await expect(client.getGroupMemberProfile("C1", "U1")).rejects.toMatchObject({
      code: "line_invalid_profile_response",
      retryable: false,
    });
  });
});
