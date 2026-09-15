import type { RegistryMatch, RegistryPort } from '@runner/application';
import type { RegistryLookup } from '@runner/domain';
import {
  canTransition,
  matchElementByName,
  type ComponentRegistryItem,
  type ElementRegistryItem,
  type PageRegistryItem,
  type RegistryModification,
  type RegistryRevision,
} from '@runner/registry-model';
import {
  ID_PREFIXES,
  RunnerErrors,
  err,
  newId,
  ok,
  type Clock,
  type Logger,
  type Result,
} from '@runner/shared';

/**
 * An in-memory RegistryPort (Phase 4).
 *
 * Its purpose mirrors the other in-memory adapters: the Registry contract can be
 * exercised — resolution order, draft-then-commit, revision history — before
 * Postgres is running, and `pnpm dev` works with nothing but Node. Postgres
 * replaces it by swapping the binding in the composition root; no call site
 * changes, because every caller depends on `RegistryPort`.
 *
 * Two invariants are enforced here rather than left to callers, because they are
 * what make the Registry trustworthy:
 *
 *  - There is no blind `update()`. Every mutation goes through
 *    `proposeModification` then `confirmModification`, so each change has an
 *    explicit before/after and lands in the revision log.
 *  - `CONFIRMED` and `REJECTED` are terminal. History is appended, never
 *    rewritten.
 *
 * Not for production: state is per-process and disappears on restart.
 */
export class InMemoryRegistryStore implements RegistryPort {
  private readonly elements = new Map<string, ElementRegistryItem>();
  private readonly pages = new Map<string, PageRegistryItem>();
  private readonly components = new Map<string, ComponentRegistryItem>();
  private readonly modifications = new Map<string, RegistryModification>();
  /** Revisions per entity id, in commit order. */
  private readonly revisions = new Map<string, RegistryRevision[]>();

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  findElementById(
    workspaceRef: string,
    elementId: string,
  ): Promise<Result<ElementRegistryItem>> {
    const element = this.elements.get(elementId);

    // A workspace mismatch reads as "not found", never as "forbidden": telling a
    // caller an id exists in someone else's workspace leaks its existence.
    if (element === undefined || element.workspaceRef !== workspaceRef) {
      return Promise.resolve(err(RunnerErrors.registryEntityNotFound('element', elementId)));
    }
    return Promise.resolve(ok(element));
  }

  /**
   * Resolves a lookup in the blueprint's order: id, then display name, alias,
   * system name, and description last.
   *
   * An id lookup short-circuits — it is unambiguous, and continuing to score
   * names afterwards could only add weaker matches to an exact answer.
   */
  findElements(lookup: RegistryLookup): Promise<Result<RegistryMatch[]>> {
    if (lookup.elementId !== undefined) {
      const element = this.elements.get(lookup.elementId);
      if (element === undefined || element.workspaceRef !== lookup.workspaceRef) {
        return Promise.resolve(ok([]));
      }
      return Promise.resolve(ok([{ element, matchScore: 1, matchedOn: 'ID' }]));
    }

    const scoped = [...this.elements.values()].filter((element) =>
      this.inScope(element, lookup),
    );

    const query = lookup.name ?? lookup.description;
    if (query === undefined) {
      // No text to match on: return the scoped set unranked rather than
      // pretending to a score the caller could mistake for a name match.
      const matches = scoped.map(
        (element): RegistryMatch => ({ element, matchScore: 0, matchedOn: 'DISPLAY_NAME' }),
      );
      return Promise.resolve(ok(this.limited(matches, lookup)));
    }

    const matches: RegistryMatch[] = [];
    for (const element of scoped) {
      const match = matchElementByName(element, query);
      if (match === undefined) continue;
      matches.push({
        element,
        matchScore: Math.round(match.score * 1000) / 1000,
        matchedOn: match.kind,
      });
    }

    matches.sort((a, b) => b.matchScore - a.matchScore);
    return Promise.resolve(ok(this.limited(matches, lookup)));
  }

  listPages(workspaceRef: string): Promise<Result<PageRegistryItem[]>> {
    const pages = [...this.pages.values()].filter(
      (page) => page.workspaceRef === workspaceRef,
    );
    return Promise.resolve(ok(pages));
  }

  listComponents(
    workspaceRef: string,
    pageId?: string,
  ): Promise<Result<ComponentRegistryItem[]>> {
    const components = [...this.components.values()].filter(
      (component) =>
        component.workspaceRef === workspaceRef &&
        (pageId === undefined || component.pageId === pageId),
    );
    return Promise.resolve(ok(components));
  }

  // -------------------------------------------------------------------------
  // Draft-then-commit writes
  // -------------------------------------------------------------------------

