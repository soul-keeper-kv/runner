import type { LiveCommandType, RawLiveCommand, ViewStartPayload } from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';

/**
 * Streams the live page as frames (blueprint section 37, the seam the state
 * capability's comment anticipated).
 *
 * `state.snapshot` answers one request with one picture, which is the right
 * shape for "is this the element I meant?" and the wrong shape for watching a
 * page. Between requests the preview is silently out of date, and asking on a
 * timer tops out at a few frames a second once each has been encoded, base64'd
 * and put on a socket.
 *
 * This capability turns the engine's own stream on instead: frames are emitted
 * when the page repaints and published as `browser.frame` events, so they reach
 * the workspace without a command per frame.
 *
 * Note what it does not do: it never produces the frames itself and never holds
 * a page. It asks `BrowserPort` to stream and forwards what arrives, so the
 * mechanism — CDP screencast today, something else later — stays behind the
 * port like every other browser concern.
 */
export class ViewCapability implements LiveCapability<{ streaming: boolean }> {
  readonly type = 'view' as const;
  readonly handles: readonly LiveCommandType[] = ['view.start', 'view.stop'];

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<{ streaming: boolean }>> {
    const { browser, logger, publishEvent } = context;

    if (command.type === 'view.stop') {
      const stopped = await browser.stopScreencast();
      if (!stopped.ok) return stopped;
      return ok({ streaming: false });
    }

    /*
     * Refused rather than silently accepted when nothing can carry the frames.
     *
     * Without a cross-process bus the worker would stream into a void: the
     * client would see a successful `view.start`, no frames, and no reason —
     * which is the failure mode this whole area keeps producing. Saying so
     * lets the workspace fall back to refreshing on a timer.
     */
    if (publishEvent === undefined) {
      return err(
        RunnerErrors.capabilityNotImplemented(
          'Live view streaming (requires REDIS_URL so frames can reach the API)',
        ),
      );
    }

    const payload = payloadOf<ViewStartPayload>(command);
    const options: ViewStartPayload = payload.ok ? payload.value : {};

    const started = await browser.startScreencast(
      (frame) => {
        publishEvent({ type: 'browser.frame', payload: frame });
      },
      {
        ...(options.format === undefined ? {} : { format: options.format }),
        ...(options.quality === undefined ? {} : { quality: options.quality }),
        ...(options.everyNthFrame === undefined
          ? {}
          : { everyNthFrame: options.everyNthFrame }),
      },
    );

    if (!started.ok) return started;

    logger.debug('Live view streaming', { format: options.format ?? 'jpeg' });
    return ok({ streaming: true });
  }
}
