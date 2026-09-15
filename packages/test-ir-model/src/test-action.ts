/**
 * The public Test IR wire contract, version `test-ir.v1`.
 *
 * The Runner *consumes* this; it never generates it from natural language
 * (blueprint sections 3.7 and 7). Everything here must stay JSON-serializable
 * and free of Runner internals, because a future IR Generator service in any
 * language produces it from an OpenAPI/JSON Schema document alone.
 *
 * Compatibility rule: fields may be added, never repurposed or removed within
 * the v1 major version.
 */

export const TEST_IR_VERSION = 'test-ir.v1' as const;
export type TestIrVersion = typeof TEST_IR_VERSION;

export const TEST_ACTION_TYPES = [
  'goto',
  'click',
  'dblclick',
  'fill',
  'select',
  'check',
  'uncheck',
  'hover',
  'press',
  'assert',
  'wait',
] as const;

export type TestActionType = (typeof TEST_ACTION_TYPES)[number];

/**
 * How a step names its target.
 *
 * Note what is absent: a raw selector. Selectors live in the Registry
 * (blueprint section 3.2), so renaming an element or healing its selector
 * never invalidates previously generated IR.
 */
export interface ElementIntentV1 {
  /** Stable Registry ID. The strongest and preferred form of reference. */
  readonly elementId?: string;
  /** User-defined display name, e.g. "Create Customer Button". */
  readonly name?: string;
  /** Free-text meaning, used for semantic resolution when no ID exists. */
  readonly description?: string;
  /** ARIA role hint, e.g. "button". */
  readonly role?: string;
  /** Semantic type hint, e.g. "submit-button". */
  readonly semantic?: string;
  readonly componentId?: string;
  readonly pageId?: string;
}

export const PRECONDITION_TYPES = [
  'authenticated',
  'entityState',
  'uiState',
  'urlMatches',
  'elementVisible',
] as const;

export type PreconditionType = (typeof PRECONDITION_TYPES)[number];

/**
 * A requirement that must hold before a step can run (blueprint section 19).
 *
 * Preconditions are declared rather than inferred so a failure to *reach* a
 * state is reported as PRECONDITION_FAILED, never as a test failure.
 */
export interface PreconditionV1 {
  readonly type: PreconditionType;
  /** For `authenticated`: the execution profile reference, e.g. "MANAGER". */
  readonly profile?: string;
  /** For `entityState`: the domain entity, e.g. "ORDER". */
  readonly entity?: string;
  /** For `entityState` / `uiState`: the required state. */
  readonly state?: string;
  /** For `urlMatches`: a URL glob or pattern. */
  readonly urlPattern?: string;
  /** For `elementVisible`: the element that must already be on screen. */
  readonly target?: ElementIntentV1;
}

export const ASSERTION_TYPES = [
  'visible',
  'hidden',
  'text',
  'containsText',
  'value',
  'enabled',
  'disabled',
  'checked',
  'count',
  'urlMatches',
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

export interface AssertionV1 {
  readonly type: AssertionType;
  readonly expected?: string | number | boolean;
  readonly timeoutMs?: number;
}

export interface TestActionV1 {
  readonly id: string;
  readonly type: TestActionType;
  /** Human-readable label surfaced in the execution timeline. */
  readonly label?: string;
  readonly target?: ElementIntentV1;
  /** Input for `fill`/`select`/`press`, or the URL for `goto`. */
  readonly value?: string | number | boolean;
  /** Required when `type` is `assert`. */
  readonly assertion?: AssertionV1;
  readonly preconditions?: readonly PreconditionV1[];
  readonly timeoutMs?: number;
  /** Continue the run when this step fails; it is still reported as failed. */
  readonly continueOnFailure?: boolean;
}

export interface TestIrV1 {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly TestActionV1[];
  /** Opaque, caller-defined metadata echoed back in results. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export function isTestActionType(value: unknown): value is TestActionType {
  return typeof value === 'string' && (TEST_ACTION_TYPES as readonly string[]).includes(value);
}

/** True when the action type inherently needs a target element. */
export function actionRequiresTarget(type: TestActionType): boolean {
  return type !== 'goto' && type !== 'wait';
}

/** True when the action type inherently needs a value. */
export function actionRequiresValue(type: TestActionType): boolean {
  return type === 'goto' || type === 'fill' || type === 'select' || type === 'press';
}

/** Renders an intent for logs, evidence and error messages. */
export function describeIntent(intent: ElementIntentV1 | undefined): string {
  if (intent === undefined) return '<no target>';
  if (intent.elementId !== undefined) return `elementId=${intent.elementId}`;
  if (intent.name !== undefined) return `name="${intent.name}"`;
  if (intent.description !== undefined) return `description="${intent.description}"`;
  if (intent.semantic !== undefined) return `semantic=${intent.semantic}`;
  if (intent.role !== undefined) return `role=${intent.role}`;
  return '<empty intent>';
}