  proposeModification(
    input: Omit<RegistryModification, 'id' | 'createdAt' | 'status'> & {
      readonly status?: 'DRAFT' | 'PROPOSED';
    },
  ): Promise<Result<RegistryModification>> {
    // A modification against a named entity must reference one that exists,
    // or confirming it later would silently create an element nobody drafted.
    if (input.type !== 'ELEMENT_CREATE') {
      if (input.entityId === undefined) {
        return Promise.resolve(
          err(
            RunnerErrors.validationFailed(
              `A ${input.type} modification requires an entityId.`,
              { type: input.type },
            ),
          ),
        );
      }
      const exists = this.entityExists(input.entityKind, input.entityId, input.workspaceRef);
      if (!exists) {
        return Promise.resolve(
          err(
            RunnerErrors.registryEntityNotFound(
              input.entityKind.toLowerCase(),
              input.entityId,
            ),
          ),
        );
      }
    }

    const modification: RegistryModification = {
      ...input,
      id: newId(ID_PREFIXES.modification),
      status: input.status ?? 'DRAFT',
      createdAt: this.clock.nowIso(),
    };

    this.modifications.set(modification.id, modification);
    this.logger.debug('Registry modification proposed', {
      modificationId: modification.id,
      type: modification.type,
      proposedBy: modification.proposedBy,
    });

    return Promise.resolve(ok(modification));
  }

  getModification(modificationId: string): Promise<Result<RegistryModification>> {
    const modification = this.modifications.get(modificationId);
    return Promise.resolve(
      modification === undefined
        ? err(RunnerErrors.registryEntityNotFound('modification', modificationId))
        : ok(modification),
    );
  }

  listPendingModifications(
    workspaceRef: string,
  ): Promise<Result<RegistryModification[]>> {
    const pending = [...this.modifications.values()].filter(
      (modification) =>
        modification.workspaceRef === workspaceRef &&
        (modification.status === 'DRAFT' || modification.status === 'PROPOSED'),
    );
    return Promise.resolve(ok(pending));
  }

  /**
   * Applies a modification and writes its revision as one unit.
   *
   * In Postgres this must be a single transaction: a committed change without
   * its revision is an unauditable one, which defeats the reason the Registry
   * is draft-then-commit at all.
   */
  confirmModification(
    modificationId: string,
    decidedBy: string,
  ): Promise<Result<RegistryRevision>> {
    const modification = this.modifications.get(modificationId);
    if (modification === undefined) {
      return Promise.resolve(
        err(RunnerErrors.registryEntityNotFound('modification', modificationId)),
      );
    }

    // The lifecycle is DRAFT -> PROPOSED -> CONFIRMED (ADR 0003), so a draft is
    // promoted here rather than refused: confirming is a single call from the
    // caller's point of view, and both hops are legal transitions. What must
    // never pass is a decided modification — CONFIRMED and REJECTED are
    // terminal, which is what keeps history append-only.
    const readyToConfirm = canTransition(modification.status, 'PROPOSED')
      ? { ...modification, status: 'PROPOSED' as const }
      : modification;

    if (!canTransition(readyToConfirm.status, 'CONFIRMED')) {
      return Promise.resolve(
        err(
          RunnerErrors.registryConflict(
            `Modification "${modificationId}" is ${modification.status} and cannot be confirmed.`,
            { modificationId, status: modification.status },
          ),
        ),
      );
    }

    const applied = this.apply(modification);
    if (!applied.ok) return Promise.resolve(applied);

    const entityId = applied.value.entityId;
    const history = this.revisions.get(entityId) ?? [];
    const revision: RegistryRevision = {
      id: newId(ID_PREFIXES.revision),
      workspaceRef: modification.workspaceRef,
      entityKind: modification.entityKind,
      entityId,
      version: history.length + 1,
      changedBy: modification.proposedBy,
      changeType: modification.type,
      modificationId: modification.id,
      before: modification.before,
      after: modification.after,
      timestamp: this.clock.nowIso(),
    };

    this.revisions.set(entityId, [...history, revision]);
    this.modifications.set(modificationId, {
      ...modification,
      status: 'CONFIRMED',
      decidedAt: this.clock.nowIso(),
      decidedBy,
    });

    this.logger.info('Registry modification confirmed', {
      modificationId,
      entityId,
      version: revision.version,
      changeType: modification.type,
    });

    return Promise.resolve(ok(revision));
  }

  rejectModification(
    modificationId: string,
    decidedBy: string,
    reason?: string,
  ): Promise<Result<RegistryModification>> {
    const modification = this.modifications.get(modificationId);
    if (modification === undefined) {
      return Promise.resolve(
        err(RunnerErrors.registryEntityNotFound('modification', modificationId)),
      );
    }

    if (!canTransition(modification.status, 'REJECTED')) {
      return Promise.resolve(
        err(
          RunnerErrors.registryConflict(
            `Modification "${modificationId}" is ${modification.status} and cannot be rejected.`,
            { modificationId, status: modification.status },
          ),
        ),
      );
    }

    const rejected: RegistryModification = {
      ...modification,
      status: 'REJECTED',
      decidedAt: this.clock.nowIso(),
      decidedBy,
      ...(reason === undefined ? {} : { reason }),
    };
    this.modifications.set(modificationId, rejected);
    return Promise.resolve(ok(rejected));
  }

