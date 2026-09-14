import type { Fetcher } from "../env";
import { OperationalError } from "../shared/errors";

export interface LineClient {
  pushMessage(toGroupId: string, text: string): Promise<void>;
}

export function createLineClient(config: {
  channelAccessToken: string;
  fetch: Fetcher;
}): LineClient {
  return {
    async pushMessage(toGroupId, text) {
      const response = await config.fetch(
        "https://api.line.me/v2/bot/message/push",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.channelAccessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            to: toGroupId,
            messages: [{ type: "text", text }],
          }),
        },
      );

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new OperationalError(
          "line_push_failed",
          `LINE push failed with status ${response.status}`,
          retryable,
        );
      }
    },
  };
}
