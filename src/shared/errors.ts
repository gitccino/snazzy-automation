export class OperationalError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "OperationalError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof OperationalError && error.retryable;
}
