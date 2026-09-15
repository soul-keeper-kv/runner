import { useQuery } from '@tanstack/react-query';
import { runnerApi } from '../../lib/runner-api.js';

/**
 * Shows what this Runner deployment actually supports.
 *
 * Reading the same `/api/v1/capabilities` endpoint an external integrator
 * would call keeps the workspace honest about what is implemented: a feature
 * marked PLANNED here is a feature the UI must not pretend to offer.
 */
export function CapabilitiesPanel(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['capabilities'],
    queryFn: () => runnerApi.capabilities(),
    staleTime: 60_000,
  });

  if (isLoading) return <section className="panel"><p className="muted">Loading capabilities…</p></section>;

  if (error !== null) {
    return (
      <section className="panel">
        <h2>Runner</h2>
        <p className="warn">
          Could not reach the Runner API. Start it with <code>pnpm dev</code> in apps/api.
        </p>
      </section>
    );
  }

  if (data === undefined) return <section className="panel" />;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Runner</h2>
        <span className="muted small">v{data.runner.version}</span>
      </header>

      <dl className="session-meta">
        <div>
          <dt>Execution contract</dt>
          <dd><code>{data.contracts.execution.join(', ')}</code></dd>
        </div>
        <div>
          <dt>IR contract</dt>
          <dd><code>{data.contracts.testIr.join(', ')}</code></dd>
        </div>
        <div>
          <dt>Integration</dt>
          <dd>{data.integrationStyles.join(' · ')}</dd>
        </div>
      </dl>

      <ul className="feature-list">
        {data.features.map((feature) => (
          <li key={feature.name}>
            <span className={`badge badge-${feature.status.toLowerCase()}`}>{feature.status}</span>
            <span className="feature-name">{feature.name}</span>
            <span className="feature-description">{feature.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
