import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';

/**
 * The Registry as a semantic knowledge base, not merely an object repository
 * (blueprint sections 3.3 and 17).
 *
 * Each element carries three separable things:
 *   - identity   — an immutable `id`, so renaming never breaks existing IR
 *   - meaning    — display name, description, aliases, semantic type
 *   - mechanics  — a ranked primary selector plus fallbacks and their history
 *
 * Keeping them separate is what allows a selector to heal without touching
 * meaning, and a name to change without touching mechanics.
 */

export type NameSource = 'USER' | 'AI' | 'UI_TEXT' | 'HISTORY' | 'RECORDER';

export interface ElementAlias {
  readonly value: string;
  readonly source: NameSource;
  readonly createdAt: string;
  /** Count of resolutions this alias contributed to; feeds confidence. */
  readonly usageCount?: number;
}

export interface ScoredSelectorEntry {
  readonly selector: SelectorDefinition;
  readonly score: number;
  readonly lastValidatedAt?: string;
  /** Consecutive successful resolutions using this selector. */
  readonly successCount?: number;
  readonly failureCount?: number;
}

export interface SelectorHistoryEntry {
  readonly selector: SelectorDefinition;
  readonly replacedAt: string;
  readonly replacedBy: 'USER' | 'AI' | 'HEALING' | 'RECORDER';
  readonly reason?: string;
}

export interface NamingHistoryEntry {
  readonly displayName: string;
  readonly source: NameSource;
  readonly changedAt: string;
}

/**
 * A condition under which the element is present (blueprint section 21).
 *
 * This is what separates "the selector broke" from "the element is not on
 * screen yet", which the Runner must never conflate.
 */
export interface AvailabilityCondition {
  readonly type: 'appState' | 'role' | 'entityState' | 'uiState' | 'urlPattern';
  readonly value: string;
}

export interface ElementRegistryItem {
  /** Immutable. Test IR references this and survives every rename. */
  readonly id: string;

  readonly workspaceRef: string;
  readonly applicationId?: string;
  readonly pageId?: string;
  readonly componentId?: string;

  /** Normalized identifier used when generating Page Object code. */
  readonly systemName: string;
  /** Human-facing name; a USER-sourced value outranks an AI-sourced one. */
  readonly displayName: string;
  readonly description?: string;
  readonly displayNameSource: NameSource;

  readonly aliases: readonly ElementAlias[];

  readonly semanticType?: string;
  readonly role?: string;
  readonly tags?: readonly string[];

  readonly primarySelector: SelectorDefinition;
  readonly scopedSelector?: ScopedSelector;
  readonly fallbackSelectors: readonly ScoredSelectorEntry[];

  readonly availableWhen?: readonly AvailabilityCondition[];

  /** A human has explicitly approved this mapping. Strong positive signal. */
  readonly userConfirmed: boolean;
  /** 0..1. Combines selector score, history and confirmation. */
  readonly confidence: number;

  readonly selectorHistory: readonly SelectorHistoryEntry[];
  readonly namingHistory: readonly NamingHistoryEntry[];

  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PageRegistryItem {
  readonly id: string;
  readonly workspaceRef: string;
  readonly applicationId?: string;
  readonly displayName: string;
  readonly description?: string;
  /** Glob patterns matched against the current URL to identify this page. */
  readonly urlPatterns: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ComponentRegistryItem {
  readonly id: string;
  readonly workspaceRef: string;
  readonly pageId?: string;
  readonly displayName: string;
  readonly description?: string;
  /** Selector scoping the component's subtree, enabling context-aware search. */
  readonly rootSelector?: SelectorDefinition;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Every name an element answers to, ordered by authority. */
export function allNamesOf(element: ElementRegistryItem): string[] {
  return [element.displayName, ...element.aliases.map((alias) => alias.value)];
}

/** True when a USER decision, not an AI guess, set the current name. */
export function hasUserAuthoredName(element: ElementRegistryItem): boolean {
  return element.displayNameSource === 'USER';
}
