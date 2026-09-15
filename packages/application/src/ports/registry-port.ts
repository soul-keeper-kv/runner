import type { RegistryLookup } from '@runner/domain';
import type {
  ComponentRegistryItem,
  ElementRegistryItem,
  PageRegistryItem,
  RegistryModification,
  RegistryRevision,
} from '@runner/registry-model';
import type { Result } from '@runner/shared';

/**
 * Registry persistence, expressed as an application-level contract.
 *
 * Note the absence of an `update` method taking a whole element. Registry
 * changes go through a modification (blueprint section 35), which is what
 * makes every change auditable and reversible; allowing a blind overwrite here
 * would quietly defeat that.
 */

export interface RegistryMatch {
  readonly element: ElementRegistryItem;
  /** 0..1 similarity for name/description lookups; 1 for an exact ID hit. */
  readonly matchScore: number;
  readonly matchedOn: 'ID' | 'DISPLAY_NAME' | 'ALIAS' | 'SYSTEM_NAME' | 'DESCRIPTION';
}

export interface RegistryPort {
  findElementById(workspaceRef: string, elementId: string): Promise<Result<ElementRegistryItem>>;
  findElements(lookup: RegistryLookup): Promise<Result<RegistryMatch[]>>;
  listPages(workspaceRef: string): Promise<Result<PageRegistryItem[]>>;
  listComponents(workspaceRef: string, pageId?: string): Promise<Result<ComponentRegistryItem[]>>;

  /** Records an intended change. Returns it in DRAFT or PROPOSED status. */
  proposeModification(
    modification: Omit<RegistryModification, 'id' | 'createdAt' | 'status'> & {
      readonly status?: 'DRAFT' | 'PROPOSED';
    },
  ): Promise<Result<RegistryModification>>;

  getModification(modificationId: string): Promise<Result<RegistryModification>>;
  listPendingModifications(workspaceRef: string): Promise<Result<RegistryModification[]>>;

  /** Applies a modification and writes the resulting revision atomically. */
  confirmModification(
    modificationId: string,
    decidedBy: string,
  ): Promise<Result<RegistryRevision>>;

  rejectModification(
    modificationId: string,
    decidedBy: string,
    reason?: string,
  ): Promise<Result<RegistryModification>>;

  listRevisions(workspaceRef: string, entityId: string): Promise<Result<RegistryRevision[]>>;
}
