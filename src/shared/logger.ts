export type LogFields = Record<string, string | number | boolean | null>;

const SECRET_KEY_PATTERN = /token|secret|signedurl|signed_url|derivativeurl|password|authorization/i;
const SECRET_TEXT_PATTERNS = [
  /sharedstreams\.icloud\.com\/[A-Za-z0-9_-]{10,}/gi,
  /X-Amz-Signature=[^&\s]+/gi,
  /[?&]sig=[^&\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /LINE_CHANNEL_ACCESS_TOKEN_VALUE_[A-Za-z0-9_-]+/g,
  /pat[A-Za-z0-9]{14,}\.[A-Za-z0-9]+/g,
];

export function redactText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce((output, pattern) => output.replace(pattern, "[REDACTED]"), value);
}

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : typeof value === "string"
        ? redactText(value)
        : value;
  }
  return out;
}

function write(level: "info" | "warn" | "error", base: LogFields, message: string, fields: LogFields) {
  const line = JSON.stringify({
    level,
    message: redactText(message),
    ...redact(base),
    ...redact(fields),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(base: LogFields) {
  return {
    info(message: string, fields: LogFields = {}) {
      write("info", base, message, fields);
    },
    warn(message: string, fields: LogFields = {}) {
      write("warn", base, message, fields);
    },
    error(message: string, fields: LogFields = {}) {
      write("error", base, message, fields);
    },
  };
}
