import { kindOfErrorCode, type RunnerErrorCode, type RunnerErrorKind } from './error-codes.js';

/** JSON-safe payload attached to an error for debugging and evidence. */
export type ErrorDetails = Record<string, unknown>;

export interface RunnerErrorJson {
  readonly code: RunnerErrorCode;
  readonly kind: RunnerErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;
  readonly cause?: string;
}

export interface RunnerErrorOptions {
  readonly details?: ErrorDetails;
  /** Whether a caller may sensibly retry the same operation unchanged. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * The single error type crossing Runner boundaries.
 *
 * Blueprint rule: never throw generic strings across a boundary. Everything
 * that reaches the API, the timeline, or an event carries a stable code.
 */
export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly kind: RunnerErrorKind;
  readonly details: ErrorDetails | undefined;
  readonly retryable: boolean;

  constructor(code: RunnerErrorCode, message: string, options: RunnerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RunnerError';
    this.code = code;
    this.kind = kindOfErrorCode(code);
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  /**
   * Serializes for transport. The `cause` is reduced to a message so internal
   * stack traces never leak through the public API.
   */
  toJSON(): RunnerErrorJson {
    const json: Record<string, unknown> = {
      code: this.code,
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) json.details = this.details;
    if (this.cause !== undefined) json.cause = describeCause(this.cause);
    return json as unknown as RunnerErrorJson;
  }

  static is(value: unknown): value is RunnerError {
    return value instanceof RunnerError;
  }

  /** Normalizes any thrown value into a RunnerError. */
  static from(value: unknown, fallbackCode: RunnerErrorCode = 'INTERNAL_ERROR'): RunnerError {
    if (RunnerError.is(value)) return value;
    return new RunnerError(fallbackCode, describeCause(value), { cause: value });
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}
