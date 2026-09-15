import {
  DEFAULT_EXECUTION_OPTIONS,
  type ActionType,
  type Assertion,
  type ElementIntent,
  type ExecutionOptions,
  type ExecutionPlan,
  type Precondition,
  type TestAction,
} from '@runner/domain';
import {
  EXECUTION_CONTRACT_VERSION,
  TEST_IR_VERSION,
  actionRequiresTarget,
  actionRequiresValue,
  describeIntent,
  isTestActionType,
  type ExecutionRequestV1,
  type PreconditionV1,
  type TestActionV1,
} from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * The anti-corruption layer between the public wire contract and the internal
 * domain (blueprint sections 3.8 and 7.3).
 *
 * Everything unpleasant about accepting external input happens here — version
 * checks, missing-field defaults, normalization — so the pipeline downstream
 * can assume a well-formed ExecutionPlan and nothing else.
 *
 * This is the *only* place the two models are allowed to meet. A public DTO
 * appearing deeper inside the Runner is a bug.
 */

/** Contract versions this build accepts. */
export const SUPPORTED_CONTRACT_VERSIONS: readonly string[] = [EXECUTION_CONTRACT_VERSION];
export const SUPPORTED_IR_VERSIONS: readonly string[] = [TEST_IR_VERSION];

export interface MapExecutionRequestInput {
  readonly request: ExecutionRequestV1;
  readonly executionId: string;
}

export function mapExecutionRequest(input: MapExecutionRequestInput): Result<ExecutionPlan> {
  const { request, executionId } = input;

  const versionCheck = checkVersions(request);
  if (!versionCheck.ok) return versionCheck;

  if (request.workspaceRef === undefined || request.workspaceRef.trim().length === 0) {
    return err(RunnerErrors.validationFailed('workspaceRef is required.'));
  }
  if (request.test === undefined || request.test === null) {
    return err(RunnerErrors.validationFailed('test is required.'));
  }
  if (!Array.isArray(request.test.steps) || request.test.steps.length === 0) {
    return err(RunnerErrors.validationFailed('test.steps must contain at least one step.'));
  }

  const actions: TestAction[] = [];
  const seenStepIds = new Set<string>();

  for (const [index, step] of request.test.steps.entries()) {
    const mapped = mapAction(step, index);
    if (!mapped.ok) return mapped;

    if (seenStepIds.has(mapped.value.id)) {
      return err(
        RunnerErrors.validationFailed(`Duplicate step id "${mapped.value.id}".`, {
          stepIndex: index,
        }),
      );
    }
    seenStepIds.add(mapped.value.id);
    actions.push(mapped.value);
  }

  const plan: ExecutionPlan = {
    executionId,
    workspaceRef: request.workspaceRef,
    ...(request.tenantRef === undefined ? {} : { tenantRef: request.tenantRef }),
    ...(request.externalTestCaseRef === undefined
      ? {}
      : { externalTestCaseRef: request.externalTestCaseRef }),
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    ...(request.environmentRef === undefined ? {} : { environmentRef: request.environmentRef }),
    ...(request.authProfileRef === undefined ? {} : { authProfileRef: request.authProfileRef }),
    mode: request.mode ?? 'AUTO',
    testId: request.test.id,
    testName: request.test.name,
    actions,
    options: mapOptions(request),
    metadata: request.test.metadata ?? {},
  };

  return ok(plan);
}

function checkVersions(request: ExecutionRequestV1): Result<void> {
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(request.contractVersion)) {
    return err(
      RunnerErrors.contractVersionUnsupported(
        String(request.contractVersion),
        SUPPORTED_CONTRACT_VERSIONS,
      ),
    );
  }
  if (!SUPPORTED_IR_VERSIONS.includes(request.irVersion)) {
    return err(
      RunnerErrors.contractVersionUnsupported(String(request.irVersion), SUPPORTED_IR_VERSIONS),
    );
  }
  return ok(undefined);
}

