import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RunnerApiError,
  runnerApi,
  type InspectionElement,
  type InspectionResult,
} from '../../lib/runner-api.js';

/**
 * Inspect a URL and show the registry entries it produced.
 *
 * This is the shortest path through the Runner: paste a link, get back every
 * element the page contains, already named and selector-ranked. It is what
 * Page Object generation consumes, so the panel shows the entries as they
 * actually are rather than a friendlier summary — if the generated
 * `systemName` is wrong, it should be obvious here, not after code generation.
 *
 * Submitting returns 202 and the result is polled, exactly as an external
 * integrator would do it. The workspace has no privileged back door.
 */

const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 90_000;

export function InspectionPanel(): JSX.Element {
  const [url, setUrl] = useState('');
  const [workspaceRef, setWorkspaceRef] = useState('workspace_local');
  const [waitUntil, setWaitUntil] = useState<'domcontentloaded' | 'networkidle'>(
    'domcontentloaded',
  );
  const [result, setResult] = useState<InspectionResult | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Lets an unmount stop a poll loop that would otherwise set state on a
  // component that is no longer mounted.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const inspect = useCallback(async () => {
    if (url.trim().length === 0) {
      setError('Enter a URL to inspect.');
      return;
    }

    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setStatus('QUEUED');

    try {
      const accepted = await runnerApi.submitInspection(url.trim(), workspaceRef, {
        waitUntil,
        ...(waitUntil === 'networkidle' ? { waitForMs: 1000 } : {}),
      });

      const deadline = Date.now() + POLL_TIMEOUT_MS;

      for (;;) {
        if (cancelled.current) return;

        const current = await runnerApi.getInspection(accepted.inspectionId);
        setStatus(current.status);

        if (current.status === 'COMPLETED' || current.status === 'FAILED') {
          setResult(current);
          if (current.status === 'FAILED' && current.error !== undefined) {
            // The Runner's error kind matters here: a page that would not load
            // is a precondition problem, not a Runner defect.
            setError(`${current.error.code} (${current.error.kind}): ${current.error.message}`);
          }
          return;
        }

        if (Date.now() > deadline) {
          setError('The inspection did not finish in time. Is the worker running?');
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (cause) {
      if (cause instanceof RunnerApiError) {
        setError(`${cause.error.code}: ${cause.error.message}`);
      } else {
        setError(cause instanceof Error ? cause.message : 'The inspection request failed.');
      }
    } finally {
      if (!cancelled.current) setBusy(false);
    }
  }, [url, workspaceRef, waitUntil]);

  return (
    <section className="panel">
      <h2>Page Inspector</h2>
      <p className="muted">
        Give it a URL. It returns a draft registry entry for every element on the page — the
        input Page Object generation takes.
      </p>

      <div className="field">
        <label htmlFor="inspect-url">URL</label>
        <input
          id="inspect-url"
          type="url"
          placeholder="https://example.com/login"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !busy) void inspect();
          }}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="inspect-workspace">Workspace</label>
          <input
            id="inspect-workspace"
            value={workspaceRef}
            onChange={(event) => setWorkspaceRef(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="inspect-wait">Wait until</label>
          <select
            id="inspect-wait"
            value={waitUntil}
            onChange={(event) =>
              setWaitUntil(event.target.value as 'domcontentloaded' | 'networkidle')
            }
          >
            <option value="domcontentloaded">domcontentloaded (fast)</option>
            <option value="networkidle">networkidle (client-rendered)</option>
          </select>
        </div>
      </div>

      <button type="button" onClick={() => void inspect()} disabled={busy}>
        {busy ? `Inspecting… ${status ?? ''}` : 'Inspect'}
      </button>

      {error !== undefined && <p className="error">{error}</p>}

      {result !== undefined && <InspectionReport result={result} />}
    </section>
  );
}

function InspectionReport({ result }: { result: InspectionResult }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copyJson = useCallback(() => {
    void navigator.clipboard?.writeText(JSON.stringify(result, null, 2)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [result]);

  return (
    <div className="inspection-report">
      <div className="report-header">
        <div>
          <strong>{result.page?.displayName ?? result.title ?? result.url}</strong>
          <div className="muted small">{result.url}</div>
          {result.page !== undefined && (
            <div className="muted small">
              page systemName: <code>{result.page.systemName}</code>
            </div>
          )}
        </div>
        <button type="button" className="secondary" onClick={copyJson}>
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
      </div>

      <p className="muted small">
        {result.elements.length} element(s), {result.fields.length} of them take a value
        {result.submit === undefined ? '' : ` · submit: ${result.submit.name}`}
      </p>

      <ul className="element-list">
        {result.elements.map((element) => (
          <ElementRow key={element.systemName} element={element} />
        ))}
      </ul>
    </div>
  );
}

function ElementRow({ element }: { element: InspectionElement }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <li className="element-row">
      <button type="button" className="element-summary" onClick={() => setOpen(!open)}>
        <code className="system-name">{element.systemName}</code>
        <span className="display-name">{element.displayName}</span>
        <span className="badge">{element.semanticType ?? element.role}</span>
        {element.required && <span className="badge required">required</span>}
        <span className="confidence">{Math.round(element.confidence * 100)}%</span>
      </button>

      {open && (
        <div className="element-detail">
          <dl>
            <dt>Selector</dt>
            <dd>
              <code>{describeSelector(element.selector)}</code>{' '}
              <span className="muted small">score {element.selector.score}</span>
            </dd>

            {element.fallbacks.length > 0 && (
              <>
                <dt>Fallbacks</dt>
                <dd>
                  <ol className="fallback-list">
                    {element.fallbacks.map((fallback, index) => (
                      <li key={index}>
                        <code>{describeSelector(fallback)}</code>{' '}
                        <span className="muted small">score {fallback.score}</span>
                      </li>
                    ))}
                  </ol>
                </dd>
              </>
            )}

            {element.aliases !== undefined && element.aliases.length > 0 && (
              <>
                <dt>Aliases</dt>
                <dd>{element.aliases.join(', ')}</dd>
              </>
            )}

            {element.fieldType !== undefined && (
              <>
                <dt>Field</dt>
                <dd>
                  {element.fieldType}
                  {element.fieldName === undefined ? '' : ` · name="${element.fieldName}"`}
                  {element.placeholder === undefined ? '' : ` · "${element.placeholder}"`}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </li>
  );
}

/** Renders a structured selector readably, without pretending it is code. */
function describeSelector(selector: {
  type: string;
  value?: string;
  role?: string;
  name?: string;
}): string {
  if (selector.type === 'role') {
    return `role=${selector.role ?? '?'}${selector.name === undefined ? '' : ` name="${selector.name}"`}`;
  }
  if (selector.type === 'none') return 'no stable selector';
  return `${selector.type}=${selector.value ?? selector.name ?? '?'}`;
}
