import { describe, expect, it } from "vitest";
import { createLineClient } from "../../src/line/client";
import { fakeFetch } from "../helpers/fakes";
import { saleValuesText } from "../../src/line/messages";

describe("line client", () => {
  it("splits lengthy confirmation details without losing values or exceeding five messages", async () => {
    let payload: any;
    const client = createLineClient({ channelAccessToken: "token", fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({});
    } });
    const details = "x".repeat(4999) + "😀" + "y".repeat(5000);
    await client.replyButtons("reply", "confirm", details, [{ label: "OK", data: "token=tok" }]);
    const texts = payload.messages.filter((message: any) => message.type === "text");
    expect(texts.every((message: any) => message.text.length <= 5000 && !/[\uD800-\uDBFF]$/.test(message.text))).toBe(true);
    expect(texts.map((message: any) => message.text).join("")).toBe(details);
    expect(payload.messages.length).toBeLessThanOrEqual(5);
  });

  it("refuses over-capacity confirmation details before sending a truncated or invalid payload", async () => {
    let called = false;
    const client = createLineClient({ channelAccessToken: "token", fetch: async () => { called = true; return Response.json({}); } });
    await expect(client.replyButtons("reply", "confirm", "x".repeat(20001), [{ label: "OK", data: "token=tok" }]))
      .rejects.toMatchObject({ code: "line_confirmation_too_long", retryable: false });
    expect(called).toBe(false);
  });
  it("sends exact revert details plus a short template within LINE provider limits", async () => {
    const details = `ยืนยันย้อนกลับ A-1\nจาก\n${saleValuesText({ inventoryStatus: "Out", soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" })}\nเป็น\n${saleValuesText({ inventoryStatus: "In", soldPrice: null, soldAt: null, soldBy: null })}`;
    let payload: any;
    const client = createLineClient({ channelAccessToken: "token", fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      const valid = payload.messages.length <= 5 && payload.messages.every((message: any) =>
        message.type === "text" ? message.text.length <= 5000 : message.template.text.length <= 160 && message.altText.length <= 400);
      return new Response("{}", { status: valid ? 200 : 400 });
    } });
    expect(details.length).toBeGreaterThan(160);
    await client.replyButtons("reply-revert", details.repeat(3), details, [{ label: "ยืนยัน", data: "action=revert&decision=approve&token=tok" }]);
    expect(payload.messages[0]).toEqual({ type: "text", text: details });
    expect(payload.messages[1].template.actions[0].data).toBe("action=revert&decision=approve&token=tok");
  });
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

it("delivers delayed replies by push with a retry key and accepts an already-accepted request", async () => {
  let requestUrl: unknown;
  let requestInit: RequestInit | undefined;
  const client = createLineClient({
    channelAccessToken: "token",
    pushReplies: { groupId: "C1", retryKey: "11111111-1111-4111-8111-111111111111" },
    fetch: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "accepted" } });
    },
  });
  await client.replyText("expired-reply-token", "success");
  expect(requestUrl).toBe("https://api.line.me/v2/bot/message/push");
  expect(new Headers(requestInit?.headers).get("X-Line-Retry-Key")).toBe("11111111-1111-4111-8111-111111111111");
  expect(JSON.parse(String(requestInit?.body))).toEqual({ to: "C1", messages: [{ type: "text", text: "success" }] });
});
