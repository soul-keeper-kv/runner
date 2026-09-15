import type { BrowserPort, InspectOptions } from '@runner/application';
import type { PageSnapshot } from '@runner/domain';
import type { Result } from '@runner/shared';

/**
 * Builds the structured page model (blueprint section 10).
 *
 * A thin seam over BrowserPort.inspect. It exists so that snapshot caching,
 * frame merging and shadow-DOM traversal can be added in one place later
 * without the resolver learning about any of it.
 */
export class DomInspector {
  constructor(private readonly defaultOptions: InspectOptions = { interactableOnly: true }) {}

  async inspect(browser: BrowserPort, options?: InspectOptions): Promise<Result<PageSnapshot>> {
    return browser.inspect({ ...this.defaultOptions, ...options });
  }
}
