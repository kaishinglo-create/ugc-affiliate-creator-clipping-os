export interface AppConfig {
  databaseUrl: string;
  sessionSecret: string;
  appEnv: string;
  corsOrigin: string;
  port: number;
}

const DEV_JWT_SECRET = 'dev-secret-that-is-at-least-thirty-two-characters-long!!';

export function loadConfig(): AppConfig {
  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  const isProduction = appEnv === 'production';
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const sessionSecret = process.env.SESSION_JWT_SECRET?.trim();
  if (isProduction) {
    if (!databaseUrl) throw new Error('DATABASE_URL is required in production');
    if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_JWT_SECRET must be at least 32 chars in production');
  }
  return {
    databaseUrl: databaseUrl ?? '',
    sessionSecret: sessionSecret || (isProduction ? '' : DEV_JWT_SECRET),
    appEnv,
    corsOrigin: process.env.CORS_ORIGIN?.trim() || 'http://localhost:5173',
    port: Number(process.env.PORT ?? 3000),
  };
}
