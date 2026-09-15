import type { ElementIntent } from '../execution/test-action.js';

/**
 * The resolution priority the Runner applies to an intent
 * (blueprint sections 7.2 and 16).
 *
 * Ordered strongest-first. A stable ID beats a name because a name can be
 * edited; a user-defined name beats an alias because it is the current
 * decision; everything registry-backed beats live DOM discovery because the
 * registry carries confirmation history that a fresh page does not.
 */
export const RESOLUTION_ORDER = [
  'REGISTRY_ID',
  'REGISTRY_DISPLAY_NAME',
  'REGISTRY_ALIAS',
  'REGISTRY_DESCRIPTION',
  'REGISTRY_SYSTEM_NAME',
  'DOM_DISCOVERY',
  'CANDIDATE_SCORING',
  'SEMANTIC_AI',
] as const;

export type ResolutionStrategy = (typeof RESOLUTION_ORDER)[number];

/** A registry query derived from an intent. */
export interface RegistryLookup {
  readonly workspaceRef: string;
  readonly elementId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly role?: string;
  readonly semanticType?: string;
  readonly pageId?: string;
  readonly componentId?: string;
  readonly limit?: number;
}

export function lookupFromIntent(workspaceRef: string, intent: ElementIntent): RegistryLookup {
  const lookup: Record<string, unknown> = { workspaceRef };
  if (intent.elementId !== undefined) lookup.elementId = intent.elementId;
  if (intent.name !== undefined) lookup.name = intent.name;
  if (intent.description !== undefined) lookup.description = intent.description;
  if (intent.role !== undefined) lookup.role = intent.role;
  if (intent.semantic !== undefined) lookup.semanticType = intent.semantic;
  if (intent.pageId !== undefined) lookup.pageId = intent.pageId;
  if (intent.componentId !== undefined) lookup.componentId = intent.componentId;
  return lookup as unknown as RegistryLookup;
}

/** The strategies worth attempting for a given intent, in priority order. */
export function applicableStrategies(intent: ElementIntent): ResolutionStrategy[] {
  const strategies: ResolutionStrategy[] = [];
  if (intent.elementId !== undefined) strategies.push('REGISTRY_ID');
  if (intent.name !== undefined) {
    strategies.push('REGISTRY_DISPLAY_NAME', 'REGISTRY_ALIAS', 'REGISTRY_SYSTEM_NAME');
  }
  if (intent.description !== undefined) strategies.push('REGISTRY_DESCRIPTION');
  strategies.push('DOM_DISCOVERY', 'CANDIDATE_SCORING');
  return strategies;
}
