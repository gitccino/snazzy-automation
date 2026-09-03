import { OperationalError } from "../shared/errors";
import { safeFetch, type Fetcher } from "../shared/http";

export interface HostDiscoveryResult {
  host: string;
  attempts: number;
}

const DEFAULT_HOST = "p01-sharedstreams.icloud.com";

function webstreamUrl(host: string, token: string): string {
  return `https://${host}/${token}/sharedstreams/webstream`;
}

export async function discoverHost(token: string, fetcher: Fetcher): Promise<HostDiscoveryResult> {
  const redact = [new RegExp(token, "g")];

  let host = DEFAULT_HOST;
  let response: Response;
  try {
    response = await fetcher(webstreamUrl(host, token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamCtag: null }),
    });
  } catch {
    throw new OperationalError("ICLOUD_HOST_DISCOVERY_FAILED", "network error discovering iCloud host", true);
  }

  if (response.status === 330) {
    const redirectHost = response.headers.get("x-apple-mme-host");
    if (!redirectHost) {
      throw new OperationalError(
        "ICLOUD_HOST_DISCOVERY_FAILED",
        "iCloud redirected without naming a target host",
        false
      );
    }
    host = redirectHost;
    await safeFetch(
      webstreamUrl(host, token),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamCtag: null }),
      },
      { fetcher, redactUrlPatterns: redact }
    );
    return { host, attempts: 2 };
  }

  if (response.status >= 400) {
    // Re-run through safeFetch purely to get uniform, redacted error classification.
    await safeFetch(webstreamUrl(host, token), { method: "POST" }, { fetcher, redactUrlPatterns: redact });
  }

  return { host, attempts: 1 };
}
