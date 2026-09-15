/**
 * The Runner's structured error vocabulary (blueprint section 48).
 *
 * These codes cross the public API boundary, so they are part of the contract:
 * add new codes freely, but never repurpose or rename an existing one.
 */
export const RUNNER_ERROR_CODES = [
  // --- authentication / session ---
  'AUTH_FAILED',
  'AUTH_SESSION_EXPIRED',

  // --- state preparation ---
  'PRECONDITION_FAILED',
  'PAGE_NOT_REACHABLE',

  // --- element resolution ---
  'ELEMENT_NOT_FOUND',
  'ELEMENT_AMBIGUOUS',
  'SELECTOR_INVALID',
  'SELECTOR_NOT_UNIQUE',

  // --- execution ---
  'ACTION_FAILED',
  'ASSERTION_FAILED',

  // --- registry ---
  'REGISTRY_CONFLICT',
  'REGISTRY_ENTITY_NOT_FOUND',

  // --- live session ---
  'LIVE_SESSION_LOST',
  'LIVE_COMMAND_UNSUPPORTED',
  'BROWSER_CRASHED',

  // --- contract / transport ---
  'CONTRACT_VERSION_UNSUPPORTED',
  'VALIDATION_FAILED',
  'EXECUTION_NOT_FOUND',
  'EXECUTION_CANCELLED',
  'INSPECTION_NOT_FOUND',
  'CAPABILITY_NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

/**
 * Distinguishes a failed *test* from a failed *setup*, so reporting does not
 * blame the application under test for infrastructure problems
 * (blueprint section 20: PRECONDITION_FAILED != TEST_FAILED).
 */
export type RunnerErrorKind =
  | 'TEST_FAILURE'
  | 'PRECONDITION_FAILURE'
  | 'RESOLUTION_FAILURE'
  | 'INFRASTRUCTURE_FAILURE'
  | 'CONTRACT_FAILURE';

const ERROR_KIND_BY_CODE: Readonly<Record<RunnerErrorCode, RunnerErrorKind>> = {
  AUTH_FAILED: 'PRECONDITION_FAILURE',
  AUTH_SESSION_EXPIRED: 'PRECONDITION_FAILURE',
  PRECONDITION_FAILED: 'PRECONDITION_FAILURE',
  PAGE_NOT_REACHABLE: 'PRECONDITION_FAILURE',

  ELEMENT_NOT_FOUND: 'RESOLUTION_FAILURE',
  ELEMENT_AMBIGUOUS: 'RESOLUTION_FAILURE',
  SELECTOR_INVALID: 'RESOLUTION_FAILURE',
  SELECTOR_NOT_UNIQUE: 'RESOLUTION_FAILURE',

  ACTION_FAILED: 'TEST_FAILURE',
  ASSERTION_FAILED: 'TEST_FAILURE',

  REGISTRY_CONFLICT: 'INFRASTRUCTURE_FAILURE',
  REGISTRY_ENTITY_NOT_FOUND: 'INFRASTRUCTURE_FAILURE',

  LIVE_SESSION_LOST: 'INFRASTRUCTURE_FAILURE',
  LIVE_COMMAND_UNSUPPORTED: 'CONTRACT_FAILURE',
  BROWSER_CRASHED: 'INFRASTRUCTURE_FAILURE',

  CONTRACT_VERSION_UNSUPPORTED: 'CONTRACT_FAILURE',
  VALIDATION_FAILED: 'CONTRACT_FAILURE',
  EXECUTION_NOT_FOUND: 'CONTRACT_FAILURE',
  EXECUTION_CANCELLED: 'INFRASTRUCTURE_FAILURE',
  INSPECTION_NOT_FOUND: 'CONTRACT_FAILURE',
  CAPABILITY_NOT_IMPLEMENTED: 'CONTRACT_FAILURE',
  INTERNAL_ERROR: 'INFRASTRUCTURE_FAILURE',
};

export function kindOfErrorCode(code: RunnerErrorCode): RunnerErrorKind {
  return ERROR_KIND_BY_CODE[code];
}

export function isRunnerErrorCode(value: unknown): value is RunnerErrorCode {
  return typeof value === 'string' && (RUNNER_ERROR_CODES as readonly string[]).includes(value);
}
