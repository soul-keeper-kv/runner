import type { ScrollOptions, ScrollPosition } from '@runner/application';
import type {
  BrowserNavigatePayload,
  BrowserScrollPayload,
  LiveCommandType,
} from '@runner/live-protocol';
import type { RawLiveCommand } from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';
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
export class BrowserCapability
  implements LiveCapability<{ url: string; scroll?: ScrollPosition }>
{
  readonly type = 'browser' as const;
  readonly handles: readonly LiveCommandType[] = [
    'browser.navigate',
    'browser.back',
    'browser.forward',
    'browser.refresh',
    'browser.scroll',
  ];

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<{ url: string; scroll?: ScrollPosition }>> {
    const { browser } = context;
    let scrolled: ScrollPosition | undefined;

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
      /*
       * Scrolling belongs here rather than beside the element commands because
       * it moves the *page*, not an element — the same category as navigating.
       *
       * It exists because every box the Runner reports is in viewport
       * coordinates and the frame is a picture of the viewport: content below
       * the fold is scanned and selectable but cannot be seen or clicked on,
       * since a click on the frame only maps to a point the viewport holds.
       */
      case 'browser.scroll': {
        const payload = payloadOf<BrowserScrollPayload>(command);
        if (!payload.ok) return payload;

        const options = toScrollOptions(payload.value);
        if (!options.ok) return options;

        const result = await browser.scroll(options.value);
        if (!result.ok) return result;
        scrolled = result.value;
        break;
      }
      default:
        break;
    }

    const state = await browser.getCurrentState();
    if (!state.ok) return state;
    return ok({
      url: state.value.url,
      ...(scrolled === undefined ? {} : { scroll: scrolled }),
    });
  }
}

/**
 * Turns the wire payload into port options, refusing one that says nothing.
 *
 * An empty payload is rejected rather than treated as a no-op scroll: a client
 * that meant to send an offset and sent `{}` would otherwise get a successful
 * result and an unmoved page, which reads as "scrolling is broken" rather than
 * as a malformed command.
 *
 * `runtimeId` is accepted by the schema but cannot be honoured here — it is
 * local to one snapshot and the adapter has no index of them — so it is named
 * as unsupported instead of silently ignored, which would scroll nowhere and
 * report success.
 */
function toScrollOptions(payload: BrowserScrollPayload): Result<ScrollOptions> {
  if (payload.target !== undefined) {
    if (payload.target.selector === undefined) {
      return err(
        RunnerErrors.validationFailed(
          payload.target.runtimeId === undefined
            ? 'browser.scroll target needs a selector.'
            : 'browser.scroll cannot scroll to a runtimeId; send the element as a selector.',
        ),
      );
    }

    return ok({
      target: { selector: payload.target.selector },
      ...(payload.target.block === undefined ? {} : { block: payload.target.block }),
      ...(payload.behavior === undefined ? {} : { behavior: payload.behavior }),
    });
  }

  if (payload.to !== undefined) {
    return ok({
      to: payload.to,
      ...(payload.behavior === undefined ? {} : { behavior: payload.behavior }),
    });
  }

  if (payload.by !== undefined) {
    return ok({
      by: payload.by,
      ...(payload.behavior === undefined ? {} : { behavior: payload.behavior }),
    });
  }

  return err(
    RunnerErrors.validationFailed('browser.scroll needs one of by, to or target.'),
  );
}
