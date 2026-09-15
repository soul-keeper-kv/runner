import { create } from 'zustand';
import type { LiveServerMessage, SelectorPreviewResult } from '@runner/live-protocol';
import type { SelectorDefinition } from '@runner/selector-model';
import { LiveSocket, type LiveSocketStatus } from '../lib/live-socket.js';
import { runnerApi, type LiveSession } from '../lib/runner-api.js';
import {
  buildRegistryExport,
  downloadJson,
  filenameForUrl,
  type ScannedElement,
} from '../lib/registry-export.js';

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

/** Progress of a full-page scan, so the UI can show it and offer a cancel. */
export interface ScanProgress {
  running: boolean;
  /** Elements described so far. */
  done: number;
  total: number;
  /** Set when the scan stopped early; the partial result is still usable. */
  stoppedReason?: 'cancelled' | 'disconnected';
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
  scan: ScanProgress | undefined;
  scanned: ScannedElement[] | undefined;
  error: string | undefined;

  start(workspaceRef: string, authProfileRef?: string): Promise<void>;
  stop(): Promise<void>;
  /** Logs the live browser in as a profile, in place, without restarting it. */
  login(profileRef: string, force?: boolean): void;
  previewSelector(selector: SelectorDefinition): void;
  navigate(url: string): void;
  refreshSnapshot(): void;
  toggleCandidates(): void;
  togglePicking(): void;
  /** Sends a click on the frame as a point in the page's viewport. */
  pickAt(x: number, y: number): void;
  /** Lists every element on the page, then describes each to rank selectors. */
  scanAll(): Promise<void>;
  cancelScan(): void;
  downloadRegistry(): void;
  clearLog(): void;
}

let socket: LiveSocket | undefined;

/**
 * Resolvers for commands a caller is awaiting.
 *
 * `send` is fire-and-forget and every result arrives in one handler, so a
 * sequential scan needs to know which result answered its command. Keyed by
 * command id rather than assuming order: a result for a cancelled step must be
 * discarded, not handed to the next awaiting caller.
 */
const pending = new Map<string, (result: unknown | undefined) => void>();

/** Set while a scan runs, so a cancel can stop the loop between describes. */
let scanToken: symbol | undefined;

