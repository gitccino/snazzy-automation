export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export function createScriptedFetcher(script: ScriptedResponse[]) {
  let call = 0;
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const next = script[Math.min(call, script.length - 1)]!;
    call += 1;
    return new Response(next.body ?? "{}", {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return { fetcher, calls };
}

import type { Clock, Fetcher, IdGenerator } from "../../src/env";

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

export function sequentialIdGenerator(prefix: string): IdGenerator {
  let next = 1;
  return { next: () => `${prefix}-${next++}` };
}

export function fakeFetch(
  handlers: Array<{
    match(request: Request): boolean;
    respond(request: Request): Response | Promise<Response>;
  }>,
): Fetcher {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const handler = handlers.find((candidate) => candidate.match(request));
    if (!handler) throw new Error(`No fake fetch handler for ${request.method} ${request.url}`);
    return handler.respond(request);
  }) as Fetcher;
}
