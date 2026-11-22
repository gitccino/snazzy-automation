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

export function workflowFailureMessage(code: string, reason: string): string {
  const safeCode = /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : 'workflow_stage_failed';
  return `workflow-failure-v1:${JSON.stringify({code:safeCode,reason})}`;
}

export function workflowFailureCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.replace(/^NonRetryableError: (?=workflow-failure-v1:)/, '') : '';
  if (!message.startsWith('workflow-failure-v1:')) return undefined;
  try {
    const fact: unknown = JSON.parse(message.slice('workflow-failure-v1:'.length));
    if (typeof fact === 'object' && fact !== null && Object.keys(fact).sort().join(',') === 'code,reason' &&
        typeof (fact as {code?:unknown}).code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test((fact as {code:string}).code) &&
        typeof (fact as {reason?:unknown}).reason === 'string') return (fact as {code:string}).code;
  } catch { /* Invalid envelopes have no trusted code. */ }
  return undefined;
}