/** A described element is worth waiting for, but not forever. */
const DESCRIBE_TIMEOUT_MS = 10_000;

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
  scan: undefined,
  scanned: undefined,
  error: undefined,

  async start(workspaceRef: string, authProfileRef?: string) {
    set({ error: undefined });

    try {
      // Only the profile reference is sent. A workspace that held a password
      // would be a credential store running in a browser tab.
      const session = await runnerApi.createLiveSession(
        workspaceRef,
        undefined,
        authProfileRef === undefined || authProfileRef.trim().length === 0
          ? undefined
          : authProfileRef.trim(),
      );
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

    // Abandon any scan before the socket goes: its loop awaits results that
    // will never arrive, and a stale token would let it keep writing state
    // into a session the user has already left.
    scanToken = undefined;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();

    socket?.close();
    socket = undefined;

    if (session !== undefined) {
      // Best effort: the session also expires on its own TTL, so a failed
      // close must not leave the UI stuck in a session it cannot leave.
      await runnerApi.closeLiveSession(session.id).catch(() => undefined);
    }
    set({
      session: undefined,
      status: 'idle',
      lastPreview: undefined,
      snapshot: undefined,
      scan: undefined,
      scanned: undefined,
    });
  },

  /**
   * Logs the held browser in as a profile.
   *
   * Used when a session's profile had no stored session yet, or when the
   * application signed the user out under a view that has been open a while.
   * The browser is not restarted — that is the point of doing it as a command.
   */
  login(profileRef: string, force = false) {
    const { session } = get();
    if (session === undefined || socket === undefined) {
      set({ error: 'Start a live session before logging in.' });
      return;
    }

    const sent = socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: 'auth.login',
      payload: { profileRef, force },
    });

    if (!sent) set({ error: 'The live socket is not connected.' });
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

  /**
   * Lists every element on the page, then describes each one.
   *
   * Two commands rather than one: `state.inspect` returns the whole page in a
   * single round trip, which is what the overlay needs and what makes the
   * button feel immediate. Ranked selectors only exist per element, so they are
   * filled in afterwards, one `element.describe` at a time — the list is
   * already usable while that runs, and the user can stop it.
   *
   * Sequential on purpose. Each describe drives a real browser through one
   * session; firing 150 at once would queue them behind each other anyway and
   * make a cancel meaningless.
   */
  async scanAll() {
    const { session } = get();
    if (session === undefined || socket === undefined) {
      set({ error: 'Start a live session before scanning.' });
      return;
    }

    const token = Symbol('scan');
    scanToken = token;
    set({ scan: { running: true, done: 0, total: 0 }, error: undefined });

    const listed = await sendAwaiting(session.id, 'state.inspect', {
      includeScreenshot: false,
      includeCandidates: true,
    });

    const snapshot = asSnapshot(listed);
    if (snapshot === undefined) {
      set({ scan: undefined, error: 'The page could not be listed.' });
      return;
    }

    const candidates = snapshot.candidates ?? [];
    const scanned: ScannedElement[] = candidates.map((candidate) => ({ ...candidate }));

    // Shown before any describe runs: the overlay and the count are useful
    // immediately, and a slow describe loop should not hold them back.
    set({
      scanned,
      showCandidates: true,
      scan: { running: true, done: 0, total: scanned.length },
    });
    get().refreshSnapshot();

    for (const [index, element] of scanned.entries()) {
      if (scanToken !== token) return;

      if (element.bbox === undefined) {
        set({ scan: { running: true, done: index + 1, total: scanned.length } });
        continue;
      }

      const described = await sendAwaiting(session.id, 'element.describe', {
        point: {
          x: Math.round(element.bbox.x + element.bbox.width / 2),
          y: Math.round(element.bbox.y + element.bbox.height / 2),
        },
      });

      if (scanToken !== token) return;

      if (described === undefined) {
        // A socket that dropped mid-scan leaves the entries already described
        // intact; reporting that beats discarding the work.
        if (socket === undefined) {
          set({
            scan: {
              running: false,
              done: index,
              total: scanned.length,
              stoppedReason: 'disconnected',
            },
          });
          return;
        }
      } else {
        const picked = asPicked(described);
        if (picked !== undefined) {
          scanned[index] = {
            ...element,
            described: {
              runtimeId: picked.runtimeId,
              // Carried so the export can tell whether the describe landed on
              // this element or on something covering it. The ids cannot answer
              // that — inspect and describe number elements independently.
              ...(picked.bbox === undefined ? {} : { bbox: picked.bbox }),
              ...(picked.accessibleName === undefined
                ? {}
                : { accessibleName: picked.accessibleName }),
              ...(picked.text === undefined ? {} : { text: picked.text }),
              ...(picked.matchedElementId === undefined
                ? {}
                : { matchedElementId: picked.matchedElementId }),
              candidateSelectors: picked.candidateSelectors,
            },
          };
        }
      }

      set({
        scanned: [...scanned],
        scan: { running: true, done: index + 1, total: scanned.length },
      });
    }

    set({ scan: { running: false, done: scanned.length, total: scanned.length } });
  },

  cancelScan() {
    scanToken = undefined;
    const current = get().scan;
    if (current === undefined) return;
    set({ scan: { ...current, running: false, stoppedReason: 'cancelled' } });
  },

  downloadRegistry() {
    const { scanned, snapshot } = get();
    if (scanned === undefined || scanned.length === 0) {
      set({ error: 'Scan the page before downloading a registry draft.' });
      return;
    }

    const url = snapshot?.url ?? '';
    downloadJson(
      buildRegistryExport(scanned, {
        url,
        ...(snapshot?.title === undefined ? {} : { title: snapshot.title }),
        ...(snapshot?.candidateCount === undefined
          ? {}
          : { candidateCount: snapshot.candidateCount }),
      }),
      filenameForUrl(url, 'registry'),
    );
  },

  clearLog() {
    set({ log: [] });
  },
}));

/**
 * Sends a command and waits for the result that answers it.
 *
 * Returns undefined when the socket is closed, the command failed or it timed
 * out — every one of which the scan loop handles by keeping what it already
 * has, so none of them needs to be distinguished here.
 */
async function sendAwaiting(
  sessionId: string,
  type: string,
  payload: unknown,
): Promise<unknown | undefined> {
  if (socket === undefined) return undefined;

  const id = `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const sent = socket.send({ id, sessionId, type, payload });
  if (!sent) return undefined;

  return new Promise<unknown | undefined>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
    }, DESCRIBE_TIMEOUT_MS);

    pending.set(id, (result) => {
      window.clearTimeout(timer);
      resolve(result);
    });
  });
}

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

    case 'command-result': {
      // Settle an awaiting caller first, and before the early returns below:
      // a scan step that never learns its command failed would stall until its
      // timeout, turning one bad element into a ten-second pause.
      const waiting = pending.get(message.result.commandId);
      if (waiting !== undefined) {
        pending.delete(message.result.commandId);
        waiting(message.result.ok ? message.result.result : undefined);
      }

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
    }

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
