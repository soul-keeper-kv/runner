import type { RegistryMatch, RegistryPort } from '@runner/application';
import type { RegistryLookup } from '@runner/domain';
import {
  canTransition,
  matchElementByName,
  type ComponentRegistryItem,
  type ElementAlias,
  type ElementRegistryItem,
  type NameSource,
  type PageRegistryItem,
  type RegistryModification,
  type RegistryRevision,
  type ScoredSelectorEntry,
} from '@runner/registry-model';
import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { PostgresClient, PostgresQueryable } from './postgres-client.js';

/**
 * The Postgres RegistryPort — the Registry's system of record
 * (blueprint section 51).
 *
 * Redis served the Registry well enough to build on, but it is a cache: a flush
 * loses the element identities that every previously generated Test IR
 * references, which is the one thing in this system that must not be
 * disposable. This adapter is where the Registry belongs.
 *
 * Three things it does that the Redis adapter could only approximate:
 *
 *  - **`confirmModification` is one transaction.** The entity write, the
 *    revision insert and the status change either all land or none do. A
 *    committed change without its revision is unauditable, which defeats the
 *    reason the Registry is draft-then-commit at all.
 *  - **Revision numbering is enforced by the database.** `registry_revisions`
 *    has `UNIQUE (entity_id, version)`, so two concurrent confirmations cannot
 *    both claim version 4 — one fails and retries rather than silently
 *    overwriting history.
 *  - **Aliases and fallback selectors are rows, not embedded JSON**, so they can
 *    be indexed and queried. `element_aliases` is indexed on `lower(value)`
 *    precisely because alias lookup is a primary resolution path.
 */

