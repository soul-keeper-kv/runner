import { useState } from 'react';
import { useLiveSessionStore } from '../../stores/live-session-store.js';

/**
 * Live session lifecycle controls (blueprint section 26).
 *
 * The session is started and stopped explicitly rather than implicitly on
 * mount: it holds a real browser on the worker, and a page refresh should not
 * silently leak one.
 *
 * The auth profile field is the reason most pages worth inspecting are
 * reachable at all — an internal screen usually renders nothing to a visitor
 * who is not signed in. Only the profile *reference* is entered here; the
 * credential lives in the worker's secret provider, never in this tab.
 */
export function LiveSessionPanel(): JSX.Element {
  const [workspaceRef, setWorkspaceRef] = useState('workspace_demo');
  const [authProfileRef, setAuthProfileRef] = useState('');
  const [url, setUrl] = useState('https://example.com');

  const session = useLiveSessionStore((state) => state.session);
  const status = useLiveSessionStore((state) => state.status);
  const error = useLiveSessionStore((state) => state.error);
  const start = useLiveSessionStore((state) => state.start);
  const stop = useLiveSessionStore((state) => state.stop);
  const navigate = useLiveSessionStore((state) => state.navigate);
  const login = useLiveSessionStore((state) => state.login);

  const profileRef = session?.authProfileRef;

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
          <div className="field">
            <label htmlFor="auth-profile">Auth profile (optional)</label>
            <input
              id="auth-profile"
              value={authProfileRef}
              placeholder="MANAGER"
              onChange={(event) => setAuthProfileRef(event.target.value)}
            />
            <span className="muted">
              Opens the browser with this profile&apos;s stored session, so a page behind a login
              renders. Declared in <code>RUNNER_AUTH_PROFILES</code> on the worker — the password
              never reaches this page.
            </span>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => void start(workspaceRef, authProfileRef)}
          >
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
            {profileRef !== undefined && (
              <div>
                <dt>Signed in as</dt>
                {/*
                  Reported from what the Runner actually did, never guessed from
                  the page: a view that concluded "logged in" because the word
                  appeared somewhere is how a whole run happens against a login
                  screen.
                */}
                <dd>
                  {session.authenticatedAs === undefined ? (
                    <span className="warn-inline">not yet — {profileRef}</span>
                  ) : (
                    <code>{session.authenticatedAs}</code>
                  )}
                </dd>
              </div>
            )}
          </dl>

          {profileRef !== undefined && (
            <div className="button-row">
              <button type="button" onClick={() => login(profileRef)}>
                Log in as {profileRef}
              </button>
              <button type="button" onClick={() => login(profileRef, true)}>
                Force re-login
              </button>
            </div>
          )}

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
