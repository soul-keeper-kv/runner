import { useLiveSessionStore } from '../../stores/live-session-store.js';

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

  if (session === undefined) {
    return (
      <section className="panel">
        <h2>Live Preview</h2>
        <p className="muted">Start a live session to see the page.</p>
      </section>
    );
  }

  const frame = snapshot?.frame;

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
          <button type="button" onClick={() => toggleCandidates()}>
            {showCandidates ? 'Hide elements' : 'Show elements'}
          </button>
          <button type="button" onClick={() => refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {frame === undefined ? (
        <p className="muted">
          No frame yet. Navigate or press Refresh to capture the page.
        </p>
      ) : (
        <>
          <div
            className={`live-frame${picking ? ' picking' : ''}`}
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            onClick={picking ? (event) => handlePick(event, frame, pickAt) : undefined}
          >
            <img
              src={`data:image/${frame.format};base64,${frame.data}`}
              alt={`Live page at ${snapshot?.url ?? 'the current URL'}`}
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
                    className="live-box candidate"
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
          </div>

          <p className="small muted">
            {snapshot?.url}
            {snapshot?.candidateCount !== undefined && (
              <>
                {' · '}
                {snapshot.candidates?.length ?? 0} of {snapshot.candidateCount} elements
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
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const fractionX = (event.clientX - rect.left) / rect.width;
  const fractionY = (event.clientY - rect.top) / rect.height;

  pickAt(fractionX * frame.width, fractionY * frame.height);
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
