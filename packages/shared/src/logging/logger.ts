/**
 * Structured logging contract (blueprint section 49).
 *
 * Every layer logs through this interface so the concrete transport (pino,
 * console, an OTel exporter) stays an infrastructure decision.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The correlation fields every Runner log line should carry when available. */
export interface LogContext {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly stepId?: string;
  readonly pageId?: string;
  readonly elementId?: string;
  readonly selectorStrategy?: string;
  readonly confidence?: number;
  readonly durationMs?: number;
  readonly result?: string;
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that merges `context` into every subsequent line. */
  child(context: LogContext): Logger;
}

/** Discards everything. Useful as a test default. */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * A dependency-free console logger emitting one JSON object per line.
 * Apps may replace it with pino without touching call sites.
 */
export function createConsoleLogger(minLevel: LogLevel = 'info', base: LogContext = {}): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message,
      ...base,
      ...context,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (context) => createConsoleLogger(minLevel, { ...base, ...context }),
  };
}
