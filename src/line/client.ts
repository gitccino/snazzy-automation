import { renderButtons } from './reply-renderer';
import type { LineReplyMessage, RejectionDisposition } from './reply-types';
import { z } from "zod";
import type { Fetcher } from "../env";
import { OperationalError } from "../shared/errors";

const LineProfileSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
});

export interface LineButton {
  label: string;
  data: string;
  style?: "primary" | "secondary";
}

export class LineReplyError extends OperationalError {
  constructor(public classification: 'definite_rejection' | 'unknown_outcome', public status: number | null, public disposition: RejectionDisposition = 'blocked_payload', public requestId: string | null = null) {
    super('line_reply_failed', `LINE reply ${classification} (status ${status ?? 'unknown'})`, false);
  }
}
export function validateReplyMessages(messages: LineReplyMessage[]): void {
  if (!messages.length || messages.length > 5) throw new OperationalError('line_invalid_reply_bundle', 'Reply needs 1–5 messages', false);
  for (const m of messages) {
    if (m.type === 'text' && typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 5000) continue;
    if ((m.type === 'flex' || m.type === 'template') && typeof m.altText === 'string' && m.altText.length > 0 && m.altText.length <= (m.type === 'flex' ? 1500 : 400) && typeof m[m.type === 'flex' ? 'contents' : 'template'] === 'object' && m[m.type === 'flex' ? 'contents' : 'template'] !== null) continue;
    throw new OperationalError('line_invalid_reply_bundle', 'Invalid reply message', false);
  }
}
export interface LineClient {
  sendReplyMessages(replyToken: string, messages: LineReplyMessage[]): Promise<{ requestId: string | null }>;
  pushMessage(toGroupId: string, text: string, contents?: Record<string, unknown>): Promise<void>;
  replyFlex(replyToken: string, altText: string, contents: Record<string, unknown>): Promise<void>;
  replyQuotedText(replyToken: string, text: string, quoteToken: string): Promise<void>;
  replyText(replyToken: string, text: string): Promise<void>;
  replyButtons(replyToken: string, altText: string, text: string, buttons: LineButton[]): Promise<void>;
  getGroupMemberProfile(groupId: string, userId: string): Promise<{ userId: string; displayName: string }>;
}

export function createLineClient(config: {
  channelAccessToken: string;
  fetch: Fetcher;
  pushReplies?: { groupId: string; retryKey: string };
}): LineClient {
  const headers = {
    Authorization: `Bearer ${config.channelAccessToken}`,
    "content-type": "application/json",
  };

  async function send(url: string, body: unknown, code: string): Promise<void> {
    if (config.pushReplies && url.endsWith("/reply")) {
      url = "https://api.line.me/v2/bot/message/push";
      body = { to: config.pushReplies.groupId, messages: (body as { messages: unknown }).messages };
    }
    const retryKey = config.pushReplies?.retryKey;
    const response = await config.fetch(url, {
      method: "POST",
      headers: retryKey ? { ...headers, "X-Line-Retry-Key": retryKey } : headers,
      body: JSON.stringify(body),
    });
    if (retryKey && response.status === 409 && response.headers.has("x-line-accepted-request-id")) return;
    if (!response.ok) {
      throw new OperationalError(
        code,
        `LINE API failed with status ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
  }

  async function sendReplyMessages(replyToken: string, messages: LineReplyMessage[]): Promise<{requestId:string|null}> {
    validateReplyMessages(messages);
    if (!replyToken.trim()) throw new OperationalError('line_invalid_reply_token', 'Missing reply token', false);
    let response: Response;
    try {
      response = await config.fetch('https://api.line.me/v2/bot/message/reply', { method:'POST', headers, body:JSON.stringify({replyToken,messages}) });
    } catch { throw new LineReplyError('unknown_outcome', null); }
    const requestId = response.headers.get('x-line-request-id');
    if (response.ok) return {requestId};
    if (response.status >= 500) throw new LineReplyError('unknown_outcome',response.status,'blocked_payload',requestId);
    let tokenError=false;
    try { const body = await response.json() as {message?:unknown}; tokenError=typeof body.message === 'string' && /reply token/i.test(body.message); } catch { /* status still proves rejection */ }
    throw new LineReplyError('definite_rejection',response.status,response.status===429 || tokenError ? 'retry_on_new_event' : [401,403].includes(response.status) ? 'blocked_configuration' : 'blocked_payload',requestId);
  }
  async function reply(replyToken:string, messages:LineReplyMessage[]):Promise<void> {
    if (config.pushReplies) return send('https://api.line.me/v2/bot/message/reply',{replyToken,messages},'line_reply_failed');
    await sendReplyMessages(replyToken,messages);
  }
  return {
    sendReplyMessages,
    pushMessage(toGroupId, text, contents) {
      return send(
        "https://api.line.me/v2/bot/message/push",
        { to: toGroupId, messages: [contents
          ? { type: "flex", altText: text.slice(0, 1500).replace(/[\uD800-\uDBFF]$/, ""), contents }
          : { type: "text", text }] },
        "line_push_failed",
      );
    },

    replyFlex(replyToken, altText, contents) { return reply(replyToken,[{type:'flex',altText:altText.slice(0,1500).replace(/[\uD800-\uDBFF]$/, ''),contents}]); },
    replyQuotedText(replyToken,text,quoteToken) { return reply(replyToken,[{type:'text',text,quoteToken}]); },
    replyText(replyToken,text) { return reply(replyToken,[{type:'text',text}]); },
    async replyButtons(replyToken,altText,text,buttons) { return reply(replyToken,renderButtons(altText,text,buttons)); },

    async getGroupMemberProfile(groupId, userId) {
      const response = await config.fetch(
        `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
        { headers },
      );
      if (!response.ok) {
        throw new OperationalError(
          "line_profile_failed",
          `LINE profile failed with status ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }

      let body: z.infer<typeof LineProfileSchema>;
      try {
        body = LineProfileSchema.parse(await response.json());
      } catch {
        throw new OperationalError(
          "line_invalid_profile_response",
          "LINE returned a malformed member profile",
          false,
        );
      }

      return { userId: body.userId, displayName: body.displayName };
    },
  };
}
