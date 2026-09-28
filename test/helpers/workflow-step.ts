import { NonRetryableError } from "cloudflare:workflows";

export interface WorkflowStepCall {
  name: string;
  retryLimit: number;
  attempts: number;
}

export function retryingStep() {
  const calls: WorkflowStepCall[] = [];
  return {
    calls,
    async do<T>(
      name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const hasOptions = typeof optionsOrCallback !== "function";
      const callback = (
        hasOptions ? maybeCallback : optionsOrCallback
      ) as () => Promise<T>;
      const retryLimit = hasOptions
        ? (optionsOrCallback as { retries?: { limit: number } }).retries?.limit ?? 0
        : 0;
      let attempts = 0;

      for (;;) {
        attempts += 1;
        try {
          const result = await callback();
          calls.push({ name, retryLimit, attempts });
          return result;
        } catch (error) {
          if (attempts > retryLimit || error instanceof NonRetryableError) {
            calls.push({ name, retryLimit, attempts });
            throw error;
          }
        }
      }
    },
  };
}
