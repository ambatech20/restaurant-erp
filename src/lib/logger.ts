type Level = 'info' | 'warn' | 'error';

function describe(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const digest = (error as { digest?: unknown }).digest;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(digest ? { digest: String(digest) } : {}),
  };
}

/** Single-line JSON log; readable in the server console and in Vercel runtime logs. */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  log('error', event, { ...fields, error: describe(error) });
}
