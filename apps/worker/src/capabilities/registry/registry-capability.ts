import type { RegistryPort } from '@runner/application';
import type { LiveCommandType, RawLiveCommand } from '@runner/live-protocol';
import type {
  ElementRegistryItem,
  RegistryModification,
  RegistryModificationType,
} from '@runner/registry-model';
import { computeElementConfidence } from '@runner/registry-model';
import { validateSelectorDefinition, type SelectorDefinition } from '@runner/selector-model';
import {
  RunnerErrors,
  err,
  newElementId,
  ok,
  toSystemName,
  type Clock,
  type Result,
} from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';

/**
 * Registry editing from a live session (blueprint sections 35 and 36).
 *
 * This is what turns a pick into something durable: the user clicks an element,
 * names it, and saves — and what gets written is a *draft*, never a direct
 * mutation. Every command here goes through `proposeModification`, and a
 * separate `registry.confirm` applies it. That separation is what makes undo,
 * diff, review and auditable healing possible (ADR 0003), and it is why there is
 * no "save element" command that writes straight through.
 *
 * The capability deliberately does not confirm its own drafts. In REVIEW mode a
 * human decides; in AUTO mode a policy may decide. Either way the decision is a
 * second, recorded step.
 */

/** What a registry command reports back. */
export interface RegistryCommandResult {
  readonly modificationId: string;
  readonly status: RegistryModification['status'];
  readonly type: RegistryModificationType;
  /** Present once a confirmation has applied the change. */
  readonly entityId?: string;
  readonly revision?: number;
}

export class RegistryCapability implements LiveCapability<RegistryCommandResult> {
  readonly type = 'registry' as const;
  readonly handles: readonly LiveCommandType[] = [
    'registry.create-draft',
    'registry.update-draft',
    'registry.rename',
    'registry.update-description',
    'registry.update-selector',
    'registry.confirm',
    'registry.reject',
  ];

  constructor(
    private readonly registry: RegistryPort,
    private readonly clock: Clock,
  ) {}

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<RegistryCommandResult>> {
    const workspaceRef = context.session.workspaceRef;

    switch (command.type as LiveCommandType) {
      case 'registry.create-draft':
        return this.createDraft(command, workspaceRef);
      case 'registry.rename':
        return this.renameElement(command, workspaceRef);
      case 'registry.update-description':
        return this.updateDescription(command, workspaceRef);
      case 'registry.update-selector':
        return this.updateSelector(command, workspaceRef);
      case 'registry.confirm':
        return this.confirm(command, context);
      case 'registry.reject':
        return this.reject(command, context);

      case 'registry.update-draft':
        // Editing a draft in place would rewrite a record a reviewer may already
        // be looking at. Rejecting it and drafting again keeps the history
        // honest, so this stays unimplemented rather than becoming a mutation.
        return err(
          RunnerErrors.capabilityNotImplemented(
            'Editing a draft in place (reject it and create a new draft instead)',
          ),
        );

      default:
        return err(RunnerErrors.liveCommandUnsupported(command.type));
    }
  }

