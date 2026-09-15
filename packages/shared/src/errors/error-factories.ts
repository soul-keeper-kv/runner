import { RunnerError, type ErrorDetails } from './runner-error.js';

/**
 * Named constructors for the errors raised most often across the pipeline.
 * They exist so call sites stay short and so the details payload for a given
 * code stays consistent wherever it is raised.
 */
export const RunnerErrors = {
  validationFailed(message: string, details?: ErrorDetails): RunnerError {
    return new RunnerError('VALIDATION_FAILED', message, { details });
  },

  contractVersionUnsupported(received: string, supported: readonly string[]): RunnerError {
    return new RunnerError(
      'CONTRACT_VERSION_UNSUPPORTED',
      `Unsupported contract version "${received}". Supported: ${supported.join(', ')}.`,
      { details: { received, supported } },
    );
  },

  elementNotFound(intentDescription: string, details?: ErrorDetails): RunnerError {
    return new RunnerError(
      'ELEMENT_NOT_FOUND',
      `No element matched intent: ${intentDescription}`,
      { details },
    );
  },

  elementAmbiguous(intentDescription: string, matchCount: number): RunnerError {
    return new RunnerError(
      'ELEMENT_AMBIGUOUS',
      `Intent "${intentDescription}" matched ${matchCount} elements; expected exactly one.`,
      { details: { intentDescription, matchCount } },
    );
  },

  selectorNotUnique(selectorDescription: string, matchCount: number): RunnerError {
    return new RunnerError(
      'SELECTOR_NOT_UNIQUE',
      `Selector ${selectorDescription} matched ${matchCount} elements.`,
      { details: { selectorDescription, matchCount } },
    );
  },

  selectorInvalid(selectorDescription: string, reason: string): RunnerError {
    return new RunnerError(
      'SELECTOR_INVALID',
      `Selector ${selectorDescription} is invalid: ${reason}`,
      { details: { selectorDescription, reason } },
    );
  },

  preconditionFailed(preconditionType: string, reason: string, details?: ErrorDetails): RunnerError {
    return new RunnerError(
      'PRECONDITION_FAILED',
      `Precondition "${preconditionType}" could not be satisfied: ${reason}`,
      { details: { preconditionType, reason, ...details } },
    );
  },

  actionFailed(actionType: string, reason: string, details?: ErrorDetails): RunnerError {
    return new RunnerError('ACTION_FAILED', `Action "${actionType}" failed: ${reason}`, {
      details: { actionType, reason, ...details },
      retryable: true,
    });
  },

  assertionFailed(message: string, details?: ErrorDetails): RunnerError {
    return new RunnerError('ASSERTION_FAILED', message, { details });
  },

  executionNotFound(executionId: string): RunnerError {
    return new RunnerError('EXECUTION_NOT_FOUND', `Execution "${executionId}" was not found.`, {
      details: { executionId },
    });
  },

  inspectionNotFound(inspectionId: string): RunnerError {
    return new RunnerError('INSPECTION_NOT_FOUND', `Inspection "${inspectionId}" was not found.`, {
      details: { inspectionId },
    });
  },

  pageNotReachable(url: string, reason: string): RunnerError {
    return new RunnerError('PAGE_NOT_REACHABLE', `Could not load ${url}: ${reason}`, {
      details: { url, reason },
      retryable: true,
    });
  },

  registryEntityNotFound(entity: string, id: string): RunnerError {
    return new RunnerError(
      'REGISTRY_ENTITY_NOT_FOUND',
      `Registry ${entity} "${id}" was not found.`,
      { details: { entity, id } },
    );
  },

  /**
   * A Registry write conflicts with the entity's current state — most often an
   * attempt to decide a modification that is already CONFIRMED or REJECTED.
   * Those states are terminal so history is never rewritten, and a caller
   * needs to know its view was stale rather than its request malformed.
   */
  registryConflict(message: string, details?: ErrorDetails): RunnerError {
    return new RunnerError('REGISTRY_CONFLICT', message, { details });
  },

  liveSessionLost(sessionId: string): RunnerError {
    return new RunnerError('LIVE_SESSION_LOST', `Live session "${sessionId}" is no longer alive.`, {
      details: { sessionId },
    });
  },

  liveCommandUnsupported(commandType: string): RunnerError {
    return new RunnerError(
      'LIVE_COMMAND_UNSUPPORTED',
      `No capability is registered for live command "${commandType}".`,
      { details: { commandType } },
    );
  },

  capabilityNotImplemented(what: string): RunnerError {
    return new RunnerError('CAPABILITY_NOT_IMPLEMENTED', `${what} is not implemented yet.`, {
      details: { what },
    });
  },

  browserCrashed(reason: string): RunnerError {
    return new RunnerError('BROWSER_CRASHED', `Browser crashed: ${reason}`, {
      details: { reason },
      retryable: true,
    });
  },

  internal(message: string, cause?: unknown): RunnerError {
    return new RunnerError('INTERNAL_ERROR', message, { cause });
  },
} as const;
