import { create } from 'zustand';
import type { LiveServerMessage, SelectorPreviewResult } from '@runner/live-protocol';
import type { SelectorDefinition } from '@runner/selector-model';
import { LiveSocket, type LiveSocketStatus } from '../lib/live-socket.js';
import { runnerApi, type LiveSession } from '../lib/runner-api.js';

/**
 * Live session state for the workspace.
 *
 * Deliberately holds the *socket* as well as the data: connecting, sending a
 * command and rendering its result are one flow, and splitting them across a
 * store and a component leads to sockets that outlive the view that opened
 * them. Closing the session is therefore always explicit.
 */

export interface LogEntry {
  id: string;
  at: string;
  kind: 'event' | 'result' | 'error';
  label: string;
  detail?: string;
}

/** The `state.snapshot` result, as the preview panel consumes it. */
export interface LiveStateSnapshot {
  url: string;
  title?: string;
  frameCount: number;
  hasOpenDialog: boolean;
  capturedAt: string;
  frame?: {
    format: 'png' | 'jpeg';
    data: string;
    width: number;
    height: number;
    capturedAt: string;
  };
  candidates?: {
    runtimeId: string;
    tag: string;
    role?: string;
    label?: string;
    interactable: boolean;
    bbox?: { x: number; y: number; width: number; height: number };
  }[];
  candidateCount?: number;
}

/** The `element.describe` result, as the pick panel consumes it. */
export interface PickedElement {
  runtimeId: string;
  tag: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  attributes: Record<string, string>;
  bbox?: { x: number; y: number; width: number; height: number };
  candidateSelectors: {
    selector: SelectorDefinition;
    score: number;
    matchCount: number;
  }[];
  matchedElementId?: string;
}

interface LiveSessionState {
  session: LiveSession | undefined;
  status: LiveSocketStatus | 'idle';
  log: LogEntry[];
  lastPreview: SelectorPreviewResult | undefined;
  snapshot: LiveStateSnapshot | undefined;
  showCandidates: boolean;
  picking: boolean;
  picked: PickedElement | undefined;
  error: string | undefined;

  start(workspaceRef: string): Promise<void>;
  stop(): Promise<void>;
  previewSelector(selector: SelectorDefinition): void;
  navigate(url: string): void;
  refreshSnapshot(): void;
  toggleCandidates(): void;
  togglePicking(): void;
  /** Sends a click on the frame as a point in the page's viewport. */
  pickAt(x: number, y: number): void;
  clearLog(): void;
}

let socket: LiveSocket | undefined;

/** Bounded so a long session cannot grow the log without limit. */
const MAX_LOG_ENTRIES = 200;

