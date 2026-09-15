import { useState } from 'react';
import type { SelectorDefinition, SelectorStrategy } from '@runner/selector-model';
import { describeSelector } from '@runner/selector-model';
import { useLiveSessionStore } from '../../stores/live-session-store.js';

/**
 * The live selector editor (blueprint section 31).
 *
 * Two properties are non-negotiable here. The editor builds a structured
 * `SelectorDefinition`, never a code string — so nothing a user types can
 * become executable in the worker. And previewing does not restart the
 * browser, so the page keeps the state that made the selector worth checking.
 */

const SIMPLE_STRATEGIES: SelectorStrategy[] = ['testId', 'role', 'label', 'placeholder', 'text'];
const ADVANCED_STRATEGIES: SelectorStrategy[] = ['css', 'xpath', 'altText', 'title'];

export function SelectorEditor(): JSX.Element {
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [strategy, setStrategy] = useState<SelectorStrategy>('role');
  const [value, setValue] = useState('');
  const [role, setRole] = useState('button');

  const preview = useLiveSessionStore((state) => state.lastPreview);
  const previewSelector = useLiveSessionStore((state) => state.previewSelector);
  const session = useLiveSessionStore((state) => state.session);

  const selector = buildSelector(strategy, value, role);
  const strategies = mode === 'simple' ? SIMPLE_STRATEGIES : ADVANCED_STRATEGIES;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Selector Editor</h2>
        <div className="segmented">
          <button
            type="button"
            className={mode === 'simple' ? 'active' : ''}
            onClick={() => setMode('simple')}
          >
            Simple
          </button>
          <button
            type="button"
            className={mode === 'advanced' ? 'active' : ''}
            onClick={() => setMode('advanced')}
          >
            Advanced
          </button>
        </div>
      </header>

      <div className="field">
        <label htmlFor="strategy">Strategy</label>
        <select
          id="strategy"
          value={strategy}
          onChange={(event) => setStrategy(event.target.value as SelectorStrategy)}
        >
          {strategies.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {strategy === 'role' && (
        <div className="field">
          <label htmlFor="role">Role</label>
          <input id="role" value={role} onChange={(event) => setRole(event.target.value)} />
        </div>
      )}

      <div className="field">
        <label htmlFor="value">{strategy === 'role' ? 'Accessible name' : 'Value'}</label>
        <input
          id="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholderFor(strategy)}
        />
      </div>

      <div className="field">
        <span className="muted">Resolves to</span>
        <code className="selector-preview">{describeSelector(selector)}</code>
      </div>

      <button
        type="button"
        className="primary"
        disabled={session === undefined}
        onClick={() => previewSelector(selector)}
      >
        Preview on live page
      </button>

      {session === undefined && (
        <p className="muted small">Start a live session to preview selectors.</p>
      )}

      {preview !== undefined && (
        <div className={`preview-result ${matchClass(preview.matchCount)}`}>
          <dl>
            <div>
              <dt>Matches</dt>
              <dd>{preview.matchCount}</dd>
            </div>
            <div>
              <dt>Visible</dt>
              <dd>{preview.visible ? 'yes' : 'no'}</dd>
            </div>
            <div>
              <dt>Enabled</dt>
              <dd>{preview.enabled ? 'yes' : 'no'}</dd>
            </div>
            {preview.stability !== undefined && (
              <div>
                <dt>Stability</dt>
                <dd>{preview.stability}</dd>
              </div>
            )}
          </dl>
          {/* Ambiguity is the failure mode most worth shouting about: acting on
              the first of several matches is how a run clicks the wrong row. */}
          {preview.matchCount > 1 && (
            <p className="warn">
              Ambiguous — this selector matches {preview.matchCount} elements. Narrow it before
              confirming.
            </p>
          )}
          {preview.error !== undefined && <p className="warn">{preview.error.message}</p>}
        </div>
      )}
    </section>
  );
}

function buildSelector(
  strategy: SelectorStrategy,
  value: string,
  role: string,
): SelectorDefinition {
  if (strategy === 'role') {
    return value.trim().length === 0
      ? { type: 'role', role }
      : { type: 'role', role, name: value };
  }
  return { type: strategy, value } as SelectorDefinition;
}

function placeholderFor(strategy: SelectorStrategy): string {
  switch (strategy) {
    case 'testId':
      return 'create-customer';
    case 'role':
      return 'Create Customer';
    case 'css':
      return '.customer-form button.primary';
    case 'xpath':
      return '//button[@data-testid="create"]';
    default:
      return 'Value to match';
  }
}

function matchClass(matchCount: number): string {
  if (matchCount === 1) return 'ok';
  return matchCount === 0 ? 'empty' : 'ambiguous';
}
