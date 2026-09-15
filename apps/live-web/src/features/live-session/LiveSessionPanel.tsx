import { useState } from 'react';
import { useLiveSessionStore } from '../../stores/live-session-store.js';

/**
 * Live session lifecycle controls (blueprint section 26).
 *
 * The session is started and stopped explicitly rather than implicitly on
 * mount: it holds a real browser on the worker, and a page refresh should not
 * silently leak one.
 */
export function LiveSessionPanel(): JSX.Element {
  const [workspaceRef, setWorkspaceRef] = useState('workspace_demo');
  const [url, setUrl] = useState('https://example.com');

  const session = useLiveSessionStore((state) => state.session);
  const status = useLiveSessionStore((state) => state.status);
  const error = useLiveSessionStore((state) => state.error);
  const start = useLiveSessionStore((state) => state.start);
  const stop = useLiveSessionStore((state) => state.stop);
  const navigate = useLiveSessionStore((state) => state.navigate);

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Live Session</h2>
        <span className={`status status-${status}`}>{status}</span>
      </header>

      {session === undefined ? (
        <>
          <div className="field">
            <label htmlFor="workspace">Workspace reference</label>
            <input
              id="workspace"
              value={workspaceRef}
              onChange={(event) => setWorkspaceRef(event.target.value)}
            />
          </div>
          <button type="button" className="primary" onClick={() => void start(workspaceRef)}>
            Start live session
          </button>
        </>
      ) : (
        <>
          <dl className="session-meta">
            <div>
              <dt>Session</dt>
              <dd><code>{session.id}</code></dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd><code>{session.browserSessionId}</code></dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{session.executionState}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{session.revision}</dd>
            </div>
          </dl>

          <div className="field">
            <label htmlFor="url">Navigate to</label>
            <input id="url" value={url} onChange={(event) => setUrl(event.target.value)} />
          </div>

          <div className="button-row">
            <button type="button" onClick={() => navigate(url)}>
              Navigate
            </button>
            <button type="button" className="danger" onClick={() => void stop()}>
              Close session
            </button>
          </div>
        </>
      )}

      {error !== undefined && <p className="warn">{error}</p>}
    </section>
  );
}
