/**
 * Central redaction helper for log lines, API errors and audit payloads.
 *
 * This module never logs or stores the original value. It only transforms
 * text/structures before a caller writes them somewhere durable or visible.
 */

const REDACTED = '[REDACTED]';

const SENSITIVE_ASSIGNMENT =
  /\b(MECE_DASHBOARD_TOKEN|OPENCODE_SERVER_PASSWORD|SESSION_JWT_SECRET|DATABASE_URL|OLLAMA_API_KEY|BROWSER_RUNTIME_TOKEN|API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|AUTHORIZATION|COOKIE|UGC_SESSION|BEARER)\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Redacts secret-looking fragments from any value that must be displayed or logged. */
export function redactText(value: unknown): string {
  const original = typeof value === 'string' ? value : value == null ? '' : String(value);
  return original
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(BEARER, `Bearer ${REDACTED}`);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('apikey') ||
    normalized.includes('authorization') ||
    normalized.includes('cookie') ||
    normalized.includes('credential') ||
    normalized.includes('databaseurl')
  );
}

/**
 * Recursively redacts string values in structured data while preserving the
 * surrounding shape. Object keys that look like credentials are replaced
 * wholly; free-form strings (error messages, reasons) get text redaction.
 */
export function redactData<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value as object)) return '[CIRCULAR]' as T;
  if (depth > 8) return '[DEPTH_LIMIT]' as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactData(item, depth + 1, seen)) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) && typeof entry === 'string'
      ? REDACTED
      : redactData(entry, depth + 1, seen);
  }
  return result as T;
}

/** Redacts an Error into a log-safe object without relying on its raw stack. */
export function redactError(error: unknown): Record<string, unknown> {
  const err = error as { name?: string; message?: string; stack?: string; statusCode?: number; code?: string } | null;
  const result: Record<string, unknown> = {
    name: err?.name ?? 'Error',
    message: redactText(err?.message ?? error),
  };
  if (typeof err?.statusCode === 'number') result.statusCode = err.statusCode;
  if (typeof err?.code === 'string') result.code = err.code;
  if (typeof err?.stack === 'string') result.stack = redactText(err.stack);
  return result;
}
