import { type Redis } from 'ioredis';
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
 * A Redis-backed RegistryPort shared by the API and the worker.
 *
 * This adapter exists because the Registry has two readers in different
 * processes. The worker resolves targets and proposes drafts from a live pick;
 * the API answers `/api/v1/registry/*` and shows what is pending. With a
 * per-process in-memory store, a draft created by picking an element would be
 * invisible to the endpoint a reviewer is looking at — the same trap the
 * execution and session stores document, and a quiet one, because both halves
 * appear to work in isolation.
 *
 * Every invariant from the in-memory adapter is preserved, because they are what
 * make the Registry trustworthy rather than merely persistent:
 *
 *  - No blind update. Changes go through `proposeModification` then
 *    `confirmModification`, so each carries an explicit before/after.
 *  - `CONFIRMED` and `REJECTED` are terminal; history is appended, never
 *    rewritten.
 *  - A workspace mismatch reads as "not found", never "forbidden".
 *  - `id`, `workspaceRef` and `revision` are owned by the store.
 *
 * Postgres replaces this for reporting and retention (blueprint section 51).
 * Redis is used here because it is already required for the queue, and because
 * it satisfies the same port — the swap touches only the composition root.
 */

const ELEMENT_KEY = 'runner:registry:element:';
const PAGE_KEY = 'runner:registry:page:';
const COMPONENT_KEY = 'runner:registry:component:';
const MODIFICATION_KEY = 'runner:registry:modification:';
/** Per-entity revision list, in commit order. */
const REVISION_KEY = 'runner:registry:revisions:';

/** Workspace indexes, so a listing does not need SCAN. */
const ELEMENT_INDEX = 'runner:registry:elements:';
const PAGE_INDEX = 'runner:registry:pages:';
const COMPONENT_INDEX = 'runner:registry:components:';
const PENDING_INDEX = 'runner:registry:pending:';

export class RedisRegistryStore implements RegistryPort {
  constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findElementById(
    workspaceRef: string,
    elementId: string,
  ): Promise<Result<ElementRegistryItem>> {
    try {
      const element = await this.readElement(elementId);

      // Telling a caller an id exists in someone else's workspace leaks its
      // existence, so a mismatch is indistinguishable from absence.
      if (element === undefined || element.workspaceRef !== workspaceRef) {
        return err(RunnerErrors.registryEntityNotFound('element', elementId));
      }
      return ok(element);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the registry element.', cause));
    }
  }