  listRevisions(
    workspaceRef: string,
    entityId: string,
  ): Promise<Result<RegistryRevision[]>> {
    const history = (this.revisions.get(entityId) ?? []).filter(
      (revision) => revision.workspaceRef === workspaceRef,
    );
    return Promise.resolve(ok(history));
  }

  // -------------------------------------------------------------------------
  // Seeding — for tests and local development only
  // -------------------------------------------------------------------------

  /**
   * Inserts entities directly, bypassing draft-then-commit.
   *
   * Deliberately **not** part of `RegistryPort`: it exists so a test or a local
   * fixture can arrange state, and nothing in the application layer can reach
   * it. This is the "direct update path added just for imports" the blueprint
   * warns about, kept off the port so it cannot become one.
   */
  seed(entities: {
    readonly elements?: readonly ElementRegistryItem[];
    readonly pages?: readonly PageRegistryItem[];
    readonly components?: readonly ComponentRegistryItem[];
  }): void {
    for (const element of entities.elements ?? []) this.elements.set(element.id, element);
    for (const page of entities.pages ?? []) this.pages.set(page.id, page);
    for (const component of entities.components ?? []) {
      this.components.set(component.id, component);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Applies a confirmed modification, returning the entity it touched. */
  private apply(
    modification: RegistryModification,
  ): Result<{ entityId: string }> {
    if (modification.entityKind !== 'ELEMENT') {
      // Page and component edits arrive with Phase 10; refusing is better than
      // recording a revision for a change that was never applied.
      return err(
        RunnerErrors.capabilityNotImplemented(
          `Confirming a ${modification.entityKind} modification (Phase 10)`,
        ),
      );
    }

    if (modification.type === 'ELEMENT_CREATE') {
      const created = modification.after as ElementRegistryItem | undefined;
      if (created === undefined) {
        return err(
          RunnerErrors.validationFailed('An ELEMENT_CREATE modification needs an `after` value.'),
        );
      }
      const element: ElementRegistryItem = {
        ...created,
        revision: 1,
        createdAt: created.createdAt ?? this.clock.nowIso(),
        updatedAt: this.clock.nowIso(),
      };
      this.elements.set(element.id, element);
      return ok({ entityId: element.id });
    }

    const entityId = modification.entityId;
    if (entityId === undefined) {
      return err(RunnerErrors.validationFailed('The modification has no entityId.'));
    }

    const current = this.elements.get(entityId);
    if (current === undefined) {
      return err(RunnerErrors.registryEntityNotFound('element', entityId));
    }

    if (modification.type === 'ELEMENT_DELETE') {
      this.elements.delete(entityId);
      return ok({ entityId });
    }

    const patch = modification.after;
    if (patch === null || typeof patch !== 'object') {
      return err(
        RunnerErrors.validationFailed(
          `A ${modification.type} modification needs an object \`after\` value.`,
          { type: modification.type },
        ),
      );
    }

    // `id`, `workspaceRef` and `revision` are owned by the store: an id that
    // could be edited would break every Test IR referencing it.
    const {
      id: _id,
      workspaceRef: _workspaceRef,
      revision: _revision,
      createdAt: _createdAt,
      ...allowed
    } = patch as Partial<ElementRegistryItem>;

    this.elements.set(entityId, {
      ...current,
      ...allowed,
      revision: current.revision + 1,
      updatedAt: this.clock.nowIso(),
    });

    return ok({ entityId });
  }

  private entityExists(
    kind: RegistryModification['entityKind'],
    entityId: string,
    workspaceRef: string,
  ): boolean {
    const store =
      kind === 'ELEMENT' ? this.elements : kind === 'PAGE' ? this.pages : this.components;
    const entity = store.get(entityId);
    return entity !== undefined && entity.workspaceRef === workspaceRef;
  }

  private inScope(element: ElementRegistryItem, lookup: RegistryLookup): boolean {
    if (element.workspaceRef !== lookup.workspaceRef) return false;
    if (lookup.pageId !== undefined && element.pageId !== lookup.pageId) return false;
    if (lookup.componentId !== undefined && element.componentId !== lookup.componentId) {
      return false;
    }
    // A role or semantic hint narrows only when the element declares one, so a
    // registry entry that predates the hint is not silently excluded.
    if (
      lookup.role !== undefined &&
      element.role !== undefined &&
      element.role !== lookup.role
    ) {
      return false;
    }
    if (
      lookup.semanticType !== undefined &&
      element.semanticType !== undefined &&
      element.semanticType !== lookup.semanticType
    ) {
      return false;
    }
    return true;
  }

  private limited(matches: RegistryMatch[], lookup: RegistryLookup): RegistryMatch[] {
    return lookup.limit === undefined ? matches : matches.slice(0, lookup.limit);
  }
}
