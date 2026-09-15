import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { lookupFromIntent } from '@runner/domain';
import type {
  ComponentRegistryItem,
  ElementRegistryItem,
  PageRegistryItem,
} from '@runner/registry-model';
import { RunnerErrors, unwrapOrThrow } from '@runner/shared';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * Read access to the Runner Registry (blueprint section 52.3).
 *
 * An external IR Generator may use this to discover stable element IDs and
 * embed them in future Test IR — a pure optimization. The Runner must still
 * resolve by name or description when no ID is supplied, so a caller that never
 * touches this endpoint remains fully supported.
 *
 * Reads only. Every write goes through a draft modification, so there is no
 * POST or PATCH here even though the store supports both: exposing a direct
 * write would defeat the audit trail that makes healing reviewable.
 */

/** The public shape of a registry element. */
interface RegistryElementView {
  readonly elementId: string;
  readonly systemName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly role?: string;
  readonly semanticType?: string;
  readonly aliases: readonly string[];
  readonly userConfirmed: boolean;
  readonly confidence: number;
  readonly revision: number;
  readonly pageId?: string;
  readonly componentId?: string;
  readonly updatedAt: string;
}

@Controller('api/v1/registry')
export class RegistryController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  @Get('elements/:elementId')
  async getElement(
    @Param('elementId') elementId: string,
    @Query('workspaceRef') workspaceRef?: string,
  ): Promise<RegistryElementView> {
    const scope = requireWorkspace(workspaceRef);
    const element = await this.container.registryStore.findElementById(scope, elementId);
    return toElementView(unwrapOrThrow(element));
  }

  /**
   * Searches by name, alias, system name or description.
   *
   * `matchedOn` and `matchScore` are returned deliberately: a caller choosing
   * between two candidates needs to know whether it matched a human-authored
   * name or an inferred description, which a bare list cannot express.
   */
  @Get('elements')
  async listElements(
    @Query('workspaceRef') workspaceRef?: string,
    @Query('query') query?: string,
    @Query('role') role?: string,
    @Query('pageId') pageId?: string,
    @Query('componentId') componentId?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    elements: readonly (RegistryElementView & {
      matchedOn: string;
      matchScore: number;
    })[];
  }> {
    const scope = requireWorkspace(workspaceRef);

    const lookup = {
      ...lookupFromIntent(scope, {
        ...(query === undefined ? {} : { name: query }),
        ...(role === undefined ? {} : { role }),
        ...(pageId === undefined ? {} : { pageId }),
        ...(componentId === undefined ? {} : { componentId }),
      }),
      ...(limit === undefined ? {} : { limit: parseLimit(limit) }),
    };

    const matches = unwrapOrThrow(await this.container.registryStore.findElements(lookup));

    return {
      elements: matches.map((match) => ({
        ...toElementView(match.element),
        matchedOn: match.matchedOn,
        matchScore: match.matchScore,
      })),
    };
  }

  @Get('pages')
  async listPages(
    @Query('workspaceRef') workspaceRef?: string,
  ): Promise<{ pages: readonly PageView[] }> {
    const scope = requireWorkspace(workspaceRef);
    const pages = unwrapOrThrow(await this.container.registryStore.listPages(scope));
    return { pages: pages.map(toPageView) };
  }

  @Get('components')
  async listComponents(
    @Query('workspaceRef') workspaceRef?: string,
    @Query('pageId') pageId?: string,
  ): Promise<{ components: readonly ComponentView[] }> {
    const scope = requireWorkspace(workspaceRef);
    const components = unwrapOrThrow(
      await this.container.registryStore.listComponents(scope, pageId),
    );
    return { components: components.map(toComponentView) };
  }

  /** Pending drafts and proposals awaiting a decision. */
  @Get('modifications')
  async listModifications(@Query('workspaceRef') workspaceRef?: string): Promise<{
    modifications: readonly {
      id: string;
      entityKind: string;
      entityId?: string;
      type: string;
      status: string;
      proposedBy: string;
      reason?: string;
      createdAt: string;
    }[];
  }> {
    const scope = requireWorkspace(workspaceRef);
    const pending = unwrapOrThrow(
      await this.container.registryStore.listPendingModifications(scope),
    );

    return {
      modifications: pending.map((modification) => ({
        id: modification.id,
        entityKind: modification.entityKind,
        ...(modification.entityId === undefined ? {} : { entityId: modification.entityId }),
        type: modification.type,
        status: modification.status,
        proposedBy: modification.proposedBy,
        ...(modification.reason === undefined ? {} : { reason: modification.reason }),
        createdAt: modification.createdAt,
      })),
    };
  }

  /** The change history of one entity, oldest revision first. */
  @Get('revisions/:entityId')
  async listRevisions(
    @Param('entityId') entityId: string,
    @Query('workspaceRef') workspaceRef?: string,
  ): Promise<{
    revisions: readonly {
      id: string;
      version: number;
      entityKind: string;
      changeType: string;
      changedBy: string;
      modificationId?: string;
      timestamp: string;
    }[];
  }> {
    const scope = requireWorkspace(workspaceRef);
    const history = unwrapOrThrow(
      await this.container.registryStore.listRevisions(scope, entityId),
    );

    return {
      revisions: history.map((revision) => ({
        id: revision.id,
        version: revision.version,
        entityKind: revision.entityKind,
        changeType: revision.changeType,
        changedBy: revision.changedBy,
        ...(revision.modificationId === undefined
          ? {}
          : { modificationId: revision.modificationId }),
        timestamp: revision.timestamp,
      })),
    };
  }

  /**
   * Semantic resolution against the Registry alone, with no browser.
   *
   * Useful to an IR Generator that wants to know whether a target it is about
   * to write will resolve, before submitting a run.
   */
  @Get('resolve')
  async resolve(
    @Query('workspaceRef') workspaceRef?: string,
    @Query('name') name?: string,
    @Query('description') description?: string,
    @Query('role') role?: string,
  ): Promise<{
    resolved: boolean;
    element?: RegistryElementView;
    matchedOn?: string;
    matchScore?: number;
    alternatives: readonly { elementId: string; displayName: string; matchScore: number }[];
  }> {
    const scope = requireWorkspace(workspaceRef);

    if (name === undefined && description === undefined) {
      throw RunnerErrors.validationFailed(
        'Provide `name` or `description` to resolve against the Registry.',
      );
    }

    const matches = unwrapOrThrow(
      await this.container.registryStore.findElements({
        ...lookupFromIntent(scope, {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(role === undefined ? {} : { role }),
        }),
        limit: 5,
      }),
    );

    const [best, ...rest] = matches;
    if (best === undefined) return { resolved: false, alternatives: [] };

    return {
      resolved: true,
      element: toElementView(best.element),
      matchedOn: best.matchedOn,
      matchScore: best.matchScore,
      alternatives: rest.map((match) => ({
        elementId: match.element.id,
        displayName: match.element.displayName,
        matchScore: match.matchScore,
      })),
    };
  }
}

