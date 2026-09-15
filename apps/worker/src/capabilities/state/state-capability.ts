import type { ElementCandidate } from '@runner/domain';
import type {
  BrowserFramePayload,
  LiveCommandType,
  RawLiveCommand,
  StateSnapshotPayload,
} from '@runner/live-protocol';
import { err, ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';

/**
 * Page state and live preview (blueprint sections 32 and 37).
 *
 * This is what lets the workspace *see* the page it is driving. The MVP is a
 * screenshot plus bounding boxes rather than a streamed video: it needs no
 * extra protocol, it works through the same `BrowserPort` every other
 * capability uses, and a still frame is enough to answer the question a user
 * actually has — "is this the element I meant?".
 *
 * `LiveViewProvider` is deliberately left as a later seam. CDP screencast and
 * WebRTC replace how a frame is produced without changing this command, so the
 * UI must position highlights from the returned boxes rather than by converting
 * a semantic locator back into CSS.
 */

/** The result of `state.snapshot`. */
export interface LiveStateSnapshot {
  readonly url: string;
  readonly title?: string;
  readonly frameCount: number;
  readonly hasOpenDialog: boolean;
  readonly capturedAt: string;
  /** Present unless the caller opted out, or the page could not be captured. */
  readonly frame?: BrowserFramePayload;
  /** Present only when explicitly requested; a full page is ~100 entries. */
  readonly candidates?: readonly LiveCandidateSummary[];
  readonly candidateCount?: number;
}

/**
 * A candidate reduced to what an overlay needs.
 *
 * Deliberately not the whole `ElementCandidate`: attributes and DOM context are
 * resolution inputs, and shipping them to a browser tab would put internal
 * model detail on the wire for no benefit to the view.
 */
export interface LiveCandidateSummary {
  readonly runtimeId: string;
  readonly tag: string;
  readonly role?: string;
  readonly label?: string;
  readonly interactable: boolean;
  readonly bbox?: { x: number; y: number; width: number; height: number };
}

/** Enough candidates to overlay a page, few enough to keep a frame small. */
const MAX_CANDIDATES = 150;

/** Matches the runtime's default launch viewport. */
export const DEFAULT_FRAME_VIEWPORT = { width: 1280, height: 720 } as const;

export class StateCapability implements LiveCapability<LiveStateSnapshot> {
  readonly type = 'state' as const;
  readonly handles: readonly LiveCommandType[] = ['state.snapshot', 'state.inspect'];

  /**
   * The viewport live browsers are launched with.
   *
   * Passed in rather than read from the session: the viewport is a property of
   * how the runtime launched the browser, and a frame whose declared size does
   * not match the coordinate space of `probe`'s bounding boxes would put every
   * highlight in the wrong place.
   */
  constructor(
    private readonly viewport: { readonly width: number; readonly height: number } =
      DEFAULT_FRAME_VIEWPORT,
  ) {}

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<LiveStateSnapshot>> {
    const { browser } = context;

    // `state.inspect` is `state.snapshot` with candidates and without a frame:
    // one path, so the two can never disagree about what the page contains.
    const isInspect = command.type === 'state.inspect';
    const payload = payloadOf<StateSnapshotPayload>(command);
    const options: StateSnapshotPayload = payload.ok ? payload.value : {};

    const includeScreenshot = isInspect
      ? (options.includeScreenshot ?? false)
      : (options.includeScreenshot ?? true);
    const includeCandidates = isInspect
      ? (options.includeCandidates ?? true)
      : (options.includeCandidates ?? false);

    const state = await browser.getCurrentState();
    if (!state.ok) return state;

    const snapshot: Record<string, unknown> = {
      url: state.value.url,
      frameCount: state.value.frameCount,
      hasOpenDialog: state.value.hasOpenDialog,
      capturedAt: state.value.capturedAt,
    };
    if (state.value.title !== undefined) snapshot.title = state.value.title;

    if (includeScreenshot) {
      const frame = await this.captureFrame(context);
      if (frame !== undefined) snapshot.frame = frame;
    }

    // Normalized once: an empty string is "no root", not a selector that
    // matches nothing, and both branches below have to agree on which it is.
    const rootSelector =
      options.rootSelector === undefined || options.rootSelector.length === 0
        ? undefined
        : options.rootSelector;

    if (includeCandidates) {
      const inspected = await browser.inspect({
        interactableOnly: true,
        ...(rootSelector === undefined ? {} : { rootSelector }),
      });
      // A page whose candidates cannot be read still has a URL and a frame
      // worth showing, so this degrades rather than failing the command.
      if (inspected.ok) {
        snapshot.candidateCount = inspected.value.elements.length;
        snapshot.candidates = inspected.value.elements
          .slice(0, MAX_CANDIDATES)
          .map(toSummary);
      } else if (rootSelector !== undefined) {
        /*
         * Except when the caller named a root.
         *
         * Degrading is right for a transient read failure — the frame is still
         * worth seeing. It is wrong for a root that does not match: that is the
         * caller's own selector being incorrect, and a successful snapshot with
         * no candidates is indistinguishable from "this container is empty".
         * The workspace showed neither a count nor a reason, which is exactly
         * the silent mis-scoping a root is supposed to make impossible.
         */
        context.logger.warn('Snapshot root selector matched nothing', {
          rootSelector,
          errorCode: inspected.error.code,
        });
        return err(inspected.error);
      } else {
        context.logger.debug('Snapshot could not read page candidates', {
          errorCode: inspected.error.code,
        });
      }
    }

    return ok(snapshot as unknown as LiveStateSnapshot);
  }

  /**
   * Captures the viewport as a base64 frame.
   *
   * A failed screenshot is not a failed command: a page mid-navigation cannot
   * be captured, and returning the URL and state without a picture is far more
   * useful to the workspace than an error.
   */
  private async captureFrame(
    context: LiveSessionContext,
  ): Promise<BrowserFramePayload | undefined> {
    const shot = await context.browser.screenshot({ format: 'png', fullPage: false });
    if (!shot.ok) {
      context.logger.debug('Snapshot could not capture a frame', {
        errorCode: shot.error.code,
      });
      return undefined;
    }

    return {
      format: 'png',
      data: shot.value.toString('base64'),
      // The viewport is the frame's own coordinate space, and it is what the
      // bounding boxes from `probe` are relative to. The UI scales the image to
      // its container and applies the same factor to every box, so these are
      // reported rather than left for the client to guess.
      width: this.viewport.width,
      height: this.viewport.height,
      capturedAt: new Date().toISOString(),
    };
  }
}

function toSummary(candidate: ElementCandidate): LiveCandidateSummary {
  const summary: Record<string, unknown> = {
    runtimeId: candidate.runtimeId,
    tag: candidate.tag,
    interactable: candidate.interactable,
  };

  if (candidate.role !== undefined) summary.role = candidate.role;
  const label = candidate.accessibleName ?? candidate.text;
  if (label !== undefined && label.trim().length > 0) summary.label = label;
  if (candidate.bbox !== undefined) summary.bbox = candidate.bbox;

  return summary as unknown as LiveCandidateSummary;
}