  /**
   * Proposes a brand-new element, typically straight from a pick.
   *
   * `systemName` is generated from the display name rather than accepted from
   * the caller: it becomes a code identifier during Page Object generation, and
   * raw user text is not safe there (blueprint section 46).
   */
  private async createDraft(
    command: RawLiveCommand,
    workspaceRef: string,
  ): Promise<Result<RegistryCommandResult>> {
    const payload = payloadOf<{
      displayName?: string;
      description?: string;
      selector?: SelectorDefinition;
      aliases?: readonly string[];
      selectorScore?: number;
    }>(command);
    if (!payload.ok) return payload;

    const { displayName, description, selector, aliases } = payload.value;

    if (displayName === undefined || displayName.trim().length === 0) {
      return err(
        RunnerErrors.validationFailed('A registry draft needs a displayName.'),
      );
    }
    if (selector === undefined) {
      return err(RunnerErrors.validationFailed('A registry draft needs a selector.'));
    }

    const guard = validateSelectorDefinition(selector);
    if (!guard.valid) {
      return err(
        RunnerErrors.selectorInvalid(
          selector.type,
          guard.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('; '),
        ),
      );
    }

    const now = this.clock.nowIso();
    const element: ElementRegistryItem = {
      id: newElementId(),
      workspaceRef,
      systemName: toSystemName(displayName),
      displayName: displayName.trim(),
      ...(description === undefined ? {} : { description }),
      // A name typed by a person outranks anything the Runner guessed, and that
      // provenance is what stops a later AI suggestion from overwriting it.
      displayNameSource: 'USER',
      aliases: (aliases ?? []).map((value) => ({
        value,
        source: 'USER' as const,
        createdAt: now,
      })),
      primarySelector: selector,
      fallbackSelectors: [],
      // Drafted by a human, but not yet confirmed: `userConfirmed` becomes true
      // when the modification is confirmed, not when it is proposed.
      userConfirmed: false,
      confidence: computeElementConfidence({
        selectorScore: payload.value.selectorScore ?? 0,
        userConfirmed: false,
      }),
      selectorHistory: [],
      namingHistory: [{ displayName: displayName.trim(), source: 'USER', changedAt: now }],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    return this.propose({
      workspaceRef,
      entityKind: 'ELEMENT',
      type: 'ELEMENT_CREATE',
      before: null,
      after: element,
      proposedBy: 'USER',
    });
  }

  private async renameElement(
    command: RawLiveCommand,
    workspaceRef: string,
  ): Promise<Result<RegistryCommandResult>> {
    const payload = payloadOf<{ elementId?: string; displayName?: string }>(command);
    if (!payload.ok) return payload;

    const { elementId, displayName } = payload.value;
    if (elementId === undefined || displayName === undefined) {
      return err(
        RunnerErrors.validationFailed('A rename needs an elementId and a displayName.'),
      );
    }

    const current = await this.registry.findElementById(workspaceRef, elementId);
    if (!current.ok) return current;

    const now = this.clock.nowIso();
    return this.propose({
      workspaceRef,
      entityKind: 'ELEMENT',
      entityId: elementId,
      type: 'RENAME',
      // The before/after pair is what makes the change reviewable and undoable.
      before: { displayName: current.value.displayName },
      after: {
        displayName: displayName.trim(),
        // Renaming regenerates the code identifier, or generated Page Objects
        // would keep the old property name.
        systemName: toSystemName(displayName),
        displayNameSource: 'USER',
        namingHistory: [
          ...current.value.namingHistory,
          { displayName: displayName.trim(), source: 'USER' as const, changedAt: now },
        ],
      },
      proposedBy: 'USER',
    });
  }

  private async updateDescription(
    command: RawLiveCommand,
    workspaceRef: string,
  ): Promise<Result<RegistryCommandResult>> {
    const payload = payloadOf<{ elementId?: string; description?: string }>(command);
    if (!payload.ok) return payload;

    const { elementId, description } = payload.value;
    if (elementId === undefined || description === undefined) {
      return err(
        RunnerErrors.validationFailed('A description update needs an elementId and a description.'),
      );
    }

    const current = await this.registry.findElementById(workspaceRef, elementId);
    if (!current.ok) return current;

    return this.propose({
      workspaceRef,
      entityKind: 'ELEMENT',
      entityId: elementId,
      type: 'DESCRIPTION_UPDATE',
      before: { description: current.value.description },
      after: { description },
      proposedBy: 'USER',
    });
  }

  /**
   * Proposes a new primary selector, keeping the old one as history.
   *
   * The replaced selector is pushed onto `selectorHistory` rather than
   * discarded: knowing what a selector used to be is what lets a reviewer judge
   * whether a heal was right, and what healing compares against next time.
   */
  private async updateSelector(
    command: RawLiveCommand,
    workspaceRef: string,
  ): Promise<Result<RegistryCommandResult>> {
    const payload = payloadOf<{ elementId?: string; selector?: SelectorDefinition }>(command);
    if (!payload.ok) return payload;

    const { elementId, selector } = payload.value;
    if (elementId === undefined || selector === undefined) {
      return err(
        RunnerErrors.validationFailed('A selector update needs an elementId and a selector.'),
      );
    }

    const guard = validateSelectorDefinition(selector);
    if (!guard.valid) {
      return err(
        RunnerErrors.selectorInvalid(
          selector.type,
          guard.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('; '),
        ),
      );
    }

    const current = await this.registry.findElementById(workspaceRef, elementId);
    if (!current.ok) return current;

    return this.propose({
      workspaceRef,
      entityKind: 'ELEMENT',
      entityId: elementId,
      type: 'SELECTOR_UPDATE',
      before: { primarySelector: current.value.primarySelector },
      after: {
        primarySelector: selector,
        selectorHistory: [
          ...current.value.selectorHistory,
          {
            selector: current.value.primarySelector,
            replacedAt: this.clock.nowIso(),
            replacedBy: 'USER' as const,
            reason: 'replaced from the live selector editor',
          },
        ],
      },
      proposedBy: 'USER',
    });
  }

  /**
   * Confirms a pending modification, applying it and writing its revision.
   *
   * A confirmation from a live session also marks the element user-confirmed:
   * a person looked at the real page and approved the mapping, which is the
   * strongest signal the confidence policy has.
   */
  private async confirm(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<RegistryCommandResult>> {
    const payload = payloadOf<{ modificationId?: string }>(command);
    if (!payload.ok) return payload;

    const modificationId = payload.value.modificationId;
    if (modificationId === undefined) {
      return err(RunnerErrors.validationFailed('A confirmation needs a modificationId.'));
    }

    const modification = await this.registry.getModification(modificationId);
    if (!modification.ok) return modification;

    if (modification.value.workspaceRef !== context.session.workspaceRef) {
      // Scoped like every other registry read: a modification from another
      // workspace reads as absent rather than forbidden.
      return err(RunnerErrors.registryEntityNotFound('modification', modificationId));
    }

    const confirmed = await this.registry.confirmModification(
      modificationId,
      `live-session:${context.session.id}`,
    );
    if (!confirmed.ok) return confirmed;

    return ok({
      modificationId,
      status: 'CONFIRMED',
      type: modification.value.type,
      entityId: confirmed.value.entityId,
      revision: confirmed.value.version,
    });
  }

  private async reject(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<RegistryCommandResult>> {
    const payload = payloadOf<{ modificationId?: string; reason?: string }>(command);
    if (!payload.ok) return payload;

    const modificationId = payload.value.modificationId;
    if (modificationId === undefined) {
      return err(RunnerErrors.validationFailed('A rejection needs a modificationId.'));
    }

    const modification = await this.registry.getModification(modificationId);
    if (!modification.ok) return modification;

    if (modification.value.workspaceRef !== context.session.workspaceRef) {
      return err(RunnerErrors.registryEntityNotFound('modification', modificationId));
    }

    const rejected = await this.registry.rejectModification(
      modificationId,
      `live-session:${context.session.id}`,
      payload.value.reason,
    );
    if (!rejected.ok) return rejected;

    return ok({
      modificationId,
      status: 'REJECTED',
      type: rejected.value.type,
    });
  }

  private async propose(
    input: Parameters<RegistryPort['proposeModification']>[0],
  ): Promise<Result<RegistryCommandResult>> {
    const proposed = await this.registry.proposeModification(input);
    if (!proposed.ok) return proposed;

    return ok({
      modificationId: proposed.value.id,
      status: proposed.value.status,
      type: proposed.value.type,
      ...(proposed.value.entityId === undefined ? {} : { entityId: proposed.value.entityId }),
    });
  }
}
