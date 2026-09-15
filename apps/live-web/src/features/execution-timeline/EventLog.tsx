import { useLiveSessionStore } from '../../stores/live-session-store.js';

/**
 * The raw live event and command-result stream.
 *
 * Shown verbatim on purpose: while the protocol is being built out, seeing the
 * exact events and error codes the Runner emits is more useful than a polished
 * summary that hides them.
 */
export function EventLog(): JSX.Element {
  const log = useLiveSessionStore((state) => state.log);
  const clearLog = useLiveSessionStore((state) => state.clearLog);

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Events</h2>
        <button type="button" className="link" onClick={clearLog} disabled={log.length === 0}>
          Clear
        </button>
      </header>

      {log.length === 0 ? (
        <p className="muted small">
          No events yet. Start a live session and send a command to see the protocol in action.
        </p>
      ) : (
        <ul className="event-log">
          {log.map((entry) => (
            <li key={entry.id} className={`event-${entry.kind}`}>
              <span className="event-time">{entry.at.slice(11, 19)}</span>
              <span className="event-label">{entry.label}</span>
              {entry.detail !== undefined && <span className="event-detail">{entry.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
