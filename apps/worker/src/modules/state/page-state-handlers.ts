import type { BrowserManagerPort } from '@runner/application';
import type { ExecutionContext, Precondition } from '@runner/domain';
import { urlMatchesPattern } from '@runner/domain';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';
import type { StateHandler } from './precondition-engine.js';
import type { ElementResolver } from '../resolver/element-resolver.js';

/**
 * The precondition handlers that read the page (blueprint sections 19-21).
 *
 * These four complete the set the contract declares. What matters about them is
 * the honesty of their `prepare`:
 *
 *   urlMatches     verify only — the Runner must not navigate on its own
 *   elementVisible verify only — making an element appear is app-specific
 *   uiState        verify only — nothing populates application state yet
 *   entityState    not implemented — needs an API/fixture seeding port
 *
 * A handler that "prepared" a state it cannot actually reach would turn a
 * missing fixture into a passing test, which is the exact failure the
 * PRECONDITION_FAILED / TEST_FAILED split exists to prevent. Where preparation
 * is impossible, these say so and let the engine fail the step as a precondition
 * failure — the run is not blamed on the application under test.
 */

/**
 * The URL must already match before the step runs.
 *
 * Deliberately not preparable. A Runner that navigated to satisfy this would
 * skip whatever the test was about to do to *get* there — the precondition
 * exists to assert the starting point, not to shortcut to it.
 */
export class UrlMatchesHandler implements StateHandler {
  readonly type = 'urlMatches';

  constructor(
    private readonly browsers: BrowserManagerPort,
    private readonly logger: Logger,
  ) {}

  canHandle(precondition: Precondition): boolean {
    return precondition.type === 'urlMatches';
  }

  async isSatisfied(
    precondition: Precondition,
    context: ExecutionContext,
  ): Promise<Result<boolean>> {
    const pattern = precondition.urlPattern;
    if (pattern === undefined || pattern.length === 0) {
      return err(
        RunnerErrors.preconditionFailed(
          'urlMatches',
          'A urlMatches precondition must carry a urlPattern.',
        ),
      );
    }

    const browser = this.browsers.get(context.browserSessionId);
    if (browser === undefined) {
      return err(browserGoneError('urlMatches', context.browserSessionId));
    }

    const state = await browser.getCurrentState();
    if (!state.ok) return state;

    const matched = urlMatchesPattern(state.value.url, pattern);
    this.logger.debug('Checked a url precondition', {
      runId: context.executionId,
      matched,
    });
    return ok(matched);
  }

  async prepare(
    precondition: Precondition,
    context: ExecutionContext,
  ): Promise<Result<void>> {
    const browser = this.browsers.get(context.browserSessionId);
    const current = browser === undefined ? undefined : await browser.getCurrentState();

    return err(
      RunnerErrors.preconditionFailed(
        'urlMatches',
        `The page is not at "${precondition.urlPattern ?? ''}" and the Runner will not navigate to satisfy a precondition — add an explicit goto step instead.`,
        {
          urlPattern: precondition.urlPattern,
          ...(current !== undefined && current.ok ? { actualUrl: current.value.url } : {}),
        },
      ),
    );
  }
}

/**
 * An element must already be on screen before the step runs.
 *
 * Also verify-only: making an element appear means clicking something, and which
 * something is a property of the application, not of the Runner. Declaring the
 * step that reveals it is the caller's job.
 */
export class ElementVisibleHandler implements StateHandler {
  readonly type = 'elementVisible';

  constructor(
    private readonly browsers: BrowserManagerPort,
    private readonly resolver: ElementResolver,
    private readonly logger: Logger,
  ) {}

  canHandle(precondition: Precondition): boolean {
    return precondition.type === 'elementVisible';
  }