  /**
   * Resolves a lookup in the blueprint's order: id, then display name, alias,
   * system name, and description last.
   *
   * An id lookup short-circuits — it is unambiguous, and scoring names afterwards
   * could only add weaker matches to an exact answer.
   */
  async findElements(lookup: RegistryLookup): Promise<Result<RegistryMatch[]>> {
    try {
      if (lookup.elementId !== undefined) {
        const element = await this.readElement(lookup.elementId);
        if (element === undefined || element.workspaceRef !== lookup.workspaceRef) {
          return ok([]);
        }
        return ok([{ element, matchScore: 1, matchedOn: 'ID' }]);
      }

      const all = await this.readWorkspaceElements(lookup.workspaceRef);
      const scoped = all.filter((element) => inScope(element, lookup));

      const query = lookup.name ?? lookup.description;
      if (query === undefined) {
        // No text to match on: return the scoped set unranked rather than
        // implying a score the caller could mistake for a name match.
        const matches = scoped.map(
          (element): RegistryMatch => ({ element, matchScore: 0, matchedOn: 'DISPLAY_NAME' }),
        );
        return ok(limited(matches, lookup));
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
      return ok(limited(matches, lookup));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not search the registry.', cause));
    }
  }

  async listPages(workspaceRef: string): Promise<Result<PageRegistryItem[]>> {
    try {
      return ok(await this.readIndexed<PageRegistryItem>(PAGE_INDEX, PAGE_KEY, workspaceRef));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list registry pages.', cause));
    }
  }

  async listComponents(
    workspaceRef: string,
    pageId?: string,
  ): Promise<Result<ComponentRegistryItem[]>> {
    try {
      const components = await this.readIndexed<ComponentRegistryItem>(
        COMPONENT_INDEX,
        COMPONENT_KEY,
        workspaceRef,
      );
      return ok(
        components.filter((component) => pageId === undefined || component.pageId === pageId),
      );
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list registry components.', cause));
    }
  }

  // -------------------------------------------------------------------------
  // Draft-then-commit writes
  // -------------------------------------------------------------------------

  async proposeModification(
    input: Omit<RegistryModification, 'id' | 'createdAt' | 'status'> & {
      readonly status?: 'DRAFT' | 'PROPOSED';
    },
  ): Promise<Result<RegistryModification>> {
    try {
      // A modification against a named entity must reference one that exists, or
      // confirming it later would silently create something nobody drafted.
      if (input.type !== 'ELEMENT_CREATE') {
        if (input.entityId === undefined) {
          return err(
            RunnerErrors.validationFailed(
              `A ${input.type} modification requires an entityId.`,
              { type: input.type },
            ),
          );
        }
        const exists = await this.entityExists(
          input.entityKind,
          input.entityId,
          input.workspaceRef,
        );
        if (!exists) {
          return err(
            RunnerErrors.registryEntityNotFound(input.entityKind.toLowerCase(), input.entityId),
          );
        }
      }

      const modification: RegistryModification = {
        ...input,
        id: newId(ID_PREFIXES.modification),
        status: input.status ?? 'DRAFT',
        createdAt: this.clock.nowIso(),
      };

      await this.redis
        .multi()
        .set(MODIFICATION_KEY + modification.id, JSON.stringify(modification))
        .sadd(PENDING_INDEX + modification.workspaceRef, modification.id)
        .exec();

      this.logger.debug('Registry modification proposed', {
        modificationId: modification.id,
        type: modification.type,
        proposedBy: modification.proposedBy,
      });

      return ok(modification);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not record the registry modification.', cause));
    }
  }

  async getModification(modificationId: string): Promise<Result<RegistryModification>> {
    try {
      const raw = await this.redis.get(MODIFICATION_KEY + modificationId);
      if (raw === null) {
        return err(RunnerErrors.registryEntityNotFound('modification', modificationId));
      }
      return ok(JSON.parse(raw) as RegistryModification);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the registry modification.', cause));
    }
  }

  async listPendingModifications(
    workspaceRef: string,
  ): Promise<Result<RegistryModification[]>> {
    try {
      const ids = await this.redis.smembers(PENDING_INDEX + workspaceRef);
      if (ids.length === 0) return ok([]);

      const raws = await this.redis.mget(ids.map((id) => MODIFICATION_KEY + id));
      const pending: RegistryModification[] = [];
      const decided: string[] = [];

      ids.forEach((id, index) => {
        const raw = raws[index];
        if (raw === null || raw === undefined) {
          decided.push(id);
          return;
        }
        const modification = JSON.parse(raw) as RegistryModification;
        if (modification.status === 'DRAFT' || modification.status === 'PROPOSED') {
          pending.push(modification);
        } else {
          decided.push(id);
        }
      });

      // The index is a convenience, so a decided modification is dropped from it
      // opportunistically rather than requiring a migration.
      if (decided.length > 0) {
        await this.redis.srem(PENDING_INDEX + workspaceRef, ...decided);
      }

      return ok(pending);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list pending modifications.', cause));
    }
  }

  /**
   * Applies a modification and writes its revision as one unit.
   *
   * The write is a single MULTI/EXEC: a committed change without its revision is
   * an unauditable one, which defeats the reason the Registry is
   * draft-then-commit at all.
   */
  async confirmModification(
    modificationId: string,
    decidedBy: string,
  ): Promise<Result<RegistryRevision>> {
    try {
      const found = await this.getModification(modificationId);
      if (!found.ok) return found;
      const modification = found.value;

      // The lifecycle is DRAFT -> PROPOSED -> CONFIRMED (ADR 0003), so a draft is
      // promoted rather than refused: confirming is one call from the caller's
      // point of view, and both hops are legal. What must never pass is a
      // decided modification — that is what keeps history append-only.
      const readyStatus = canTransition(modification.status, 'PROPOSED')
        ? 'PROPOSED'
        : modification.status;

      if (!canTransition(readyStatus, 'CONFIRMED')) {
        return err(
          RunnerErrors.registryConflict(
            `Modification "${modificationId}" is ${modification.status} and cannot be confirmed.`,
            { modificationId, status: modification.status },
          ),
        );
      }

      const applied = await this.apply(modification);
      if (!applied.ok) return applied;

      const { entityId, writes } = applied.value;
      const version = (await this.redis.llen(REVISION_KEY + entityId)) + 1;

      const revision: RegistryRevision = {
        id: newId(ID_PREFIXES.revision),
        workspaceRef: modification.workspaceRef,
        entityKind: modification.entityKind,
        entityId,
        version,
        changedBy: modification.proposedBy,
        changeType: modification.type,
        modificationId: modification.id,
        before: modification.before,
        after: modification.after,
        timestamp: this.clock.nowIso(),
      };

      const confirmed: RegistryModification = {
        ...modification,
        status: 'CONFIRMED',
        decidedAt: this.clock.nowIso(),
        decidedBy,
      };

      const transaction = this.redis.multi();
      for (const write of writes) write(transaction);
      transaction
        .rpush(REVISION_KEY + entityId, JSON.stringify(revision))
        .set(MODIFICATION_KEY + modificationId, JSON.stringify(confirmed))
        .srem(PENDING_INDEX + modification.workspaceRef, modificationId);

      await transaction.exec();

      this.logger.info('Registry modification confirmed', {
        modificationId,
        entityId,
        version,
        changeType: modification.type,
      });

      return ok(revision);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not confirm the registry modification.', cause));
    }
  }

  async rejectModification(
    modificationId: string,
    decidedBy: string,
    reason?: string,
  ): Promise<Result<RegistryModification>> {
    try {
      const found = await this.getModification(modificationId);
      if (!found.ok) return found;
      const modification = found.value;

      if (!canTransition(modification.status, 'REJECTED')) {
        return err(
          RunnerErrors.registryConflict(
            `Modification "${modificationId}" is ${modification.status} and cannot be rejected.`,
            { modificationId, status: modification.status },
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

      await this.redis
        .multi()
        .set(MODIFICATION_KEY + modificationId, JSON.stringify(rejected))
        .srem(PENDING_INDEX + modification.workspaceRef, modificationId)
        .exec();

      return ok(rejected);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not reject the registry modification.', cause));
    }
  }

  async listRevisions(
    workspaceRef: string,
    entityId: string,
  ): Promise<Result<RegistryRevision[]>> {
    try {
      const raws = await this.redis.lrange(REVISION_KEY + entityId, 0, -1);
      const history = raws
        .map((raw) => JSON.parse(raw) as RegistryRevision)
        .filter((revision) => revision.workspaceRef === workspaceRef);
      return ok(history);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the revision history.', cause));
    }
  }

  // -------------------------------------------------------------------------
  // Seeding — tests and local development only
  // -------------------------------------------------------------------------

  /**
   * Inserts entities directly, bypassing draft-then-commit.
   *
   * Deliberately **not** on `RegistryPort`: it exists so a test or a fixture can
   * arrange state, and nothing in the application layer can reach it. Keeping it
   * off the port is what stops it becoming the "direct update path added just
   * for imports" the blueprint warns about.
   */
  async seed(entities: {
    readonly elements?: readonly ElementRegistryItem[];
    readonly pages?: readonly PageRegistryItem[];
    readonly components?: readonly ComponentRegistryItem[];
  }): Promise<void> {
    const transaction = this.redis.multi();

    for (const element of entities.elements ?? []) {
      transaction
        .set(ELEMENT_KEY + element.id, JSON.stringify(element))
        .sadd(ELEMENT_INDEX + element.workspaceRef, element.id);
    }
    for (const page of entities.pages ?? []) {
      transaction
        .set(PAGE_KEY + page.id, JSON.stringify(page))
        .sadd(PAGE_INDEX + page.workspaceRef, page.id);
    }
    for (const component of entities.components ?? []) {
      transaction
        .set(COMPONENT_KEY + component.id, JSON.stringify(component))
        .sadd(COMPONENT_INDEX + component.workspaceRef, component.id);
    }

    await transaction.exec();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Computes the writes a confirmed modification implies.
   *
   * Returns thunks rather than performing them, so the caller can commit the
   * entity change and its revision in one transaction.
   */
  private async apply(
    modification: RegistryModification,
  ): Promise<Result<{ entityId: string; writes: RedisWrite[] }>> {
    const { entityKind } = modification;

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

      return ok({
        entityId: element.id,
        writes: [
          (tx) => tx.set(ELEMENT_KEY + element.id, JSON.stringify(element)),
          (tx) => tx.sadd(ELEMENT_INDEX + element.workspaceRef, element.id),
        ],
      });
    }

    const entityId = modification.entityId;
    if (entityId === undefined) {
      return err(RunnerErrors.validationFailed('The modification has no entityId.'));
    }

    const { key, index } = keysFor(entityKind);
    const raw = await this.redis.get(key + entityId);
    if (raw === null) {
      return err(RunnerErrors.registryEntityNotFound(entityKind.toLowerCase(), entityId));
    }
    const current = JSON.parse(raw) as ElementRegistryItem | PageRegistryItem | ComponentRegistryItem;

    if (modification.type === 'ELEMENT_DELETE') {
      return ok({
        entityId,
        writes: [
          (tx) => tx.del(key + entityId),
          (tx) => tx.srem(index + current.workspaceRef, entityId),
        ],
      });
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

    // `id`, `workspaceRef`, `revision` and `createdAt` are owned by the store.
    // An editable id would break every Test IR referencing it.
    const {
      id: _id,
      workspaceRef: _workspaceRef,
      revision: _revision,
      createdAt: _createdAt,
      ...allowed
    } = patch as Record<string, unknown>;

    const updated = {
      ...current,
      ...allowed,
      revision: current.revision + 1,
      updatedAt: this.clock.nowIso(),
    };

    return ok({
      entityId,
      writes: [(tx) => tx.set(key + entityId, JSON.stringify(updated))],
    });
  }

  private async entityExists(
    kind: RegistryModification['entityKind'],
    entityId: string,
    workspaceRef: string,
  ): Promise<boolean> {
    const { key } = keysFor(kind);
    const raw = await this.redis.get(key + entityId);
    if (raw === null) return false;

    const entity = JSON.parse(raw) as { workspaceRef: string };
    return entity.workspaceRef === workspaceRef;
  }

  private async readElement(elementId: string): Promise<ElementRegistryItem | undefined> {
    const raw = await this.redis.get(ELEMENT_KEY + elementId);
    return raw === null ? undefined : (JSON.parse(raw) as ElementRegistryItem);
  }

  private async readWorkspaceElements(workspaceRef: string): Promise<ElementRegistryItem[]> {
    return this.readIndexed<ElementRegistryItem>(ELEMENT_INDEX, ELEMENT_KEY, workspaceRef);
  }

  /** Reads a workspace's entities, pruning index entries whose value is gone. */
  private async readIndexed<T extends { workspaceRef: string }>(
    indexPrefix: string,
    keyPrefix: string,
    workspaceRef: string,
  ): Promise<T[]> {
    const ids = await this.redis.smembers(indexPrefix + workspaceRef);
    if (ids.length === 0) return [];

    const raws = await this.redis.mget(ids.map((id) => keyPrefix + id));
    const entities: T[] = [];
    const missing: string[] = [];

    ids.forEach((id, position) => {
      const raw = raws[position];
      if (raw === null || raw === undefined) {
        missing.push(id);
        return;
      }
      entities.push(JSON.parse(raw) as T);
    });

    if (missing.length > 0) {
      await this.redis.srem(indexPrefix + workspaceRef, ...missing);
    }

    return entities;
  }
}

/** A deferred Redis command, so several can share one transaction. */
type RedisWrite = (transaction: ReturnType<Redis['multi']>) => unknown;

function keysFor(kind: RegistryModification['entityKind']): {
  key: string;
  index: string;
} {
  switch (kind) {
    case 'ELEMENT':
      return { key: ELEMENT_KEY, index: ELEMENT_INDEX };
    case 'PAGE':
      return { key: PAGE_KEY, index: PAGE_INDEX };
    case 'COMPONENT':
      return { key: COMPONENT_KEY, index: COMPONENT_INDEX };
  }
}

function inScope(element: ElementRegistryItem, lookup: RegistryLookup): boolean {
  if (element.workspaceRef !== lookup.workspaceRef) return false;
  if (lookup.pageId !== undefined && element.pageId !== lookup.pageId) return false;
  if (lookup.componentId !== undefined && element.componentId !== lookup.componentId) {
    return false;
  }
  // A role or semantic hint narrows only when the element declares one, so an
  // entry that predates the hint is not silently excluded.
  if (lookup.role !== undefined && element.role !== undefined && element.role !== lookup.role) {
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

function limited(matches: RegistryMatch[], lookup: RegistryLookup): RegistryMatch[] {
  return lookup.limit === undefined ? matches : matches.slice(0, lookup.limit);
}
