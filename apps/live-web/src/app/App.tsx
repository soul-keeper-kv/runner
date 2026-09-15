import { CapabilitiesPanel } from '../features/live-browser/CapabilitiesPanel.js';
import { LivePreview } from '../features/live-browser/LivePreview.js';
import { LiveSessionPanel } from '../features/live-session/LiveSessionPanel.js';
import { InspectionPanel } from '../features/page-inspector/InspectionPanel.js';
import { SelectorEditor } from '../features/selector-editor/SelectorEditor.js';
import { EventLog } from '../features/execution-timeline/EventLog.js';

/**
 * The live workspace shell (blueprint section 25).
 *
 * This is the Runner's own authoring and debugging surface, not the product's
 * main SaaS frontend. It exists so selector resolution, live preview and the
 * command protocol can be exercised against a real browser — and so any
 * awkwardness in the public API is felt here first.
 *
 * The live browser view, element inspector and registry editor arrive with
 * their phases; the layout already reserves their place.
 */
export function App(): JSX.Element {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Runner Live Workspace</h1>
        <p className="muted">
          Drives the Runner through its public API and live command protocol — the same contract an
          external service uses.
        </p>
      </header>

      <main className="layout">
        <div className="column">
          <InspectionPanel />
          <CapabilitiesPanel />
          <LiveSessionPanel />
        </div>

        <div className="column">
          <LivePreview />
          <SelectorEditor />
        </div>

        <div className="column">
          <EventLog />
        </div>
      </main>
    </div>
  );
}
