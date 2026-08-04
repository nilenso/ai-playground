export type LogDetails = Record<string, unknown>;

function write(
  level: "debug" | "info" | "warn" | "error",
  scope: string,
  message: string,
  details?: LogDetails,
): void {
  const prefix = `${
    new Date().toISOString()
  } [editing-in-progress:${scope}] ${message}`;
  if (details && Object.keys(details).length > 0) {
    console[level](prefix, details);
  } else {
    console[level](prefix);
  }
}

export function errorDetails(error: unknown): LogDetails {
  if (error instanceof Error) {
    return {
      error: error.message,
      errorType: error.name,
      ...(error.cause === undefined ? {} : { cause: String(error.cause) }),
    };
  }
  return { error: String(error) };
}

export const log = {
  debug: (scope: string, message: string, details?: LogDetails) =>
    write("debug", scope, message, details),
  info: (scope: string, message: string, details?: LogDetails) =>
    write("info", scope, message, details),
  warn: (scope: string, message: string, details?: LogDetails) =>
    write("warn", scope, message, details),
  error: (scope: string, message: string, details?: LogDetails) =>
    write("error", scope, message, details),
};
