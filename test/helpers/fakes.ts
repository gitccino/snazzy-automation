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
