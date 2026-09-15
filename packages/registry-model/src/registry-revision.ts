/**
 * Draft-then-commit editing for the Registry (blueprint sections 35 and 36).
 *
 * Nothing mutates the Registry directly. An edit — whether typed by a user in
 * the live workspace or proposed by the healing engine — first becomes a
 * modification with an explicit before/after pair. That single rule is what
 * makes undo, diff, approval workflows and auditable self-healing possible
 * later without redesigning the store.
 */

export const REGISTRY_MODIFICATION_TYPES = [
  'SELECTOR_UPDATE',
  'RENAME',
  'DESCRIPTION_UPDATE',
  'ALIAS_ADD',
  'ALIAS_REMOVE',
  'ELEMENT_CREATE',
  'ELEMENT_DELETE',
  'AVAILABILITY_UPDATE',
] as const;

export type RegistryModificationType = (typeof REGISTRY_MODIFICATION_TYPES)[number];

export const REGISTRY_MODIFICATION_STATUSES = [
  'DRAFT',
  'PROPOSED',
  'CONFIRMED',
  'REJECTED',
] as const;

export type RegistryModificationStatus = (typeof REGISTRY_MODIFICATION_STATUSES)[number];

export type RegistryEntityKind = 'ELEMENT' | 'PAGE' | 'COMPONENT';

/** Who or what originated a change; drives the confidence policy. */
export type RegistryChangeActor = 'USER' | 'AI' | 'HEALING' | 'RECORDER' | 'SYSTEM';

export interface RegistryModification {
  readonly id: string;
  readonly workspaceRef: string;
  readonly entityKind: RegistryEntityKind;
  /** Absent for ELEMENT_CREATE, where the entity does not exist yet. */
  readonly entityId?: string;

  readonly type: RegistryModificationType;
  readonly status: RegistryModificationStatus;

  /** Null for a creation; the prior value otherwise. */
  readonly before: unknown;
  readonly after: unknown;

  readonly proposedBy: RegistryChangeActor;
  readonly reason?: string;
  /** Live session in which the edit was drafted, when applicable. */
  readonly liveSessionId?: string;
  /** Execution that triggered the proposal, for healing-originated changes. */
  readonly executionId?: string;

  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

export interface RegistryRevision {
  readonly id: string;
  readonly workspaceRef: string;
  readonly entityKind: RegistryEntityKind;
  readonly entityId: string;
  /** Monotonic per entity. Referenced by timeline items for reproducibility. */
  readonly version: number;

  readonly changedBy: RegistryChangeActor;
  readonly changeType: RegistryModificationType;
  /** The modification this revision was committed from, when there was one. */
  readonly modificationId?: string;

  readonly before: unknown;
  readonly after: unknown;

  readonly timestamp: string;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<RegistryModificationStatus, readonly RegistryModificationStatus[]>
> = {
  DRAFT: ['PROPOSED', 'REJECTED'],
  PROPOSED: ['CONFIRMED', 'REJECTED', 'DRAFT'],
  CONFIRMED: [],
  REJECTED: [],
};

export function canTransition(
  from: RegistryModificationStatus,
  to: RegistryModificationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isDecided(status: RegistryModificationStatus): boolean {
  return status === 'CONFIRMED' || status === 'REJECTED';
}
