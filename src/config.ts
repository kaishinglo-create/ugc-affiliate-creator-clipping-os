export interface AppConfig {
  databaseUrl: string;
  sessionSecret: string;
  appEnv: string;
  corsOrigin: string;
  port: number;
}

export type TrustProxySetting = boolean | 'loopback' | number;

/**
 * Proxy trust is opt-in and derived only from TRUST_PROXY. An unset or invalid
 * value is fail-closed (`false`); `true`/`1` is an explicit, deliberate choice
 * to trust every proxy hop and must never be a silent default.
 */
export function resolveTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'loopback') return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  return false;
}

export function loadConfig(): AppConfig {
  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  const isProduction = appEnv === 'production';
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const sessionSecret = process.env.SESSION_JWT_SECRET?.trim();

  // No static development fallback: a missing or short signing secret is a
  // configuration error in every environment, not just in production.
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_JWT_SECRET must be at least 32 chars');
  }
  if (isProduction && !databaseUrl) throw new Error('DATABASE_URL is required in production');

  return {
    databaseUrl: databaseUrl ?? '',
    sessionSecret,
    appEnv,
    corsOrigin: process.env.CORS_ORIGIN?.trim() || 'http://localhost:5173',
    port: Number(process.env.PORT ?? 3000),
  };
}
