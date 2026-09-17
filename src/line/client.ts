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
  pushMessage(toGroupId: string, text: string): Promise<void>;
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
    pushMessage(toGroupId, text) {
      return send(
        "https://api.line.me/v2/bot/message/push",
        { to: toGroupId, messages: [{ type: "text", text }] },
        "line_push_failed",
      );
    },

    replyText(replyToken, text) {
      return send(
        "https://api.line.me/v2/bot/message/reply",
        { replyToken, messages: [{ type: "text", text }] },
        "line_reply_failed",
      );
    },

    replyButtons(replyToken, altText, text, buttons) {
      return send(
        "https://api.line.me/v2/bot/message/reply",
        {
          replyToken,
          messages: [{
            type: "template",
            altText,
            template: {
              type: "buttons",
              text,
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