interface PageView {
  readonly pageId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly urlPatterns: readonly string[];
  readonly revision: number;
}

interface ComponentView {
  readonly componentId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly pageId?: string;
  readonly revision: number;
}

/**
 * Projects the internal registry item onto the public view.
 *
 * `primarySelector` and the selector history are withheld: Test IR references
 * elements by identity and meaning, never by selector, and publishing the
 * mechanics would invite a caller to embed one — exactly what the Registry
 * exists to prevent.
 */
function toElementView(element: ElementRegistryItem): RegistryElementView {
  const view: Record<string, unknown> = {
    elementId: element.id,
    systemName: element.systemName,
    displayName: element.displayName,
    aliases: element.aliases.map((alias) => alias.value),
    userConfirmed: element.userConfirmed,
    confidence: element.confidence,
    revision: element.revision,
    updatedAt: element.updatedAt,
  };

  if (element.description !== undefined) view.description = element.description;
  if (element.role !== undefined) view.role = element.role;
  if (element.semanticType !== undefined) view.semanticType = element.semanticType;
  if (element.pageId !== undefined) view.pageId = element.pageId;
  if (element.componentId !== undefined) view.componentId = element.componentId;

  return view as unknown as RegistryElementView;
}

function toPageView(page: PageRegistryItem): PageView {
  const view: Record<string, unknown> = {
    pageId: page.id,
    displayName: page.displayName,
    urlPatterns: page.urlPatterns,
    revision: page.revision,
  };
  if (page.description !== undefined) view.description = page.description;
  return view as unknown as PageView;
}

function toComponentView(component: ComponentRegistryItem): ComponentView {
  const view: Record<string, unknown> = {
    componentId: component.id,
    displayName: component.displayName,
    revision: component.revision,
  };
  if (component.description !== undefined) view.description = component.description;
  if (component.pageId !== undefined) view.pageId = component.pageId;
  return view as unknown as ComponentView;
}

/**
 * Every registry read is workspace-scoped.
 *
 * Required rather than defaulted: a lookup that silently searched every
 * workspace would leak one tenant's element names to another.
 */
function requireWorkspace(workspaceRef: string | undefined): string {
  if (workspaceRef === undefined || workspaceRef.trim().length === 0) {
    throw RunnerErrors.validationFailed('workspaceRef is required.');
  }
  return workspaceRef;
}

function parseLimit(raw: string): number {
  const limit = Number.parseInt(raw, 10);
  if (Number.isNaN(limit) || limit < 1 || limit > 100) {
    throw RunnerErrors.validationFailed('`limit` must be between 1 and 100.');
  }
  return limit;
}
