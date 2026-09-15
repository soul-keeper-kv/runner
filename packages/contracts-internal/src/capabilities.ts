import { LIVE_COMMAND_TYPES } from '@runner/live-protocol';
import {
  EXECUTION_CONTRACT_VERSION,
  INSPECTION_CONTRACT_VERSION,
  TEST_ACTION_TYPES,
  TEST_IR_VERSION,
} from '@runner/test-ir-model';

/**
 * The Runner's self-description, served at GET /api/v1/capabilities
 * (blueprint section 3.9).
 *
 * This endpoint is what lets an external IR Generator discover what this
 * deployment actually supports — which contract versions, which action types,
 * whether self-healing or AI resolution is switched on — instead of hardcoding
 * assumptions and failing at execution time. It is also how a caller learns
 * that a capability is *planned but not yet implemented*, which during phased
 * rollout is the common case.
 */

export type CapabilityStatus = 'AVAILABLE' | 'PLANNED' | 'DISABLED';

export interface CapabilityDescriptor {
  readonly name: string;
  readonly status: CapabilityStatus;
  readonly description: string;
}

export interface RunnerCapabilities {
  readonly runner: {
    readonly name: string;
    readonly version: string;
  };
  readonly contracts: {
    readonly execution: readonly string[];
    readonly testIr: readonly string[];
    readonly inspection: readonly string[];
  };
  readonly actionTypes: readonly string[];
  readonly assertionTypes: readonly string[];
  readonly selectorStrategies: readonly string[];
  readonly executionModes: readonly string[];
  readonly liveCommands: readonly string[];
  readonly features: readonly CapabilityDescriptor[];
  readonly integrationStyles: readonly string[];
}

export interface BuildCapabilitiesInput {
  readonly version: string;
  /**
   * Features whose availability depends on deployment configuration.
   *
   * Every one of these defaults to `false`. An omitted flag must under-promise
   * rather than over-promise: a caller told a feature is missing when it is
   * present merely misses an optimization, while a caller told a feature is
   * present when it answers 501 breaks in production.
   */
  readonly semanticResolverAvailable?: boolean;
  readonly selfHealingAvailable?: boolean;
  readonly liveSessionsAvailable?: boolean;
  readonly registryAvailable?: boolean;
  readonly recorderAvailable?: boolean;
}

export function buildCapabilities(input: BuildCapabilitiesInput): RunnerCapabilities {
  const {
    version,
    semanticResolverAvailable = false,
    selfHealingAvailable = false,
    liveSessionsAvailable = false,
    registryAvailable = false,
    recorderAvailable = false,
  } = input;

  return {
    runner: { name: 'runner-service', version },
    contracts: {
      execution: [EXECUTION_CONTRACT_VERSION],
      testIr: [TEST_IR_VERSION],
      inspection: [INSPECTION_CONTRACT_VERSION],
    },
    actionTypes: TEST_ACTION_TYPES,
    assertionTypes: [
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
    ],
    selectorStrategies: [
      'testId',
      'role',
      'label',
      'placeholder',
      'altText',
      'title',
      'text',
      'css',
      'xpath',
    ],
    executionModes: ['AUTO', 'REVIEW', 'INTERACTIVE'],
    liveCommands: LIVE_COMMAND_TYPES,
    integrationStyles: ['polling', 'webhook', 'websocket'],
    features: [
      {
        name: 'execution.queue',
        status: 'AVAILABLE',
        description: 'Submit a Test IR execution and poll or subscribe for its result.',
      },
      {
        name: 'contract.validation',
        status: 'AVAILABLE',
        description: 'Validate an execution request or Test IR document before scheduling a run.',
      },
      {
        name: 'browser.playwright',
        status: 'AVAILABLE',
        description: 'Execute actions in a Chromium browser through the Playwright adapter.',
      },
      {
        name: 'inspector.page-snapshot',
        status: 'AVAILABLE',
        description: 'Derive a structured page snapshot of interactable element candidates.',
      },
      {
        name: 'inspector.page-fields',
        status: 'AVAILABLE',
        description:
          'Submit a URL and receive the page input fields and submit control, each with a ranked selector. Requires no Test IR.',
      },
      {
        name: 'locator.deterministic-resolution',
        status: 'AVAILABLE',
        description: 'Generate, score and validate locator candidates without any AI involvement.',
      },
      {
        name: 'registry.elements',
        status: registryAvailable ? 'AVAILABLE' : 'DISABLED',
        description: 'Resolve targets through a semantic Element/Page/Component Registry.',
      },
      {
        name: 'live.sessions',
        status: liveSessionsAvailable ? 'AVAILABLE' : 'DISABLED',
        description: 'Hold a browser open for live preview, element picking and selector editing.',
      },
      {
        name: 'registry.self-healing',
        status: selfHealingAvailable ? 'AVAILABLE' : 'PLANNED',
        description: 'Propose a replacement selector when a stored one stops matching.',
      },
      {
        name: 'resolver.semantic-ai',
        status: semanticResolverAvailable ? 'AVAILABLE' : 'PLANNED',
        description: 'Rerank a shortlist of candidates with a language model.',
      },
      {
        name: 'recorder.interactive',
        status: recorderAvailable ? 'AVAILABLE' : 'PLANNED',
        description: 'Record user interactions and normalize them into Test IR.',
      },
      {
        name: 'codegen.playwright-pom',
        status: 'PLANNED',
        description: 'Generate Playwright Page Objects and specs from Registry and Test IR.',
      },
    ],
  };
}