export function mapAction(step: TestActionV1, index: number): Result<TestAction> {
  const where = { stepIndex: index, stepId: step?.id };

  if (step === null || typeof step !== 'object') {
    return err(RunnerErrors.validationFailed('Step must be an object.', where));
  }
  if (typeof step.id !== 'string' || step.id.trim().length === 0) {
    return err(RunnerErrors.validationFailed('Step id is required.', where));
  }
  if (!isTestActionType(step.type)) {
    return err(RunnerErrors.validationFailed(`Unknown action type "${String(step.type)}".`, where));
  }

  const type: ActionType = step.type;

  if (actionRequiresTarget(step.type) && step.target === undefined) {
    return err(RunnerErrors.validationFailed(`Action "${step.type}" requires a target.`, where));
  }
  if (actionRequiresValue(step.type) && step.value === undefined) {
    return err(RunnerErrors.validationFailed(`Action "${step.type}" requires a value.`, where));
  }
  if (step.type === 'assert' && step.assertion === undefined) {
    return err(RunnerErrors.validationFailed('Assert steps require an assertion.', where));
  }

  const target = step.target === undefined ? undefined : mapIntent(step.target);
  if (target !== undefined && isEmptyIntent(target)) {
    return err(
      RunnerErrors.validationFailed(
        'Target must carry at least one of elementId, name, description, semantic or role.',
        where,
      ),
    );
  }

  const preconditions: Precondition[] = [];
  for (const [preconditionIndex, raw] of (step.preconditions ?? []).entries()) {
    const mapped = mapPrecondition(raw);
    if (mapped === undefined) {
      return err(
        RunnerErrors.validationFailed(
          `Precondition at index ${preconditionIndex} is invalid.`,
          where,
        ),
      );
    }
    preconditions.push(mapped);
  }

  const action: TestAction = {
    id: step.id,
    type,
    label: step.label ?? defaultLabel(type, step),
    ...(target === undefined ? {} : { target }),
    ...(step.value === undefined ? {} : { value: step.value }),
    ...(step.assertion === undefined ? {} : { assertion: step.assertion as Assertion }),
    preconditions,
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    continueOnFailure: step.continueOnFailure ?? false,
  };

  return ok(action);
}

function mapIntent(intent: NonNullable<TestActionV1['target']>): ElementIntent {
  const mapped: Record<string, unknown> = {};
  if (intent.elementId !== undefined) mapped.elementId = intent.elementId.trim();
  // Names are normalized here so "  Login  " and "Login" resolve identically.
  if (intent.name !== undefined) mapped.name = intent.name.trim();
  if (intent.description !== undefined) mapped.description = intent.description.trim();
  if (intent.role !== undefined) mapped.role = intent.role.trim().toLowerCase();
  if (intent.semantic !== undefined) mapped.semantic = intent.semantic.trim();
  if (intent.componentId !== undefined) mapped.componentId = intent.componentId;
  if (intent.pageId !== undefined) mapped.pageId = intent.pageId;
  return mapped as ElementIntent;
}

function isEmptyIntent(intent: ElementIntent): boolean {
  return (
    isBlank(intent.elementId) &&
    isBlank(intent.name) &&
    isBlank(intent.description) &&
    isBlank(intent.semantic) &&
    isBlank(intent.role)
  );
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function mapPrecondition(precondition: PreconditionV1): Precondition | undefined {
  if (precondition === null || typeof precondition !== 'object') return undefined;
  if (typeof precondition.type !== 'string') return undefined;

  const mapped: Record<string, unknown> = { type: precondition.type };
  if (precondition.profile !== undefined) mapped.profile = precondition.profile;
  if (precondition.entity !== undefined) mapped.entity = precondition.entity;
  if (precondition.state !== undefined) mapped.state = precondition.state;
  if (precondition.urlPattern !== undefined) mapped.urlPattern = precondition.urlPattern;
  if (precondition.target !== undefined) mapped.target = mapIntent(precondition.target);
  return mapped as unknown as Precondition;
}

function mapOptions(request: ExecutionRequestV1): ExecutionOptions {
  const options = request.options ?? {};
  return {
    headless: options.headless ?? DEFAULT_EXECUTION_OPTIONS.headless,
    viewport: options.viewport ?? DEFAULT_EXECUTION_OPTIONS.viewport,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_EXECUTION_OPTIONS.defaultTimeoutMs,
    stopOnFailure: options.stopOnFailure ?? DEFAULT_EXECUTION_OPTIONS.stopOnFailure,
    enableRegistryLearning:
      options.enableRegistryLearning ?? DEFAULT_EXECUTION_OPTIONS.enableRegistryLearning,
    enableSelfHealing: options.enableSelfHealing ?? DEFAULT_EXECUTION_OPTIONS.enableSelfHealing,
  };
}

/** A readable timeline label when the caller did not supply one. */
function defaultLabel(type: ActionType, step: TestActionV1): string {
  switch (type) {
    case 'goto':
      return `Go to ${String(step.value ?? '')}`;
    case 'assert':
      return `Assert ${step.assertion?.type ?? 'state'} on ${describeIntent(step.target)}`;
    case 'wait':
      return `Wait ${String(step.value ?? '')}ms`;
    case 'fill':
      return `Fill ${describeIntent(step.target)}`;
    default:
      return `${type} ${describeIntent(step.target)}`;
  }
}
