import { OperationalError } from "./errors";

export type Fetcher = typeof fetch;

export interface SafeFetchOptions {
  fetcher: Fetcher;
  redactUrlPatterns?: RegExp[];
}

function redactUrl(url: string, patterns: RegExp[] = []): string {
  let safe = url;
  for (const pattern of patterns) {
    safe = safe.replace(pattern, "[REDACTED]");
  }
  return safe;
}

export async function safeFetch(
  input: string,
  init: RequestInit | undefined,
  options: SafeFetchOptions
): Promise<Response> {
  const { fetcher, redactUrlPatterns = [] } = options;
  const response = await fetcher(input, init);

  if (response.status === 429) {
    throw new OperationalError(
      "HTTP_429",
      `rate limited fetching ${redactUrl(input, redactUrlPatterns)}`,
      true
    );
  }
  if (response.status >= 500) {
    throw new OperationalError(
      "HTTP_5XX",
      `server error ${response.status} fetching ${redactUrl(input, redactUrlPatterns)}`,
      true
    );
  }
  if (response.status >= 400) {
    throw new OperationalError(
      "HTTP_4XX",
      `client error ${response.status} fetching ${redactUrl(input, redactUrlPatterns)}`,
      false
    );
  }
  return response;
}
