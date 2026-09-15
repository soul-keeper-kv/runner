import type { BrowserNavigatePayload, LiveCommandType } from '@runner/live-protocol';
import type { RawLiveCommand } from '@runner/live-protocol';
import { ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';

/**
 * Browser navigation commands for the live workspace.
 *
 * Note what this capability does *not* do: it never receives a Playwright page.
 * It receives a BrowserPort, which is what keeps the live UI one further step
 * removed from the automation engine (blueprint section 3.1).
 */
export class BrowserCapability implements LiveCapability<{ url: string }> {
  readonly type = 'browser' as const;
  readonly handles: readonly LiveCommandType[] = [
    'browser.navigate',
    'browser.back',
    'browser.forward',
    'browser.refresh',
  ];

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<{ url: string }>> {
    const { browser } = context;

    switch (command.type as LiveCommandType) {
      case 'browser.navigate': {
        const payload = payloadOf<BrowserNavigatePayload>(command);
        if (!payload.ok) return payload;

        const navigated = await browser.goto(payload.value.url, {
          ...(payload.value.waitUntil === undefined
            ? {}
            : { waitUntil: payload.value.waitUntil }),
        });
        if (!navigated.ok) return navigated;
        break;
      }
      case 'browser.back': {
        const result = await browser.back();
        if (!result.ok) return result;
        break;
      }
      case 'browser.forward': {
        const result = await browser.forward();
        if (!result.ok) return result;
        break;
      }
      case 'browser.refresh': {
        const result = await browser.reload();
        if (!result.ok) return result;
        break;
      }
      default:
        break;
    }

    const state = await browser.getCurrentState();
    if (!state.ok) return state;
    return ok({ url: state.value.url });
  }
}