  async isSatisfied(
    precondition: Precondition,
    context: ExecutionContext,
  ): Promise<Result<boolean>> {
    const target = precondition.target;
    if (target === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'elementVisible',
          'An elementVisible precondition must carry a target.',
        ),
      );
    }

    const browser = this.browsers.get(context.browserSessionId);
    if (browser === undefined) {
      return err(browserGoneError('elementVisible', context.browserSessionId));
    }

    const snapshot = await browser.inspect({ interactableOnly: false });
    if (!snapshot.ok) return snapshot;

    const resolved = await this.resolver.resolve({
      intent: target,
      snapshot: snapshot.value,
      browser,
      // Visibility is the question being asked, so the element is not required
      // to be interactable — a visible but disabled control satisfies this.
      requireInteractable: false,
    });

    if (!resolved.ok) {
      // Not found is a legitimate "not satisfied", not an error: the element may
      // simply not be on screen yet, which is what the caller is asking about.
      this.logger.debug('Element for a precondition is not present', {
        runId: context.executionId,
        errorCode: resolved.error.code,
      });
      return ok(false);
    }

    const probed = await browser.probe({ selector: resolved.value.locator });
    if (!probed.ok) return ok(false);

    return ok(probed.value.matchCount > 0 && probed.value.visible);
  }

  prepare(precondition: Precondition, _context: ExecutionContext): Promise<Result<void>> {
    const described =
      precondition.target?.name ?? precondition.target?.description ?? 'the target element';

    return Promise.resolve(
      err(
        RunnerErrors.preconditionFailed(
          'elementVisible',
          `${described} is not visible, and revealing it requires an application-specific action — add the step that opens it.`,
          { target: precondition.target },
        ),
      ),
    );
  }
}

/**
 * A named UI state must hold, e.g. `CART_DRAWER_OPEN`.
 *
 * Verified against the state the execution context is *known* to be in. Nothing
 * populates that list yet — the application state graph is blueprint section 21
 * and deliberately later than the MVP — so this handler currently reports
 * unsatisfied and explains why rather than guessing from the page. Inferring a
 * named state from page content is how a Runner decides a drawer is open
 * because a matching class name appeared somewhere.
 */
export class UiStateHandler implements StateHandler {
  readonly type = 'uiState';

  canHandle(precondition: Precondition): boolean {
    return precondition.type === 'uiState';
  }

  isSatisfied(
    precondition: Precondition,
    context: ExecutionContext,
  ): Promise<Result<boolean>> {
    const state = precondition.state;
    if (state === undefined || state.length === 0) {
      return Promise.resolve(
        err(
          RunnerErrors.preconditionFailed(
            'uiState',
            'A uiState precondition must carry a state.',
          ),
        ),
      );
    }

    return Promise.resolve(ok(context.applicationState.includes(state)));
  }

  prepare(precondition: Precondition, _context: ExecutionContext): Promise<Result<void>> {
    return Promise.resolve(
      err(
        RunnerErrors.capabilityNotImplemented(
          `Preparing UI state "${precondition.state ?? ''}" (the application state graph is Phase 21 work; declare explicit steps instead)`,
        ),
      ),
    );
  }
}

/**
 * A domain entity must be in a given state, e.g. an ORDER that is SUBMITTED.
 *
 * Not implemented, and saying so is the whole value of this handler. Reaching
 * entity state needs a seeding route — an API call, a fixture, a database seed
 * (`SETUP_METHOD_PRIORITY` in the domain records the preference order) — and no
 * such port exists yet. Returning "satisfied" would let a test run against
 * whatever state the database happened to be in and report a green result that
 * means nothing.
 */
export class EntityStateHandler implements StateHandler {
  readonly type = 'entityState';

  canHandle(precondition: Precondition): boolean {
    return precondition.type === 'entityState';
  }

  isSatisfied(precondition: Precondition): Promise<Result<boolean>> {
    // Never claim satisfaction for a state the Runner cannot observe.
    return Promise.resolve(
      err(
        RunnerErrors.capabilityNotImplemented(
          `Entity state preconditions (${precondition.entity ?? 'entity'} = ${precondition.state ?? 'state'}) need an entity seeding port, which is not implemented`,
        ),
      ),
    );
  }

  prepare(precondition: Precondition): Promise<Result<void>> {
    return Promise.resolve(
      err(
        RunnerErrors.capabilityNotImplemented(
          `Preparing entity state (${precondition.entity ?? 'entity'} = ${precondition.state ?? 'state'}) needs an API, fixture or DB seeding port`,
        ),
      ),
    );
  }
}

function browserGoneError(type: string, sessionId: string): ReturnType<typeof RunnerErrors.preconditionFailed> {
  return RunnerErrors.preconditionFailed(
    type,
    `Browser session "${sessionId}" is no longer available.`,
    { browserSessionId: sessionId },
  );
}
