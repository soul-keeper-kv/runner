import type { InspectionRecord, InspectionStorePort } from '@runner/application';
import { RunnerErrors, err, ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { DomInspector } from '../../modules/inspector/dom-inspector.js';
import { extractPage } from '../../modules/inspector/field-extractor.js';
import { projectRegistry } from '../../modules/inspector/registry-projector.js';
import type { LocatorGenerator } from '../../modules/locator/locator-generator.js';
import type { SessionManager } from '../../modules/session/session-manager.js';

/**
 * Inspects one page and records what a caller would have to fill in.
 *
 * The pipeline is navigate -> settle -> inspect -> extract. It drives nothing:
 * no click, no fill, no assertion, so there is no verdict — only findings or a
 * reason they could not be produced.
 *
 * A page that will not load is `PAGE_NOT_REACHABLE`, whose kind is
 * PRECONDITION_FAILURE. That distinction is the point of blueprint rule 10: a
 * caller must be able to tell "your URL or network is wrong" from "the Runner
 * broke", and neither reads as a failing test.
 */

export interface RunInspectionDeps {
  readonly store: InspectionStorePort;
  readonly sessions: SessionManager;
  readonly inspector: DomInspector;
  readonly generator: LocatorGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export async function runInspection(
  deps: RunInspectionDeps,
  record: InspectionRecord,
): Promise<Result<void>> {
  const logger = deps.logger.child({ inspectionId: record.inspectionId });
  const options = record.request.options ?? {};

  await deps.store.updateStatus(record.inspectionId, 'RUNNING', {
    startedAt: deps.clock.nowIso(),
  });

  // An inspection may target a page behind a login, in which case a stored
  // session is applied. It never performs a login itself: nothing is driving a
  // form, so a profile with no stored session inspects unauthenticated and says
  // so rather than failing.
  const authProfileRef = record.request.authProfileRef;

  const acquired = await deps.sessions.acquireForInspection(
    {
      headless: true,
      viewport: options.viewport ?? { width: 1280, height: 800 },
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.defaultTimeoutMs }),
    },
    authProfileRef === undefined
      ? undefined
      : { workspaceRef: record.request.workspaceRef, profileRef: authProfileRef },
  );

  if (!acquired.ok) {
    await fail(deps, record.inspectionId, acquired.error);
    return acquired;
  }

  const browser = acquired.value;

  try {
    const navigated = await browser.goto(record.requestedUrl, {
      waitUntil: options.waitUntil ?? 'domcontentloaded',
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.defaultTimeoutMs }),
    });

    if (!navigated.ok) {
      await fail(deps, record.inspectionId, navigated.error);
      return navigated;
    }

    // Many login and checkout forms render after hydration, so the snapshot is
    // taken after an optional settle rather than the instant navigation
    // resolves — otherwise the field list comes back empty for exactly the
    // pages callers most often submit.
    if (options.waitForMs !== undefined && options.waitForMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.waitForMs));
    }

    const snapshot = await deps.inspector.inspect(browser, { interactableOnly: true });
    if (!snapshot.ok) {
      await fail(deps, record.inspectionId, snapshot.error);
      return snapshot;
    }

    const extracted = extractPage(snapshot.value, deps.generator, {
      ...(options.includeNonInputControls === undefined
        ? {}
        : { includeNonInputControls: options.includeNonInputControls }),
    });

    // Both projections run over the same snapshot: the registry entries are
    // what Page Object generation consumes, while `fields` stays as the short
    // answer to "what do I have to fill in?".
    const projected = projectRegistry(snapshot.value, deps.generator);

    const updated = await deps.store.updateStatus(record.inspectionId, 'COMPLETED', {
      completedAt: deps.clock.nowIso(),
      findings: {
        url: snapshot.value.url,
        ...(snapshot.value.title === undefined ? {} : { title: snapshot.value.title }),
        page: projected.page,
        elements: projected.elements,
        fields: extracted.fields,
        ...(extracted.submit === undefined ? {} : { submit: extracted.submit }),
        ...(extracted.controls === undefined ? {} : { controls: extracted.controls }),
      },
    });
    if (!updated.ok) return updated;

    logger.info('Inspection completed', {
      url: snapshot.value.url,
      elements: projected.elements.length,
      fields: extracted.fields.length,
      hasSubmit: extracted.submit !== undefined,
    });
    return ok(undefined);
  } catch (cause) {
    const error = RunnerErrors.internal('Page inspection failed unexpectedly.', cause);
    await fail(deps, record.inspectionId, error);
    return err(error);
  } finally {
    await deps.sessions.release(browser.sessionId);
  }
}

async function fail(
  deps: RunInspectionDeps,
  inspectionId: string,
  error: { toJSON(): unknown; code: string },
): Promise<void> {
  await deps.store.updateStatus(inspectionId, 'FAILED', {
    completedAt: deps.clock.nowIso(),
    error: error.toJSON(),
  });
  deps.logger.warn('Inspection failed', { inspectionId, errorCode: error.code });
}
