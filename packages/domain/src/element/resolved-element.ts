import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';

/**
 * The output of element resolution (blueprint section 16).
 *
 * `evidence` is not decoration. A resolution that cannot explain itself is
 * unreviewable, and the REVIEW/WAITING_USER flow depends on a human being able
 * to see *why* the Runner chose this element in a couple of lines.
 */

export type ResolutionSource =
  | 'REGISTRY_ID'
  | 'REGISTRY_DISPLAY_NAME'
  | 'REGISTRY_ALIAS'
  | 'REGISTRY_DESCRIPTION'
  | 'REGISTRY_SYSTEM_NAME'
  | 'DOM_DISCOVERY'
  | 'CANDIDATE_SCORING'
  | 'SEMANTIC_AI'
  | 'USER_PICK'
  | 'HEALING';

export interface ResolutionEvidence {
  readonly source: ResolutionSource;
  /** One short sentence a reviewer can read, e.g. "role matched button". */
  readonly reason: string;
  readonly score?: number;
}

export interface ResolvedElement {
  /** Present when the resolution went through a Registry entry. */
  readonly elementId?: string;
  readonly displayName?: string;
  /** Identifies the element in the snapshot the resolution ran against. */
  readonly runtimeId: string;

  /** 0..1. Drives the AUTO / REVIEW / WAITING_USER decision. */
  readonly confidence: number;

  readonly locator: SelectorDefinition;
  readonly scopedLocator?: ScopedSelector;
  readonly alternatives: readonly SelectorDefinition[];

  readonly evidence: readonly ResolutionEvidence[];
  readonly resolvedVia: ResolutionSource;
  readonly matchCount: number;
}

/** A ranked resolution option, used when the Runner must ask a human. */
export interface ResolutionCandidate {
  readonly runtimeId: string;
  readonly elementId?: string;
  readonly label: string;
  readonly confidence: number;
  readonly selector: SelectorDefinition;
  readonly evidence: readonly ResolutionEvidence[];
}

export function summarizeEvidence(evidence: readonly ResolutionEvidence[]): string[] {
  return evidence.map((item) => item.reason);
}
