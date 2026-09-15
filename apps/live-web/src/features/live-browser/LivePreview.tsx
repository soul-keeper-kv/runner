import { useState } from 'react';
import { useLiveSessionStore } from '../../stores/live-session-store.js';
import { containedInRegion, type ViewportRect } from '../../lib/registry-export.js';

/**
 * The live browser view (blueprint section 37).
 *
 * A screenshot with boxes drawn over it, not a video stream. That is the MVP
 * on purpose: it answers the question a user actually has while editing a
 * selector — "is this the element I meant?" — and it arrives through the same
 * command protocol as everything else, so replacing it with a CDP screencast
 * later changes how a frame is produced and nothing else.
 *
 * The overlay is positioned from the boxes the worker reports, never by
 * converting a semantic locator back into CSS in the browser. The image is
 * scaled to fit its container and every box is scaled by the same factor, so
 * the highlight lands where the element actually is at any panel width.
 *
 * The frame has two exclusive input modes: a click picks one element, a drag
 * draws a region to scan. Both convert rendered coordinates to the page's
 * viewport through the same inverse of `boxStyle`.
 */
export function LivePreview(): JSX.Element {
  const session = useLiveSessionStore((state) => state.session);
  const snapshot = useLiveSessionStore((state) => state.snapshot);
  const preview = useLiveSessionStore((state) => state.lastPreview);
  const refresh = useLiveSessionStore((state) => state.refreshSnapshot);
  const showCandidates = useLiveSessionStore((state) => state.showCandidates);
  const toggleCandidates = useLiveSessionStore((state) => state.toggleCandidates);
  const picking = useLiveSessionStore((state) => state.picking);
  const togglePicking = useLiveSessionStore((state) => state.togglePicking);
  const pickAt = useLiveSessionStore((state) => state.pickAt);
  const picked = useLiveSessionStore((state) => state.picked);
  const selectingRegion = useLiveSessionStore((state) => state.selectingRegion);
  const toggleRegionSelect = useLiveSessionStore((state) => state.toggleRegionSelect);
  const region = useLiveSessionStore((state) => state.region);
  const setRegion = useLiveSessionStore((state) => state.setRegion);
  const clearRegion = useLiveSessionStore((state) => state.clearRegion);
  const scan = useLiveSessionStore((state) => state.scan);
  const scanned = useLiveSessionStore((state) => state.scanned);
  const scanAll = useLiveSessionStore((state) => state.scanAll);
  const scanRegion = useLiveSessionStore((state) => state.scanRegion);
  const cancelScan = useLiveSessionStore((state) => state.cancelScan);
  const downloadRegistry = useLiveSessionStore((state) => state.downloadRegistry);
  const error = useLiveSessionStore((state) => state.error);
  const scanRoot = useLiveSessionStore((state) => state.scanRoot);
  const setScanRoot = useLiveSessionStore((state) => state.setScanRoot);

  /** The rectangle being dragged right now, in viewport coordinates. */
  const [dragRect, setDragRect] = useState<ViewportRect | undefined>(undefined);

  if (session === undefined) {
    return (
      <section className="panel">
        <h2>Live Preview</h2>
        <p className="muted">Start a live session to see the page.</p>
      </section>
    );
  }

  const frame = snapshot?.frame;
  const scanning = scan?.running === true;

  // Counted here rather than in the store so the labels update as the scan
  // fills elements in, without the store recomputing on every unrelated change.
  const inRegionCount =
    region === undefined
      ? 0
      : (scanned ?? []).filter((element) => containedInRegion(element.bbox, region)).length;

  /** The region as drawn, or the live drag, so the overlay tracks the pointer. */
  const shownRegion = dragRect ?? region;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Live Preview</h2>
        <div className="button-row">
          <button
            type="button"
            className={picking ? 'primary' : undefined}
            onClick={() => togglePicking()}
          >
            {picking ? 'Cancel pick' : 'Pick element'}
          </button>
          {/*
            The region is the answer to "I only need this panel": drawing one
            scopes both the scan and the download, so a dense page does not have
            to be scanned whole and then trimmed by hand.
          */}
          <button
            type="button"
            className={selectingRegion ? 'primary' : undefined}
            onClick={() => toggleRegionSelect()}
          >
            {selectingRegion ? 'Cancel region' : region === undefined ? 'Select region' : 'Redraw region'}
          </button>
          {region !== undefined && !selectingRegion && (
            <button type="button" className="link" onClick={() => clearRegion()}>
              Clear region
            </button>
          )}
          <button type="button" onClick={() => toggleCandidates()}>
            {showCandidates ? 'Hide elements' : 'Show elements'}
          </button>
          {/*
            One button for the whole page: list every element, then rank each
            one's selectors. The cancel replaces it while it runs, because a
            scan drives a real browser and the user must be able to stop it.
          */}
          {scanning ? (
            <button type="button" className="danger" onClick={() => cancelScan()}>
              Stop scan
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void scanAll()}>
                Scan all elements
              </button>
              {region !== undefined && (
                <button type="button" className="primary" onClick={() => void scanRegion()}>
                  Scan region
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="secondary"
            disabled={scanned === undefined || scanned.length === 0}
            onClick={() => downloadRegistry('page')}
          >
            Download page JSON
          </button>
          {/*
            A separate button rather than a mode toggle on the one above: which
            scope a download covers is the thing most worth being unambiguous
            about, and a file that silently held the wrong scope is only noticed
            after it has been handed to someone.
          */}
          {region !== undefined && (
            <button
              type="button"
              className="secondary"
              disabled={inRegionCount === 0}
              onClick={() => downloadRegistry('region')}
            >
              Download region JSON{inRegionCount === 0 ? '' : ` (${inRegionCount})`}
            </button>
          )}
          <button type="button" onClick={() => refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {/*
        The scan root, remembered per host.

        The region beside it answers "this part, once"; this answers "this
        application always renders into that panel". It is applied in the
        browser rather than filtered afterwards, so the candidate cap is spent
        inside the container — which is why it reaches elements a region on a
        long page never sees.
      */}
      <div className="field">
        <label htmlFor="scan-root">Scan root (optional)</label>
        <input
          id="scan-root"
          value={scanRoot}
          placeholder='[id^="caris-tab-panel-tab-"]'
          onChange={(event) => setScanRoot(event.target.value)}
        />
        <span className="muted">
          A CSS selector for the container that holds everything worth
          inspecting, remembered for {hostLabel(snapshot?.url) ?? 'this site'}.
          {/*
            The placeholder is a prefix match, not a literal id, because a
            generated id is the case that breaks: #caris-tab-panel-tab-1789…
            carries a timestamp, so a root saved today matches nothing
            tomorrow. `^=` prefix, `$=` suffix, `*=` contains.
          */}{' '}
          For a generated id, match the part that does not change:{' '}
          <code>[id^=&quot;prefix-&quot;]</code>. Empty scans the whole page;
          matching nothing or several elements fails and says how many.
        </span>
      </div>

      {scan !== undefined && (
        <div className="scan-progress">
          <span>
            {scan.done} / {scan.total}
          </span>
          <span className="scan-bar">
            <span
              style={{ width: `${scan.total === 0 ? 0 : (scan.done / scan.total) * 100}%` }}
            />
          </span>
          {scan.scoped === true && <span className="scan-scoped">region</span>}
          {scan.stoppedReason !== undefined && (
            <span className="scan-stopped">
              {scan.stoppedReason === 'cancelled' ? 'stopped' : 'disconnected'} — partial
            </span>
          )}
        </div>
      )}

      {frame === undefined ? (
        <p className="muted">
          No frame yet. Navigate or press Refresh to capture the page.
        </p>
      ) : (
        <>
          <div
            className={`live-frame${picking ? ' picking' : ''}${
              selectingRegion ? ' selecting' : ''
            }`}
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            onClick={picking ? (event) => handlePick(event, frame, pickAt) : undefined}
            /*
             * The drag starts here and finishes on `window`.
             *
             * An earlier version used `setPointerCapture` with React's
             * `onPointerUp` on this div. The box tracked the pointer correctly
             * and then the region was never committed: capturing retargets the
             * pointer stream, and the synthetic pointerup did not reach this
             * handler, so `setRegion` was simply never called. The visible
             * result was the worst kind — a rectangle drawn on screen, no
             * region in the store, and every region button still absent.
             *
             * Listening on `window` cannot have that failure: the drag ends on
             * whatever element the pointer is over, including none of ours, and
             * a release outside the panel still completes the region.
             */
            onPointerDown={
              selectingRegion
                ? (event) => {
                    /*
                     * The frame's rect is measured once, here, and reused for
                     * every event in this drag.
                     *
                     * Re-reading it per event is what broke the first version:
                     * this panel scrolls, `getBoundingClientRect()` is relative
                     * to the viewport, and a rect re-read mid-drag describes the
                     * element at a different scroll offset than the one the
                     * pointer coordinates were produced against. A 98%-wide drag
                     * came out as a 25×14 region pinned at the origin — small
                     * enough to contain nothing, which then read as "the region
                     * scan finds no elements" rather than as a coordinate bug.
                     *
                     * One rect for the whole gesture is also simply correct: a
                     * drag is measured against where the frame was when it
                     * started.
                     */
                    /*
                     * Stops the browser starting a native image drag.
                     *
                     * Without this the frame's <img> begins an HTML5 drag on
                     * pointerdown, and a native drag *takes over the pointer
                     * stream*: the following pointermove and pointerup events
                     * never arrive. The region then stayed frozen at the
                     * zero-size rect pointerdown created — a 98% drag produced
                     * a 26×14 region containing nothing, which surfaced as "no
                     * elements sit inside that region" and looked like a
                     * containment-rule problem rather than a lost gesture.
                     * `draggable={false}` on the image is the other half.
                     */
                    event.preventDefault();

                    const rect = event.currentTarget.getBoundingClientRect();
                    const origin = pointInFrame(event.clientX, event.clientY, rect, frame);
                    if (origin === undefined) return;

                    setDragRect({ x: origin.x, y: origin.y, width: 0, height: 0 });

                    const onMove = (move: PointerEvent): void => {
                      const point = pointInFrame(move.clientX, move.clientY, rect, frame);
                      if (point !== undefined) setDragRect(rectBetween(origin, point));
                    };

                    const onUp = (up: PointerEvent): void => {
                      window.removeEventListener('pointermove', onMove);
                      window.removeEventListener('pointerup', onUp);
                      window.removeEventListener('pointercancel', onUp);
                      setDragRect(undefined);

                      const point = pointInFrame(up.clientX, up.clientY, rect, frame);
                      if (point !== undefined) setRegion(rectBetween(origin, point));
                    };

                    window.addEventListener('pointermove', onMove);
                    window.addEventListener('pointerup', onUp);
                    // A cancelled pointer (a touch turning into a scroll) must
                    // still tear the listeners down, or the next drag would
                    // stack a second pair on the window.
                    window.addEventListener('pointercancel', onUp);
                  }
                : undefined
            }
          >
            <img
              src={`data:image/${frame.format};base64,${frame.data}`}
              alt={`Live page at ${snapshot?.url ?? 'the current URL'}`}
              // A draggable image swallows the region gesture: see the
              // preventDefault comment on onPointerDown above.
              draggable={false}
            />

            {/*
              Percentages rather than pixels: the image is scaled to the panel,
              so a box expressed as a fraction of the viewport stays aligned at
              every width without recomputing on resize.
            */}
            {showCandidates &&
              (snapshot?.candidates ?? []).map((element) =>
                element.bbox === undefined ? null : (
                  <span
                    key={element.runtimeId}
                    className={`live-box candidate${
                      // Marked while a region exists so the user can see what a
                      // region scan would cover *before* paying for it.
                      shownRegion !== undefined && containedInRegion(element.bbox, shownRegion)
                        ? ' in-region'
                        : ''
                    }`}
                    title={`${element.tag}${element.role === undefined ? '' : ` [${element.role}]`} ${element.label ?? ''}`}
                    style={boxStyle(element.bbox, frame)}
                  />
                ),
              )}

            {preview?.bbox !== undefined && preview.matchCount > 0 && (
              <span
                className={`live-box match ${preview.matchCount > 1 ? 'ambiguous' : 'unique'}`}
                style={boxStyle(preview.bbox, frame)}
              />
            )}

            {picked?.bbox !== undefined && (
              <span className="live-box picked" style={boxStyle(picked.bbox, frame)} />
            )}

            {shownRegion !== undefined && (
              <span className="live-box region" style={boxStyle(shownRegion, frame)} />
            )}
          </div>

          <p className="small muted">
            {snapshot?.url}
            {snapshot?.candidateCount !== undefined && (
              <>
                {' · '}
                {snapshot.candidates?.length ?? 0} of {snapshot.candidateCount} elements
              </>
            )}
            {region !== undefined && (
              <>
                {' · '}
                region {Math.round(region.width)}×{Math.round(region.height)}
                {scanned !== undefined && ` · ${inRegionCount} inside`}
              </>
            )}
            {preview !== undefined && preview.matchCount > 1 && (
              <>
                {' · '}
                <span className="warn-inline">
                  selector matches {preview.matchCount} elements
                </span>
              </>
            )}
          </p>
        </>
      )}

      {picking && picked === undefined && (
        <p className="small muted">Click the element you mean.</p>
      )}

      {selectingRegion && (
        <p className="small muted">
          Drag a box around the area you want. Only elements fully inside it are scanned.
        </p>
      )}

      {/*
        Shown here, not only in the Live Session panel.

        Every refusal in the region path — a drag too small to be deliberate, a
        download whose region contains nothing scanned — sets `error`, and it was
        rendered two panels away in a column the user is not reading. A refusal
        nobody sees is indistinguishable from a feature that does nothing, which
        is exactly how this looked when the region never committed.
      */}
      {error !== undefined && <p className="warn">{error}</p>}

      {picked !== undefined && <PickedElementDetail picked={picked} />}
    </section>
  );
}

/**
 * The picked element and its ranked selectors.
 *
 * Every candidate is shown with the match count the worker measured against the
 * live page, because that is the number that decides whether a selector is
 * usable — a `data-testid` matching four elements looks ideal until you see it.
 */
function PickedElementDetail({
  picked,
}: {
  picked: NonNullable<ReturnType<typeof useLiveSessionStore.getState>['picked']>;
}): JSX.Element {
  const previewSelector = useLiveSessionStore((state) => state.previewSelector);
  const label = picked.accessibleName ?? picked.text ?? picked.tag;

  return (
    <div className="picked-element">
      <h3>
        {picked.tag}
        {picked.role !== undefined && ` [${picked.role}]`} — {label}
      </h3>

      <p className="small muted">
        {picked.candidateSelectors.length} selector
        {picked.candidateSelectors.length === 1 ? '' : 's'} generated and checked against the page
      </p>

      <ul className="selector-candidates">
        {picked.candidateSelectors.map((entry, index) => (
          <li
            key={`${entry.selector.type}-${index}`}
            className={
              entry.matchCount === 1 ? 'unique' : entry.matchCount === 0 ? 'no-match' : 'ambiguous'
            }
          >
            <button
              type="button"
              className="link"
              title="Preview this selector"
              onClick={() => previewSelector(entry.selector)}
            >
              {describe(entry.selector)}
            </button>
            <span className="match-count">
              {entry.score} · {entry.matchCount} match
              {entry.matchCount === 1 ? '' : 'es'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A short rendering of a selector, mirroring the worker's own `describeSelector`. */
function describe(selector: { type: string; value?: string; role?: string; name?: string }): string {
  if (selector.type === 'role') {
    return selector.name === undefined
      ? `role=${selector.role}`
      : `role=${selector.role}[name="${selector.name}"]`;
  }
  return `${selector.type}=${selector.value ?? ''}`;
}

/**
 * Converts a click on the rendered frame into a page viewport coordinate.
 *
 * The inverse of `boxStyle`: the image is scaled to its container, so the click
 * is taken as a fraction of the rendered box and multiplied back up by the
 * frame's real dimensions. Using the element's own rect means this stays correct
 * at any panel width without a resize listener.
 */
function handlePick(
  event: React.MouseEvent<HTMLDivElement>,
  frame: { width: number; height: number },
  pickAt: (x: number, y: number) => void,
): void {
  const point = toViewportPoint(event, frame);
  if (point === undefined) return;

  pickAt(point.x, point.y);
}

/**
 * A pointer position as a page viewport coordinate.
 *
 * Shared by picking and region drawing so the two cannot disagree about where
 * the pointer was — they read the same frame through the same scaling, and a
 * region that interpreted coordinates differently from a pick would select
 * elements the overlay did not highlight.
 *
 * Clamped to the frame: a drag captured outside the image still has to name a
 * point on the page, and an unclamped one produces a region partly off-viewport
 * that no element can be contained by.
 */
function toViewportPoint(
  event: { clientX: number; clientY: number; currentTarget: Element },
  frame: { width: number; height: number },
): { x: number; y: number } | undefined {
  return pointInFrame(
    event.clientX,
    event.clientY,
    event.currentTarget.getBoundingClientRect(),
    frame,
  );
}

/**
 * A client coordinate as a page viewport coordinate, against a given rect.
 *
 * Takes the rect rather than reading it, so a drag can measure every event
 * against the frame as it was when the gesture began. See the comment on
 * `onPointerDown` for what re-reading it per event did.
 */
function pointInFrame(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (rect.width === 0 || rect.height === 0) return undefined;

  const fractionX = clamp((clientX - rect.left) / rect.width, 0, 1);
  const fractionY = clamp((clientY - rect.top) / rect.height, 0, 1);

  return { x: fractionX * frame.width, y: fractionY * frame.height };
}

/** The rectangle spanned by two points, normalized so width and height are positive. */
function rectBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): ViewportRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The host a remembered setting belongs to, for the caption. */
function hostLabel(url: string | undefined): string | undefined {
  if (url === undefined || url.length === 0) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function boxStyle(
  bbox: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): React.CSSProperties {
  return {
    left: `${(bbox.x / frame.width) * 100}%`,
    top: `${(bbox.y / frame.height) * 100}%`,
    width: `${(bbox.width / frame.width) * 100}%`,
    height: `${(bbox.height / frame.height) * 100}%`,
  };
}
