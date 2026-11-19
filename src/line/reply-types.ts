export type LineReplyMessage = { type: 'text' | 'flex' | 'template'; [key: string]: unknown };
export type TerminalResultV1 = {
  schemaVersion: 1;
  kind: 'import' | 'publication';
  runId: string;
  generation: number;
  notificationCycle: number;
  outcome: 'success' | 'partial' | 'validation_failed' | 'failed' | 'unconfirmed';
  messages: LineReplyMessage[];
};
export type RejectionDisposition = 'retry_on_new_event' | 'blocked_payload' | 'blocked_configuration';
