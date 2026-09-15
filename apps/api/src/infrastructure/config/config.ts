import { RunnerErrors } from '@runner/shared';
import type { LogLevel } from '@runner/shared';

/**
 * Environment configuration, read once at startup.
 *
 * Parsing eagerly and failing loudly means a misconfigured deployment dies at
 * boot with a clear message, rather than surfacing as a confusing runtime error
 * on the first request that happens to need the missing value.
 */

export interface ApiConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly version: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** In-memory adapters let the API run with no Postgres or Redis present. */
  readonly usePersistence: boolean;
  /**
   * Key that seals stored credentials (blueprint section 50, relaxed).
   *
   * Empty means managed auth profiles are unavailable: the routes answer 501
   * rather than storing a password the Runner cannot protect. That refusal is
   * the point — a deployment that "forgot" the key must not quietly become one
   * that keeps credentials readable.
   */
  readonly secretKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as ApiConfig['nodeEnv'];
  const port = parsePort(env.RUNNER_API_PORT ?? '3001');
  const databaseUrl = env.DATABASE_URL ?? '';
  const redisUrl = env.REDIS_URL ?? '';

  // Production must never silently fall back to in-memory storage: a run that
  // vanishes on restart is worse than a refusal to start.
  if (nodeEnv === 'production' && (databaseUrl === '' || redisUrl === '')) {
    throw RunnerErrors.internal(
      'DATABASE_URL and REDIS_URL are required when NODE_ENV=production.',
    );
  }

  return {
    nodeEnv,
    port,
    logLevel: parseLogLevel(env.RUNNER_LOG_LEVEL ?? 'info'),
    version: env.RUNNER_VERSION ?? '0.1.0',
    databaseUrl,
    redisUrl,
    usePersistence: databaseUrl !== '' && redisUrl !== '',
    secretKey: env.RUNNER_SECRET_KEY ?? '',
  };
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw RunnerErrors.internal(`Invalid RUNNER_API_PORT: "${raw}".`);
  }
  return port;
}

function parseLogLevel(raw: string): LogLevel {
  const levels: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return levels.includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
}
