/**
 * The *internal* action model.
 *
 * Intentionally not `TestActionV1`. The public DTO is a wire format the Runner
 * must keep stable for external callers; this is the shape the pipeline finds
 * convenient. Keeping them separate (blueprint sections 3.8 and 7.3) means the
 * API can gain fields, or normalize sloppy input, without every browser-facing
 * module changing.
 *
 * The mapper in @runner/application is the only place the two meet.
 */

export type ActionType =
  | 'goto'
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'press'
  | 'assert'
  | 'wait';

export type AssertionType =
  | 'visible'
  | 'hidden'
  | 'text'
  | 'containsText'
  | 'value'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'count'
  | 'urlMatches';

/** How the Runner is asked to find a target (blueprint section 7.2). */
export interface ElementIntent {
  readonly elementId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly role?: string;
  readonly semantic?: string;
  readonly componentId?: string;
  readonly pageId?: string;
}

export type PreconditionType =
  | 'authenticated'
  | 'entityState'
  | 'uiState'
  | 'urlMatches'
  | 'elementVisible';

export interface Precondition {
  readonly type: PreconditionType;
  readonly profile?: string;
  readonly entity?: string;
  readonly state?: string;
  readonly urlPattern?: string;
  readonly target?: ElementIntent;
}

export interface Assertion {
  readonly type: AssertionType;
  readonly expected?: string | number | boolean;
  readonly timeoutMs?: number;
}

export interface TestAction {
  readonly id: string;
  readonly type: ActionType;
  readonly label: string;
  readonly target?: ElementIntent;
  readonly value?: string | number | boolean;
  readonly assertion?: Assertion;
  readonly preconditions: readonly Precondition[];
  readonly timeoutMs?: number;
  readonly continueOnFailure: boolean;
}

/**
 * A validated, ready-to-run plan.
 *
 * Produced by the inbound mapper; from here on the pipeline never sees the
 * original request shape.
 */
export interface ExecutionPlan {
  readonly executionId: string;
  readonly workspaceRef: string;
  readonly tenantRef?: string;
  readonly externalTestCaseRef?: string;
  readonly requestId?: string;
  readonly environmentRef?: string;
  readonly authProfileRef?: string;
  readonly mode: 'AUTO' | 'REVIEW' | 'INTERACTIVE';
  readonly testId: string;
  readonly testName: string;
  readonly actions: readonly TestAction[];
  readonly options: ExecutionOptions;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ExecutionOptions {
  readonly headless: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly baseUrl?: string;
  readonly defaultTimeoutMs: number;
  readonly stopOnFailure: boolean;
  readonly enableRegistryLearning: boolean;
  readonly enableSelfHealing: boolean;
}

export const DEFAULT_EXECUTION_OPTIONS: ExecutionOptions = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  defaultTimeoutMs: 15_000,
  stopOnFailure: true,
  enableRegistryLearning: true,
  enableSelfHealing: false,
};

export function actionNeedsTarget(type: ActionType): boolean {
  return type !== 'goto' && type !== 'wait';
}

export function describeAction(action: TestAction): string {
  return action.label.length > 0 ? action.label : `${action.type} ${action.id}`;
}