export const useLiveSessionStore = create<LiveSessionState>((set, get) => ({
  session: undefined,
  status: 'idle',
  log: [],
  lastPreview: undefined,
  snapshot: undefined,
  showCandidates: false,
  picking: false,
  picked: undefined,
  error: undefined,

  async start(workspaceRef: string) {
    set({ error: undefined });

    try {
      const session = await runnerApi.createLiveSession(workspaceRef);
      set({ session });

      socket?.close();
      socket = new LiveSocket(session.id, {
        onStatusChange: (status) => set({ status }),
        onMessage: (message) => handleMessage(message, set, get),
      });
      socket.connect();
    } catch (cause) {
      set({
        error: cause instanceof Error ? cause.message : 'Could not start a live session.',
        status: 'error',
      });
    }
  },

  async stop() {
    const { session } = get();
    socket?.close();
    socket = undefined;

    if (session !== undefined) {
      // Best effort: the session also expires on its own TTL, so a failed
      // close must not leave the UI stuck in a session it cannot leave.
      await runnerApi.closeLiveSession(session.id).catch(() => undefined);
    }
    set({ session: undefined, status: 'idle', lastPreview: undefined, snapshot: undefined });
  },

  previewSelector(selector: SelectorDefinition) {
    const { session } = get();
    if (session === undefined || socket === undefined) return;

    const sent = socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: 'selector.preview',
      payload: { selector },
    });

    if (!sent) set({ error: 'The live socket is not connected.' });
  },

  navigate(url: string) {
    const { session } = get();
    if (session === undefined || socket === undefined) return;

    socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: 'browser.navigate',
      payload: { url },
    });

    // The frame follows the page: navigating and then having to press Refresh
    // would show the previous page beside the new URL, which is worse than no
    // preview at all. The small delay lets the navigation settle first.
    window.setTimeout(() => get().refreshSnapshot(), 400);
  },

  refreshSnapshot() {
    const { session, showCandidates } = get();
    if (session === undefined || socket === undefined) return;

    const sent = socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: 'state.snapshot',
      payload: { includeScreenshot: true, includeCandidates: showCandidates },
    });

    if (!sent) set({ error: 'The live socket is not connected.' });
  },

  toggleCandidates() {
    const next = !get().showCandidates;
    set({ showCandidates: next });
    // Candidates come from the worker, so the toggle has to ask for them again
    // rather than filtering a frame that never carried them.
    get().refreshSnapshot();
  },

  togglePicking() {
    const { session, picking } = get();
    const next = !picking;
    set({ picking: next, ...(next ? {} : { picked: undefined }) });

    if (session === undefined || socket === undefined) return;
    socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: next ? 'element.pick.start' : 'element.pick.cancel',
      payload: {},
    });
  },

  pickAt(x: number, y: number) {
    const { session } = get();
    if (session === undefined || socket === undefined) return;

    // The point is already in the page's viewport space — the caller converted
    // it from the rendered frame, so nothing here reinterprets coordinates.
    const sent = socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: 'element.describe',
      payload: { point: { x: Math.round(x), y: Math.round(y) } },
    });

    if (!sent) set({ error: 'The live socket is not connected.' });
  },

  clearLog() {
    set({ log: [] });
  },
}));

function handleMessage(
  message: LiveServerMessage,
  set: (partial: Partial<LiveSessionState>) => void,
  get: () => LiveSessionState,
): void {
  const append = (entry: Omit<LogEntry, 'id' | 'at'>): void => {
    const log = [
      { ...entry, id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() },
      ...get().log,
    ].slice(0, MAX_LOG_ENTRIES);
    set({ log });
  };

  switch (message.kind) {
    case 'event':
      append({
        kind: 'event',
        label: message.event.type,
        detail: JSON.stringify(message.event.payload).slice(0, 200),
      });
      break;

    case 'command-result':
      if (message.result.ok) {
        // A frame is tens of kilobytes of base64; logging it would bury every
        // other entry, so snapshots are summarized instead.
        const snapshotResult = asSnapshot(message.result.result);
        append({
          kind: 'result',
          label: 'command ok',
          detail:
            snapshotResult === undefined
              ? JSON.stringify(message.result.result)
              : `snapshot ${snapshotResult.url}${snapshotResult.frame === undefined ? ' (no frame)' : ''}`,
        });

        const pickedResult = asPicked(message.result.result);

        if (snapshotResult !== undefined) set({ snapshot: snapshotResult });
        else if (pickedResult !== undefined) set({ picked: pickedResult });
        else if (isPreviewResult(message.result.result)) {
          set({ lastPreview: message.result.result });
        }
      } else {
        append({
          kind: 'error',
          label: message.result.error?.code ?? 'command failed',
          detail: message.result.error?.message,
        });
      }
      break;

    case 'error':
      append({ kind: 'error', label: message.code, detail: message.message });
      break;
  }
}

function isPreviewResult(value: unknown): value is SelectorPreviewResult {
  return typeof value === 'object' && value !== null && 'matchCount' in value;
}

/**
 * A snapshot result, or undefined.
 *
 * Distinguished by `frameCount` rather than by the presence of `frame`: a
 * snapshot of a page that could not be captured has no frame, and it still
 * needs to reach the panel so the URL stays truthful.
 */
/** A described element, or undefined. Identified by its ranked selector list. */
function asPicked(value: unknown): PickedElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<PickedElement>;
  return typeof candidate.tag === 'string' && Array.isArray(candidate.candidateSelectors)
    ? (value as PickedElement)
    : undefined;
}

function asSnapshot(value: unknown): LiveStateSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<LiveStateSnapshot>;
  return typeof candidate.url === 'string' && typeof candidate.frameCount === 'number'
    ? (value as LiveStateSnapshot)
    : undefined;
}
