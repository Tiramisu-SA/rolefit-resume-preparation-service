const SERVICE = 'resume-preparation';

type Level = 'info' | 'warn' | 'error';

/** Error properties are not enumerable, so JSON.stringify would write `{}`. */
function describeError(error: Error) {
  return { name: error.name, message: error.message, stack: error.stack };
}

function write(level: Level, message: string, details: unknown[]): void {
  if (process.env.NODE_ENV === 'test') return; // Keeps test output readable.

  const fields: Record<string, unknown> = {};
  const other: unknown[] = [];
  for (const detail of details) {
    if (detail instanceof Error) fields.error = describeError(detail);
    else if (detail && typeof detail === 'object' && !Array.isArray(detail)) Object.assign(fields, detail);
    else other.push(detail);
  }
  if (other.length) fields.detail = other;

  const { requestId, ...rest } = fields;
  const base = { time: new Date().toISOString(), level, service: SERVICE, requestId, message };
  let line: string;
  try {
    line = JSON.stringify({ ...base, ...rest });
  } catch {
    // A circular or BigInt detail must not turn logging into a second failure.
    line = JSON.stringify({ ...base, detail: 'details could not be serialized' });
  }
  console[level === 'info' ? 'log' : level](line);
}

/**
 * Small JSON logger: one object per line, the same format as the other RoleFit
 * services, so one request can be followed across their logs. Pass `requestId`
 * and any other fields as an object, or an Error to log its name, message and stack.
 */
export const logger = {
  info: (message: string, ...details: unknown[]) => write('info', message, details),
  warn: (message: string, ...details: unknown[]) => write('warn', message, details),
  error: (message: string, ...details: unknown[]) => write('error', message, details),
};