export class PostgresRegistryStore implements RegistryPort {
  constructor(
    private readonly sql: PostgresClient,
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
      const elements = await this.loadElements(this.sql`
        SELECT * FROM elements WHERE id = ${elementId} AND workspace_ref = ${workspaceRef}
      `);

      const element = elements[0];
      // A workspace mismatch reads as "not found", never as "forbidden":
      // confirming an id exists in someone else's workspace leaks its existence.
      if (element === undefined) {
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
   * Scoping is pushed into SQL; the *scoring* stays in `@runner/registry-model`
   * so this adapter and the API's search endpoint can never disagree about what
   * counts as a match.
   */
  async findElements(lookup: RegistryLookup): Promise<Result<RegistryMatch[]>> {
    try {
      if (lookup.elementId !== undefined) {
        const found = await this.findElementById(lookup.workspaceRef, lookup.elementId);
        // An id lookup short-circuits: it is unambiguous, and scoring names
        // afterwards could only add weaker matches to an exact answer.
        return ok(found.ok ? [{ element: found.value, matchScore: 1, matchedOn: 'ID' }] : []);
      }

      const scoped = await this.loadElements(this.sql`
        SELECT * FROM elements
        WHERE workspace_ref = ${lookup.workspaceRef}
          AND (${lookup.pageId ?? null}::text IS NULL OR page_id = ${lookup.pageId ?? null})
          AND (${lookup.componentId ?? null}::text IS NULL OR component_id = ${lookup.componentId ?? null})
          -- A role or semantic hint narrows only when the element declares one,
          -- so an entry that predates the hint is not silently excluded.
          AND (${lookup.role ?? null}::text IS NULL OR role IS NULL OR role = ${lookup.role ?? null})
          AND (${lookup.semanticType ?? null}::text IS NULL OR semantic_type IS NULL OR semantic_type = ${lookup.semanticType ?? null})
      `);

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
      const rows = await this.sql<PageRow[]>`
        SELECT * FROM pages WHERE workspace_ref = ${workspaceRef} ORDER BY display_name
      `;
      return ok(rows.map(toPage));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list registry pages.', cause));
    }
  }

  async listComponents(
    workspaceRef: string,
    pageId?: string,
  ): Promise<Result<ComponentRegistryItem[]>> {
    try {
      const rows = await this.sql<ComponentRow[]>`
        SELECT * FROM components
        WHERE workspace_ref = ${workspaceRef}
          AND (${pageId ?? null}::text IS NULL OR page_id = ${pageId ?? null})
        ORDER BY display_name
      `;
      return ok(rows.map(toComponent));
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
        if (!(await this.entityExists(input.entityKind, input.entityId, input.workspaceRef))) {
          return err(
            RunnerErrors.registryEntityNotFound(input.entityKind.toLowerCase(), input.entityId),
          );
        }
      }

      await this.ensureWorkspace(input.workspaceRef);

      const status = input.status ?? 'DRAFT';
      // The id is generated by the database: the column is a uuid, and letting
      // Postgres mint it keeps the two from disagreeing.
      const rows = await this.sql<ModificationRow[]>`
        INSERT INTO registry_modifications
          (workspace_ref, entity_kind, entity_id, type, status,
           before_value, after_value, proposed_by, reason, live_session_id, execution_id)
        VALUES (
          ${input.workspaceRef}, ${input.entityKind}, ${input.entityId ?? null},
          ${input.type}, ${status},
          ${this.sql.json(input.before as never)}, ${this.sql.json(input.after as never)},
          ${input.proposedBy}, ${input.reason ?? null},
          ${input.liveSessionId ?? null}, ${input.executionId ?? null}
        )
        RETURNING *
      `;

      const created = rows[0];
      if (created === undefined) {
        return err(RunnerErrors.internal('The modification insert returned no row.'));
      }

      this.logger.debug('Registry modification proposed', {
        modificationId: created.id,
        type: created.type,
        proposedBy: created.proposed_by,
      });

      return ok(toModification(created));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not record the registry modification.', cause));
    }
  }

  async getModification(modificationId: string): Promise<Result<RegistryModification>> {
    try {
      if (!isUuid(modificationId)) {
        // Postgres would reject a malformed uuid with a type error; a not-found
        // is the honest answer to "no such modification".
        return err(RunnerErrors.registryEntityNotFound('modification', modificationId));
      }

      const rows = await this.sql<ModificationRow[]>`
        SELECT * FROM registry_modifications WHERE id = ${modificationId}
      `;
      const row = rows[0];
      return row === undefined
        ? err(RunnerErrors.registryEntityNotFound('modification', modificationId))
        : ok(toModification(row));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the registry modification.', cause));
    }
  }

  async listPendingModifications(
    workspaceRef: string,
  ): Promise<Result<RegistryModification[]>> {
    try {
      // Matches `registry_modifications_pending_idx`, a partial index on exactly
      // this predicate.
      const rows = await this.sql<ModificationRow[]>`
        SELECT * FROM registry_modifications
        WHERE workspace_ref = ${workspaceRef} AND status IN ('DRAFT', 'PROPOSED')
        ORDER BY created_at
      `;
      return ok(rows.map(toModification));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list pending modifications.', cause));
    }
  }

  /**
   * Applies a modification and writes its revision in a single transaction.
   *
   * Everything inside `begin` commits together. The revision's `version` is read
   * under the same transaction and protected by `UNIQUE (entity_id, version)`, so
   * two concurrent confirmations cannot both claim the same number — the loser
   * fails outright instead of quietly overwriting history.
   */
  async confirmModification(
    modificationId: string,
    decidedBy: string,
  ): Promise<Result<RegistryRevision>> {
    const found = await this.getModification(modificationId);
    if (!found.ok) return found;
    const modification = found.value;

    // The lifecycle is DRAFT -> PROPOSED -> CONFIRMED (ADR 0003), so a draft is
    // promoted rather than refused: confirming is one call from the caller's
    // point of view, and both hops are legal. A decided modification must never
    // pass — that is what keeps history append-only.
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

    try {
      const revision = await this.sql.begin(async (tx) => {
        const entityId = await applyModification(tx, modification, this.clock);

        const versions = await tx<{ next: number }[]>`
          SELECT COALESCE(MAX(version), 0) + 1 AS next
          FROM registry_revisions WHERE entity_id = ${entityId}
        `;
        const version = versions[0]?.next ?? 1;

        const inserted = await tx<RevisionRow[]>`
          INSERT INTO registry_revisions
            (workspace_ref, entity_kind, entity_id, version, changed_by, change_type,
             modification_id, before_value, after_value)
          VALUES (
            ${modification.workspaceRef}, ${modification.entityKind}, ${entityId},
            ${version}, ${modification.proposedBy}, ${modification.type},
            ${modificationId},
            ${tx.json(modification.before as never)}, ${tx.json(modification.after as never)}
          )
          RETURNING *
        `;

        await tx`
          UPDATE registry_modifications
          SET status = 'CONFIRMED', decided_at = ${this.clock.nowIso()}, decided_by = ${decidedBy}
          WHERE id = ${modificationId}
        `;

        const row = inserted[0];
        if (row === undefined) throw new Error('The revision insert returned no row.');
        return toRevision(row);
      });

      this.logger.info('Registry modification confirmed', {
        modificationId,
        entityId: revision.entityId,
        version: revision.version,
        changeType: revision.changeType,
      });

      return ok(revision);
    } catch (cause) {
      // A capability gap thrown from inside the transaction is reported as
      // itself rather than buried as an internal error.
      if (cause instanceof Error && cause.message.startsWith('UNSUPPORTED_ENTITY:')) {
        return err(
          RunnerErrors.capabilityNotImplemented(
            cause.message.replace('UNSUPPORTED_ENTITY:', '').trim(),
          ),
        );
      }
      return err(RunnerErrors.internal('Could not confirm the registry modification.', cause));
    }
  }

  async rejectModification(
    modificationId: string,
    decidedBy: string,
    reason?: string,
  ): Promise<Result<RegistryModification>> {
    const found = await this.getModification(modificationId);
    if (!found.ok) return found;

    if (!canTransition(found.value.status, 'REJECTED')) {
      return err(
        RunnerErrors.registryConflict(
          `Modification "${modificationId}" is ${found.value.status} and cannot be rejected.`,
          { modificationId, status: found.value.status },
        ),
      );
    }

    try {
      const rows = await this.sql<ModificationRow[]>`
        UPDATE registry_modifications
        SET status = 'REJECTED',
            decided_at = ${this.clock.nowIso()},
            decided_by = ${decidedBy},
            reason = COALESCE(${reason ?? null}, reason)
        WHERE id = ${modificationId}
        RETURNING *
      `;

      const row = rows[0];
      return row === undefined
        ? err(RunnerErrors.registryEntityNotFound('modification', modificationId))
        : ok(toModification(row));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not reject the registry modification.', cause));
    }
  }

  async listRevisions(
    workspaceRef: string,
    entityId: string,
  ): Promise<Result<RegistryRevision[]>> {
    try {
      const rows = await this.sql<RevisionRow[]>`
        SELECT * FROM registry_revisions
        WHERE entity_id = ${entityId} AND workspace_ref = ${workspaceRef}
        ORDER BY version
      `;
      return ok(rows.map(toRevision));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the revision history.', cause));
    }
  }

  // -------------------------------------------------------------------------
  // Seeding — tests and local development only
  // -------------------------------------------------------------------------

  /**
   * Inserts elements directly, bypassing draft-then-commit.
   *
   * Deliberately **not** on `RegistryPort`, so nothing in the application layer
   * can reach it. Keeping it off the port is what stops it becoming the "direct
   * update path added just for imports" the blueprint warns about.
   */
  async seed(entities: {
    readonly elements?: readonly ElementRegistryItem[];
    readonly pages?: readonly PageRegistryItem[];
    readonly components?: readonly ComponentRegistryItem[];
  }): Promise<void> {
    for (const page of entities.pages ?? []) {
      await this.ensureWorkspace(page.workspaceRef);
      await this.sql`
        INSERT INTO pages (id, workspace_ref, display_name, description, url_patterns, revision)
        VALUES (${page.id}, ${page.workspaceRef}, ${page.displayName},
                ${page.description ?? null}, ${this.sql.json([...page.urlPatterns] as never)},
                ${page.revision})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    for (const component of entities.components ?? []) {
      await this.ensureWorkspace(component.workspaceRef);
      await this.sql`
        INSERT INTO components (id, workspace_ref, page_id, display_name, description, root_selector, revision)
        VALUES (${component.id}, ${component.workspaceRef}, ${component.pageId ?? null},
                ${component.displayName}, ${component.description ?? null},
                ${component.rootSelector === undefined ? null : this.sql.json(component.rootSelector as never)},
                ${component.revision})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    for (const element of entities.elements ?? []) {
      await this.ensureWorkspace(element.workspaceRef);
      await this.sql.begin(async (tx) => {
        await insertElement(tx, element);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * `elements.workspace_ref` is a foreign key, so the workspace row must exist
   * before any element can be written.
   *
   * The Runner never interprets a workspace reference — it is an opaque string
   * owned by the calling service — so registering one on first use is correct
   * rather than something a caller should have to do first.
   */
  private async ensureWorkspace(workspaceRef: string): Promise<void> {
    await this.sql`
      INSERT INTO external_workspaces (workspace_ref)
      VALUES (${workspaceRef})
      ON CONFLICT (workspace_ref) DO NOTHING
    `;
  }

  private async entityExists(
    kind: RegistryModification['entityKind'],
    entityId: string,
    workspaceRef: string,
  ): Promise<boolean> {
    const table =
      kind === 'ELEMENT' ? this.sql`elements` : kind === 'PAGE' ? this.sql`pages` : this.sql`components`;

    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ${table} WHERE id = ${entityId} AND workspace_ref = ${workspaceRef}
      ) AS exists
    `;
    return rows[0]?.exists === true;
  }

  /** Loads elements plus their aliases and fallback selectors. */
  private async loadElements(
    query: Promise<readonly ElementRow[]>,
  ): Promise<ElementRegistryItem[]> {
    const rows = await query;
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);

    const aliases = await this.sql<AliasRow[]>`
      SELECT * FROM element_aliases WHERE element_id IN ${this.sql(ids)} ORDER BY created_at
    `;
    const selectors = await this.sql<SelectorRow[]>`
      SELECT * FROM element_selectors
      WHERE element_id IN ${this.sql(ids)} AND is_primary = FALSE
      ORDER BY score DESC
    `;

    return rows.map((row) =>
      toElement(
        row,
        aliases.filter((alias) => alias.element_id === row.id),
        selectors.filter((selector) => selector.element_id === row.id),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Applying a confirmed modification
// ---------------------------------------------------------------------------

/**
 * Applies the change a confirmed modification describes, inside a transaction.
 *
 * Throws rather than returning a Result: it runs inside `sql.begin`, where a
 * throw is what rolls the transaction back. The caller translates.
 */
async function applyModification(
  tx: PostgresQueryable,
  modification: RegistryModification,
  clock: Clock,
): Promise<string> {
  if (modification.entityKind !== 'ELEMENT') {
    // Page and component edits need their own apply logic; refusing is better
    // than recording a revision for a change that was never applied.
    throw new Error(
      `UNSUPPORTED_ENTITY: Confirming a ${modification.entityKind} modification`,
    );
  }

  if (modification.type === 'ELEMENT_CREATE') {
    const created = modification.after as ElementRegistryItem | undefined;
    if (created === undefined) {
      throw new Error('An ELEMENT_CREATE modification needs an `after` value.');
    }
    await insertElement(tx, { ...created, revision: 1, updatedAt: clock.nowIso() });
    return created.id;
  }

  const entityId = modification.entityId;
  if (entityId === undefined) throw new Error('The modification has no entityId.');

  const existing = await tx<ElementRow[]>`SELECT * FROM elements WHERE id = ${entityId}`;
  const current = existing[0];
  if (current === undefined) throw new Error(`Element "${entityId}" no longer exists.`);

  if (modification.type === 'ELEMENT_DELETE') {
    // Aliases and selectors cascade on delete.
    await tx`DELETE FROM elements WHERE id = ${entityId}`;
    return entityId;
  }

  const patch = (modification.after ?? {}) as Partial<ElementRegistryItem>;

  // `id`, `workspaceRef`, `revision` and `createdAt` are owned by the store. An
  // editable id would break every Test IR referencing it.
  await tx`
    UPDATE elements SET
      display_name        = COALESCE(${patch.displayName ?? null}, display_name),
      system_name         = COALESCE(${patch.systemName ?? null}, system_name),
      description         = COALESCE(${patch.description ?? null}, description),
      display_name_source = COALESCE(${patch.displayNameSource ?? null}, display_name_source),
      semantic_type       = COALESCE(${patch.semanticType ?? null}, semantic_type),
      role                = COALESCE(${patch.role ?? null}, role),
      primary_selector    = COALESCE(${patch.primarySelector === undefined ? null : tx.json(patch.primarySelector as never)}, primary_selector),
      scoped_selector     = COALESCE(${patch.scopedSelector === undefined ? null : tx.json(patch.scopedSelector as never)}, scoped_selector),
      user_confirmed      = COALESCE(${patch.userConfirmed ?? null}, user_confirmed),
      confidence          = COALESCE(${patch.confidence ?? null}, confidence),
      revision            = revision + 1,
      updated_at          = ${clock.nowIso()}
    WHERE id = ${entityId}
  `;

  if (patch.aliases !== undefined) {
    await tx`DELETE FROM element_aliases WHERE element_id = ${entityId}`;
    for (const alias of patch.aliases) {
      await tx`
        INSERT INTO element_aliases (element_id, value, source, usage_count)
        VALUES (${entityId}, ${alias.value}, ${alias.source}, ${alias.usageCount ?? 0})
        ON CONFLICT (element_id, value) DO NOTHING
      `;
    }
  }

  // A replaced primary selector is kept as a non-primary row, which is how the
  // database records what a selector used to be.
  if (patch.primarySelector !== undefined) {
    await tx`
      INSERT INTO element_selectors (element_id, selector, score, is_primary)
      VALUES (${entityId}, ${tx.json(current.primary_selector as never)}, 0, FALSE)
    `;
  }

  return entityId;
}

async function insertElement(
  tx: PostgresQueryable,
  element: ElementRegistryItem,
): Promise<void> {
  await tx`
    INSERT INTO elements (
      id, workspace_ref, application_id, page_id, component_id,
      system_name, display_name, description, display_name_source,
      semantic_type, role, tags,
      primary_selector, scoped_selector, available_when,
      user_confirmed, confidence, revision, created_at, updated_at
    ) VALUES (
      ${element.id}, ${element.workspaceRef}, ${element.applicationId ?? null},
      ${element.pageId ?? null}, ${element.componentId ?? null},
      ${element.systemName}, ${element.displayName}, ${element.description ?? null},
      ${element.displayNameSource},
      ${element.semanticType ?? null}, ${element.role ?? null},
      ${tx.json([...(element.tags ?? [])] as never)},
      ${tx.json(element.primarySelector as never)},
      ${element.scopedSelector === undefined ? null : tx.json(element.scopedSelector as never)},
      ${tx.json([...(element.availableWhen ?? [])] as never)},
      ${element.userConfirmed}, ${element.confidence}, ${element.revision},
      ${element.createdAt}, ${element.updatedAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  for (const alias of element.aliases) {
    await tx`
      INSERT INTO element_aliases (element_id, value, source, usage_count)
      VALUES (${element.id}, ${alias.value}, ${alias.source}, ${alias.usageCount ?? 0})
      ON CONFLICT (element_id, value) DO NOTHING
    `;
  }

  for (const fallback of element.fallbackSelectors) {
    await tx`
      INSERT INTO element_selectors
        (element_id, selector, score, is_primary, success_count, failure_count, last_validated_at)
      VALUES (${element.id}, ${tx.json(fallback.selector as never)}, ${fallback.score}, FALSE,
              ${fallback.successCount ?? 0}, ${fallback.failureCount ?? 0},
              ${fallback.lastValidatedAt ?? null})
    `;
  }
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

interface ElementRow {
  id: string;
  workspace_ref: string;
  application_id: string | null;
  page_id: string | null;
  component_id: string | null;
  system_name: string;
  display_name: string;
  description: string | null;
  display_name_source: string;
  semantic_type: string | null;
  role: string | null;
  tags: unknown;
  primary_selector: unknown;
  scoped_selector: unknown;
  available_when: unknown;
  user_confirmed: boolean;
  confidence: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface AliasRow {
  element_id: string;
  value: string;
  source: string;
  usage_count: number;
  created_at: string;
}

interface SelectorRow {
  element_id: string;
  selector: unknown;
  score: number;
  success_count: number;
  failure_count: number;
  last_validated_at: string | null;
}

interface PageRow {
  id: string;
  workspace_ref: string;
  display_name: string;
  description: string | null;
  url_patterns: unknown;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ComponentRow {
  id: string;
  workspace_ref: string;
  page_id: string | null;
  display_name: string;
  description: string | null;
  root_selector: unknown;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ModificationRow {
  id: string;
  workspace_ref: string;
  entity_kind: string;
  entity_id: string | null;
  type: string;
  status: string;
  before_value: unknown;
  after_value: unknown;
  proposed_by: string;
  reason: string | null;
  live_session_id: string | null;
  execution_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface RevisionRow {
  id: string;
  workspace_ref: string;
  entity_kind: string;
  entity_id: string;
  version: number;
  changed_by: string;
  change_type: string;
  modification_id: string | null;
  before_value: unknown;
  after_value: unknown;
  created_at: string;
}

function toElement(
  row: ElementRow,
  aliases: readonly AliasRow[],
  fallbacks: readonly SelectorRow[],
): ElementRegistryItem {
  const element: Record<string, unknown> = {
    id: row.id,
    workspaceRef: row.workspace_ref,
    systemName: row.system_name,
    displayName: row.display_name,
    displayNameSource: row.display_name_source as NameSource,
    aliases: aliases.map(
      (alias): ElementAlias => ({
        value: alias.value,
        source: alias.source as NameSource,
        createdAt: alias.created_at,
        usageCount: alias.usage_count,
      }),
    ),
    primarySelector: row.primary_selector as SelectorDefinition,
    fallbackSelectors: fallbacks.map(
      (entry): ScoredSelectorEntry => ({
        selector: entry.selector as SelectorDefinition,
        score: entry.score,
        successCount: entry.success_count,
        failureCount: entry.failure_count,
        ...(entry.last_validated_at === null
          ? {}
          : { lastValidatedAt: entry.last_validated_at }),
      }),
    ),
    userConfirmed: row.user_confirmed,
    confidence: row.confidence,
    // Selector and naming history live in `element_selectors` and the revision
    // log; they are not reconstructed on every read.
    selectorHistory: [],
    namingHistory: [],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.application_id !== null) element.applicationId = row.application_id;
  if (row.page_id !== null) element.pageId = row.page_id;
  if (row.component_id !== null) element.componentId = row.component_id;
  if (row.description !== null) element.description = row.description;
  if (row.semantic_type !== null) element.semanticType = row.semantic_type;
  if (row.role !== null) element.role = row.role;
  if (Array.isArray(row.tags) && row.tags.length > 0) element.tags = row.tags;
  if (row.scoped_selector !== null) element.scopedSelector = row.scoped_selector as ScopedSelector;
  if (Array.isArray(row.available_when) && row.available_when.length > 0) {
    element.availableWhen = row.available_when;
  }

  return element as unknown as ElementRegistryItem;
}

function toPage(row: PageRow): PageRegistryItem {
  const page: Record<string, unknown> = {
    id: row.id,
    workspaceRef: row.workspace_ref,
    displayName: row.display_name,
    urlPatterns: Array.isArray(row.url_patterns) ? row.url_patterns : [],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.description !== null) page.description = row.description;
  return page as unknown as PageRegistryItem;
}

function toComponent(row: ComponentRow): ComponentRegistryItem {
  const component: Record<string, unknown> = {
    id: row.id,
    workspaceRef: row.workspace_ref,
    displayName: row.display_name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.page_id !== null) component.pageId = row.page_id;
  if (row.description !== null) component.description = row.description;
  if (row.root_selector !== null) component.rootSelector = row.root_selector as SelectorDefinition;
  return component as unknown as ComponentRegistryItem;
}

function toModification(row: ModificationRow): RegistryModification {
  const modification: Record<string, unknown> = {
    id: row.id,
    workspaceRef: row.workspace_ref,
    entityKind: row.entity_kind,
    type: row.type,
    status: row.status,
    before: row.before_value,
    after: row.after_value,
    proposedBy: row.proposed_by,
    createdAt: row.created_at,
  };
  if (row.entity_id !== null) modification.entityId = row.entity_id;
  if (row.reason !== null) modification.reason = row.reason;
  if (row.live_session_id !== null) modification.liveSessionId = row.live_session_id;
  if (row.execution_id !== null) modification.executionId = row.execution_id;
  if (row.decided_at !== null) modification.decidedAt = row.decided_at;
  if (row.decided_by !== null) modification.decidedBy = row.decided_by;
  return modification as unknown as RegistryModification;
}

function toRevision(row: RevisionRow): RegistryRevision {
  const revision: Record<string, unknown> = {
    id: row.id,
    workspaceRef: row.workspace_ref,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    version: row.version,
    changedBy: row.changed_by,
    changeType: row.change_type,
    before: row.before_value,
    after: row.after_value,
    timestamp: row.created_at,
  };
  if (row.modification_id !== null) revision.modificationId = row.modification_id;
  return revision as unknown as RegistryRevision;
}

function limited(matches: RegistryMatch[], lookup: RegistryLookup): RegistryMatch[] {
  return lookup.limit === undefined ? matches : matches.slice(0, lookup.limit);
}

/** Modification ids are database uuids; anything else cannot exist. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
