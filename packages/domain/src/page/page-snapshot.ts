import type { ElementCandidate } from '../element/element-candidate.js';

/**
 * The structured model of a page at a moment in time (blueprint section 10).
 *
 * Deliberately not the HTML. A snapshot is small enough to log, diff, store as
 * evidence, and — much later — hand a shortlist of to an LLM, none of which is
 * true of raw markup.
 */

export interface FrameSnapshot {
  readonly frameId: string;
  readonly url: string;
  readonly name?: string;
  readonly parentFrameId?: string;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title?: string;
  readonly capturedAt: string;
  readonly elements: readonly ElementCandidate[];
  readonly frames: readonly FrameSnapshot[];
  /** Page-level signals, e.g. detected framework, auth state, route name. */
  readonly pageMetadata: Readonly<Record<string, unknown>>;
  /** Registry page this snapshot was matched to, when one applies. */
  readonly matchedPageId?: string;
  /** Cheap change-detection hash over structure, not content. */
  readonly domFingerprint?: string;
}

/** Observable state used to decide whether an action changed anything. */
export interface PageState {
  readonly url: string;
  readonly title?: string;
  readonly domFingerprint?: string;
  readonly frameCount: number;
  readonly hasOpenDialog: boolean;
  readonly capturedAt: string;
}

/** What changed between two states (blueprint section 23). */
export interface StateChange {
  readonly urlChanged: boolean;
  readonly domChanged: boolean;
  readonly frameCountChanged: boolean;
  readonly dialogOpened: boolean;
  readonly before: PageState;
  readonly after: PageState;
}

export function diffPageState(before: PageState, after: PageState): StateChange {
  return {
    urlChanged: before.url !== after.url,
    domChanged:
      before.domFingerprint !== undefined &&
      after.domFingerprint !== undefined &&
      before.domFingerprint !== after.domFingerprint,
    frameCountChanged: before.frameCount !== after.frameCount,
    dialogOpened: !before.hasOpenDialog && after.hasOpenDialog,
    before,
    after,
  };
}

export function hasAnyChange(change: StateChange): boolean {
  return (
    change.urlChanged || change.domChanged || change.frameCountChanged || change.dialogOpened
  );
}

export function findCandidate(
  snapshot: PageSnapshot,
  runtimeId: string,
): ElementCandidate | undefined {
  return snapshot.elements.find((element) => element.runtimeId === runtimeId);
}
