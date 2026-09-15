import type { BrowserPort } from '@runner/application';
import type { PageState, StateChange } from '@runner/domain';
import { diffPageState } from '@runner/domain';
import { ok, type Result } from '@runner/shared';

/**
 * Watches what an action actually did (blueprint section 23).
 *
 * An action that "succeeded" but changed nothing is a common and quiet failure
 * mode — a click on a disabled-looking button, a submit that silently
 * validated. Capturing before/after state turns that into something the
 * timeline can show and the registry learner can react to.
 */
export class StateObserver {
  async capture(browser: BrowserPort): Promise<Result<PageState>> {
    return browser.getCurrentState();
  }

  async observe(
    browser: BrowserPort,
    before: PageState,
  ): Promise<Result<StateChange>> {
    const after = await browser.getCurrentState();
    if (!after.ok) return after;
    return ok(diffPageState(before, after.value));
  }
}
