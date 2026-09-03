export type LogFields = Record<string, string | number | boolean | null>;

const SECRET_KEY_PATTERN = /token|secret|signedurl|signed_url|derivativeurl|password|authorization/i;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

function write(level: "info" | "warn" | "error", base: LogFields, message: string, fields: LogFields) {
  const line = JSON.stringify({
    level,
    message,
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
