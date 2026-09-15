/**
 * Application state modelling (blueprint sections 19-21).
 *
 * The distinction this file exists to preserve:
 *
 *   selector healing  — the element exists, its selector changed
 *   state resolution  — the element does not exist yet, because the app is not
 *                       in the state that produces it
 *
 * Conflating the two produces a Runner that "heals" its way to the wrong
 * element. Everything below keeps them apart.
 */

export interface ApplicationStateNode {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

export interface ApplicationStateTransition {
  readonly from: string;
  readonly to: string;
  /** How the transition is performed: a named pre-step, an API call, a fixture. */
  readonly via: 'UI_STEPS' | 'API' | 'FIXTURE' | 'DB_SEED';
  readonly description?: string;
}

/**
 * The long-term application graph. Present in the model from day one, unused
 * by the MVP planner on purpose: explicit pre-steps come first, graph planning
 * comes later (section 21).
 */
export interface ApplicationStateGraph {
  readonly workspaceRef: string;
  readonly nodes: readonly ApplicationStateNode[];
  readonly transitions: readonly ApplicationStateTransition[];
}

export type PreconditionOutcome =
  | { readonly kind: 'ALREADY_SATISFIED' }
  | { readonly kind: 'PREPARED'; readonly actionsTaken: readonly string[] }
  | { readonly kind: 'UNSATISFIABLE'; readonly reason: string };

/**
 * How a state is reached (blueprint section 20).
 *
 * Ordered by preference: API and fixtures are faster and less brittle than
 * clicking through the UI, and the UI path should only be used when that path
 * is itself what the test is about.
 */
export const SETUP_METHOD_PRIORITY = ['API', 'FIXTURE', 'DB_SEED', 'UI_STEPS'] as const;
export type SetupMethod = (typeof SETUP_METHOD_PRIORITY)[number];

export function preferredSetupMethod(available: readonly SetupMethod[]): SetupMethod | undefined {
  return SETUP_METHOD_PRIORITY.find((method) => available.includes(method));
}
