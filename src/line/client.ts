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

export interface LineClient {
  pushMessage(toGroupId: string, text: string, contents?: Record<string, unknown>): Promise<void>;
  replyFlex(replyToken: string, altText: string, contents: Record<string, unknown>): Promise<void>;
  replyText(replyToken: string, text: string): Promise<void>;
  replyButtons(replyToken: string, altText: string, text: string, buttons: LineButton[]): Promise<void>;
  getGroupMemberProfile(groupId: string, userId: string): Promise<{ userId: string; displayName: string }>;
}

export function createLineClient(config: {
  channelAccessToken: string;
  fetch: Fetcher;
}): LineClient {
  const headers = {
    Authorization: `Bearer ${config.channelAccessToken}`,
    "content-type": "application/json",
  };

  async function send(url: string, body: unknown, code: string): Promise<void> {
    const response = await config.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new OperationalError(
        code,
        `LINE API failed with status ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
  }

  return {
    pushMessage(toGroupId, text, contents) {
      return send(
        "https://api.line.me/v2/bot/message/push",
        { to: toGroupId, messages: [contents
          ? { type: "flex", altText: text.slice(0, 1500).replace(/[\uD800-\uDBFF]$/, ""), contents }
          : { type: "text", text }] },
        "line_push_failed",
      );
    },

    replyFlex(replyToken, altText, contents) {
      return send(
        "https://api.line.me/v2/bot/message/reply",
        { replyToken, messages: [{ type: "flex", altText: altText.slice(0, 1500).replace(/[\uD800-\uDBFF]$/, ""), contents }] },
        "line_reply_failed",
      );
    },

    replyText(replyToken, text) {
      return send(
        "https://api.line.me/v2/bot/message/reply",
        { replyToken, messages: [{ type: "text", text }] },
        "line_reply_failed",
      );
    },

    async replyButtons(replyToken, altText, text, buttons) {
      const longText = text.length > 160;
      const details: Array<{ type: "text"; text: string }> = [];
      if (longText) {
        for (let offset = 0; offset < text.length;) {
          const chunk = text.slice(offset, offset + 5000).replace(/[\uD800-\uDBFF]$/, "");
          if (details.length === 4 || chunk.length === 0) {
            throw new OperationalError("line_confirmation_too_long", "Confirmation exceeds LINE reply capacity", false);
          }
          details.push({ type: "text", text: chunk });
          offset += chunk.length;
        }
      }
      return send(
        "https://api.line.me/v2/bot/message/reply",
        {
          replyToken,
          messages: [...details, {
            type: "template",
            altText: altText.slice(0, 400).replace(/[\uD800-\uDBFF]$/, ""),
            template: {
              type: "buttons",
              text: longText ? "โปรดตรวจสอบรายละเอียดด้านบน แล้วเลือกยืนยันหรือยกเลิก" : text,
              actions: buttons.map((button) => ({
                type: "postback",
                label: button.label,
                data: button.data,
                displayText: button.label,
              })),
            },
          }],
        },
        "line_reply_failed",
      );
    },

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
