import { create } from 'zustand';
import type { LiveServerMessage, SelectorPreviewResult } from '@runner/live-protocol';
import type { SelectorDefinition } from '@runner/selector-model';
import { LiveSocket, type LiveSocketStatus } from '../lib/live-socket.js';
import { runnerApi, type LiveSession } from '../lib/runner-api.js';
import {
  buildRegistryExport,
  containedInRegion,
  downloadJson,
  filenameForUrl,
  type ScannedElement,
  type ViewportRect,
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

/** Progress of a scan, so the UI can show it and offer a cancel. */
export interface ScanProgress {
  running: boolean;
  /** Elements described so far. */
  done: number;
  total: number;
  /** Set when the scan stopped early; the partial result is still usable. */
  stoppedReason?: 'cancelled' | 'disconnected';
  /** Set when the scan covered a drawn region rather than the whole page. */
  scoped?: boolean;
}

/** What a download covers. */
export type ExportScope = 'page' | 'region';

interface LiveSessionState {
  session: LiveSession | undefined;
  status: LiveSocketStatus | 'idle';
  log: LogEntry[];
  lastPreview: SelectorPreviewResult | undefined;
  snapshot: LiveStateSnapshot | undefined;
  showCandidates: boolean;
  picking: boolean;
  picked: PickedElement | undefined;
  /** True while the frame is armed for a region drag. */
  selectingRegion: boolean;
  /** The region the user drew, in page viewport coordinates. */
  region: ViewportRect | undefined;
  /**
   * CSS selector for the container every scan is rooted at.
   *
   * Remembered per host, so an application that renders everything into one
   * panel is configured once instead of scoped by hand on every scan.
   */
  scanRoot: string;
  /** True while the frame refreshes on a timer rather than on demand. */
  following: boolean;
  /** True while the worker pushes frames as they are painted. */
  streaming: boolean;
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
  /** Arms or disarms the frame for drawing a region. */
  toggleRegionSelect(): void;
  /** Records a region the user drew, in page viewport coordinates. */
  setRegion(region: ViewportRect): void;
  clearRegion(): void;
  /** Sets the scan root and remembers it for the current page's host. */
  setScanRoot(selector: string): void;
  /** Starts or stops refreshing the frame on a timer. */
  toggleFollow(): void;
  /** Starts or stops the worker's frame stream. */
  toggleStream(): void;
  /** Lists every element on the page, then describes each to rank selectors. */
  scanAll(): Promise<void>;
  /** Describes only the elements sitting inside the drawn region. */
  scanRegion(): Promise<void>;
  cancelScan(): void;
  downloadRegistry(scope?: ExportScope): void;
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

/**
 * The auto-refresh loop.
 *
 * Held at module level beside the socket, for the same reason: it belongs to
 * the session rather than to a component, and a timer that outlived the view
 * that started it would keep driving a browser nobody is watching.
 */
let followTimer: number | undefined;

/**
 * Whether a snapshot is still outstanding.
 *
 * `refreshSnapshot` is fire-and-forget — it does not go through `sendAwaiting`
 * — so the loop cannot await its own request. Without this flag a page slower
 * than the interval queues snapshots faster than the worker answers them, and
 * the browser spends all its time screenshotting.
 */
let snapshotInFlight = false;

/**
 * How often the frame is refreshed while following.
 *
 * A snapshot costs the worker 20-50ms, so this is not a cost problem; it is a
 * *courtesy* problem. Faster buys little — the eye cannot use 10fps of a
 * still-image preview — and it drives a real browser continuously, so the loop
 * is also stopped whenever the tab is hidden.
 */
const FOLLOW_INTERVAL_MS = 350;

/** A described element is worth waiting for, but not forever. */
const DESCRIBE_TIMEOUT_MS = 10_000;

/**
 * Where a host's scan root is remembered.
 *
 * Per host rather than one global value: the selector is a fact about one
 * application's layout, and a single setting would silently scope a scan of the
 * next site to a panel that does not exist there — which now fails loudly, but
 * still wastes the user's time.
 *
 * localStorage rather than the Registry: this is a workspace convenience, and
 * putting it in the Registry would mean a migration, a route and a draft
 * modification (blueprint rule 7) for a text box.
 */
const SCAN_ROOT_PREFIX = 'runner.scanRoot.';

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || url.length === 0) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function loadScanRoot(url: string | undefined): string {
  const host = hostOf(url);
  if (host === undefined) return '';
  try {
    return window.localStorage.getItem(`${SCAN_ROOT_PREFIX}${host}`) ?? '';
  } catch {
    // A private window or blocked site data must not break scanning.
    return '';
  }
}

/**
 * Below this, in viewport pixels, a drag is treated as a stray click.
 *
 * A region has to be drawn over a screenshot, and a plain click on the frame
 * produces a zero-sized rect. Accepting it would arm a scan that matches
 * nothing and report "0 elements" as though the page were empty.
 */
const MIN_REGION_SIZE = 8;

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
  selectingRegion: false,
  region: undefined,
  scanRoot: '',
  following: false,
  streaming: false,
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

    // The timer holds no reference to the session, so it would happily keep
    // asking a closed socket for frames.
    stopFollowing();
    snapshotInFlight = false;

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
      selectingRegion: false,
      region: undefined,
      following: false,
      streaming: false,
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
    const { session, showCandidates, scanRoot } = get();
    if (session === undefined || socket === undefined) return;

    const sent = socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: 'state.snapshot',
      payload: {
        includeScreenshot: true,
        includeCandidates: showCandidates,
        ...(scanRoot.length === 0 ? {} : { rootSelector: scanRoot }),
      },
    });

    if (sent) snapshotInFlight = true;
    else set({ error: 'The live socket is not connected.' });
  },

  /**
   * Follows the page: refreshes the frame on a timer instead of on demand.
   *
   * The preview was a still image that only changed when someone pressed
   * Refresh, so a page that moved on its own — or moved because of a command —
   * left a picture that was quietly out of date. This is not a video stream and
   * does not pretend to be one; it is the same snapshot command on a timer,
   * which is enough for the frame to stop lying about the page.
   *
   * Off by default: it drives a real browser for as long as it runs.
   */
  toggleFollow() {
    const next = !get().following;
    set({ following: next });

    stopFollowing();
    if (!next) return;

    followTimer = window.setInterval(() => {
      const state = get();

      // Nothing to follow, or the session went away under us.
      if (state.session === undefined || socket === undefined) {
        stopFollowing();
        set({ following: false });
        return;
      }

      // A hidden tab is not being watched, and a scan already drives the
      // browser hard enough without a timer competing for it.
      if (document.hidden || state.scan?.running === true) return;

      // Skipped rather than queued: a page slower than the interval would
      // otherwise accumulate snapshots the worker answers long after they
      // stopped being current.
      if (snapshotInFlight) return;

      get().refreshSnapshot();
    }, FOLLOW_INTERVAL_MS);

    // One immediately, so pressing the button shows its effect now rather
    // than after the first interval.
    get().refreshSnapshot();
  },

  /**
   * Streams the page instead of asking for it.
   *
   * The worker turns the engine's own screencast on and publishes each frame,
   * so the picture follows repaints rather than a timer. Following is switched
   * off when this starts: two sources updating one image would race, and the
   * poll would be pure waste behind a stream that is already faster.
   *
   * When the Runner has no cross-process event bus the command fails with
   * CAPABILITY_NOT_IMPLEMENTED naming what is missing, which the panel shows —
   * and following remains the fallback that works everywhere.
   */
  toggleStream() {
    const { session, streaming, following } = get();
    if (session === undefined || socket === undefined) {
      set({ error: 'Start a live session before streaming.' });
      return;
    }

    const next = !streaming;

    if (next && following) {
      // Stops the timer, not just the flag.
      get().toggleFollow();
    }

    const sent = socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: next ? 'view.start' : 'view.stop',
      payload: next ? { format: 'jpeg', quality: 60, everyNthFrame: 2 } : {},
    });

    if (!sent) {
      set({ error: 'The live socket is not connected.' });
      return;
    }

    // Optimistic, and corrected by the command result: a refused `view.start`
    // sets `error`, and leaving the button lit would claim a stream that is
    // not running.
    set({ streaming: next });
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
    // The two frame modes are mutually exclusive: one click cannot mean both
    // "describe this element" and "start a region here".
    set({
      picking: next,
      ...(next ? { selectingRegion: false } : { picked: undefined }),
    });

    if (session === undefined || socket === undefined) return;
    socket.send({
      id: `cmd_${Date.now().toString(36)}`,
      sessionId: session.id,
      type: next ? 'element.pick.start' : 'element.pick.cancel',
      payload: {},
    });
  },

  /**
   * Arms the frame for a region drag.
   *
   * Purely client-side. The region is a filter over geometry the worker has
   * already reported, so nothing is sent: the browser does not need to know the
   * user is drawing, and a command that told it would be a round trip buying
   * nothing. Leaving pick mode on at the same time would make a click ambiguous,
   * so arming one disarms the other.
   */
  toggleRegionSelect() {
    const { selectingRegion } = get();
    const next = !selectingRegion;

    set({
      selectingRegion: next,
      ...(next ? { picking: false } : {}),
    });

    // Showing the candidate boxes is what makes a region checkable before the
    // scan runs — the user needs to see which elements fall inside it.
    if (next && !get().showCandidates) get().toggleCandidates();
  },

  setRegion(region: ViewportRect) {
    // A click rather than a drag: too small to be a deliberate region, and
    // keeping it would arm a scan over nothing.
    if (region.width < MIN_REGION_SIZE || region.height < MIN_REGION_SIZE) {
      set({ selectingRegion: false, error: 'Drag a larger region to scan.' });
      return;
    }

    // Disarmed once drawn: the region stays visible and rescannable, and
    // leaving the frame armed would make the next click erase it by accident.
    set({ region, selectingRegion: false, error: undefined });
  },

  clearRegion() {
    set({ region: undefined, selectingRegion: false });
  },

  setScanRoot(selector: string) {
    const trimmed = selector.trim();
    set({ scanRoot: trimmed });

    // Persisted against the page currently open, so the value comes back the
    // next time this application is inspected. An empty box removes the entry
    // rather than storing '' — otherwise "I cleared it" and "I never set one"
    // would look different in storage while meaning the same thing.
    const host = hostOf(get().snapshot?.url);
    if (host === undefined) return;

    try {
      const key = `${SCAN_ROOT_PREFIX}${host}`;
      if (trimmed.length === 0) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, trimmed);
    } catch {
      // Storage being unavailable costs the user the memory, not the scan.
    }
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
    await runScan(set, get, undefined);
  },

  /**
   * Describes only the elements inside the drawn region.
   *
   * The whole page is still *listed* — one `state.inspect` is a single round
   * trip and the overlay wants every box regardless — but the describe loop,
   * which is the slow part at one browser round trip per element, runs only over
   * what the region contains. That is the cost the region exists to cut.
   */
  async scanRegion() {
    const { region } = get();
    if (region === undefined) {
      set({ error: 'Draw a region on the frame before scanning it.' });
      return;
    }

    await runScan(set, get, region);
  },

  cancelScan() {
    scanToken = undefined;
    const current = get().scan;
    if (current === undefined) return;
    set({ scan: { ...current, running: false, stoppedReason: 'cancelled' } });
  },

  /**
   * Downloads a registry draft for the whole page or for the region only.
   *
   * The scope is chosen at download time rather than fixed by how the scan ran,
   * because the two are independent: a full scan followed by a region download
   * is the common case — scan once, then export the one panel you came for,
   * without paying for a second scan.
   */
  downloadRegistry(scope: ExportScope = 'page') {
    const { scanned, snapshot, region } = get();
    if (scanned === undefined || scanned.length === 0) {
      set({ error: 'Scan the page before downloading a registry draft.' });
      return;
    }

    if (scope === 'region' && region === undefined) {
      set({ error: 'Draw a region before downloading one.' });
      return;
    }

    const elements =
      scope === 'region' && region !== undefined
        ? scanned.filter((element) => containedInRegion(element.bbox, region))
        : scanned;

    if (elements.length === 0) {
      // Refused rather than written: a file claiming to be a registry draft
      // with no elements looks like a broken scan, and the user would take it
      // to mean the region held nothing describable rather than that they
      // drew it around nothing.
      set({ error: 'No scanned elements sit inside that region.' });
      return;
    }

    const url = snapshot?.url ?? '';
    downloadJson(
      buildRegistryExport(elements, {
        url,
        ...(snapshot?.title === undefined ? {} : { title: snapshot.title }),
        ...(snapshot?.candidateCount === undefined
          ? {}
          : { candidateCount: snapshot.candidateCount }),
        ...(scope === 'region' && region !== undefined ? { region } : {}),
      }),
      filenameForUrl(url, scope === 'region' ? 'region-registry' : 'registry'),
    );
  },

  clearLog() {
    set({ log: [] });
  },
}));

/**
 * Lists the page, then describes each element in scope.
 *
 * One implementation for both scans. The whole page is always *listed* —
 * `state.inspect` is a single round trip and the overlay wants every box
 * regardless of scope — and only the describe loop is narrowed, because that is
 * where the cost is: one browser round trip per element, sequential.
 *
 * Sequential on purpose. Each describe drives a real browser through one
 * session; firing 150 at once would queue them behind each other anyway and
 * make a cancel meaningless.
 *
 * `scanned` keeps every listed element even for a region scan, with only the
 * in-scope ones described. That is what lets a download choose its scope
 * afterwards: the region is a filter over a full list, so scanning a region and
 * then exporting the page yields a truthful file rather than a page export
 * secretly missing everything outside a rectangle.
 */
async function runScan(
  set: (partial: Partial<LiveSessionState>) => void,
  get: () => LiveSessionState,
  region: ViewportRect | undefined,
): Promise<void> {
  const { session } = get();
  if (session === undefined || socket === undefined) {
    set({ error: 'Start a live session before scanning.' });
    return;
  }

  const scoped = region !== undefined;
  const token = Symbol('scan');
  scanToken = token;
  set({
    scan: { running: true, done: 0, total: 0, ...(scoped ? { scoped: true } : {}) },
    error: undefined,
  });

  const scanRoot = get().scanRoot;
  const listed = await sendAwaiting(session.id, 'state.inspect', {
    includeScreenshot: false,
    includeCandidates: true,
    // Rooted in the browser, so the candidate cap is spent inside the
    // container rather than on the shell around it. A region, by contrast,
    // filters boxes that were already returned.
    ...(scanRoot.length === 0 ? {} : { rootSelector: scanRoot }),
  });

  if (scanToken !== token) return;

  const snapshot = asSnapshot(listed);
  if (snapshot === undefined) {
    set({ scan: undefined, error: 'The page could not be listed.' });
    return;
  }

  const candidates = snapshot.candidates ?? [];
  const scanned: ScannedElement[] = candidates.map((candidate) => ({ ...candidate }));

  // The indices this scan will describe. Held as indices rather than a filtered
  // copy so progress and results write back into the full list by position.
  const targets = scanned
    .map((element, index) => ({ element, index }))
    .filter(({ element }) =>
      region === undefined
        ? element.bbox !== undefined
        : containedInRegion(element.bbox, region),
    );

  if (scoped && targets.length === 0) {
    // Named rather than reported as a finished scan of nothing: the likely
    // cause is a region drawn around an element it clips, and "0 / 0 done"
    // would read as "this area has no elements".
    set({
      scanned,
      showCandidates: true,
      scan: { running: false, done: 0, total: 0, scoped: true },
      error: 'No elements sit fully inside that region. Try drawing it slightly wider.',
    });
    return;
  }

  // Shown before any describe runs: the overlay and the count are useful
  // immediately, and a slow describe loop should not hold them back.
  set({
    scanned,
    showCandidates: true,
    scan: { running: true, done: 0, total: targets.length, ...(scoped ? { scoped: true } : {}) },
  });
  get().refreshSnapshot();

  for (const [position, { element, index }] of targets.entries()) {
    if (scanToken !== token) return;

    // Guarded above for both scopes: `containedInRegion` rejects a missing box,
    // and the unscoped filter requires one.
    const bbox = element.bbox;
    if (bbox === undefined) continue;

    const described = await sendAwaiting(session.id, 'element.describe', {
      point: {
        x: Math.round(bbox.x + bbox.width / 2),
        y: Math.round(bbox.y + bbox.height / 2),
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
            done: position,
            total: targets.length,
            stoppedReason: 'disconnected',
            ...(scoped ? { scoped: true } : {}),
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
      scan: {
        running: true,
        done: position + 1,
        total: targets.length,
        ...(scoped ? { scoped: true } : {}),
      },
    });
  }

  set({
    scan: {
      running: false,
      done: targets.length,
      total: targets.length,
      ...(scoped ? { scoped: true } : {}),
    },
  });
}

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
    case 'event': {
      /*
       * A streamed frame updates the picture and is never logged.
       *
       * Frames arrive tens of times a second and each carries a base64 image:
       * appending them would bury every other entry within a second and hold
       * megabytes of screenshots in the log array. They are also the one event
       * with a *rendering* job rather than an informational one.
       */
      if (message.event.type === 'browser.frame') {
        const frame = message.event.payload as LiveStateSnapshot['frame'];
        if (frame !== undefined) {
          const previous = get().snapshot;
          set({
            snapshot:
              previous === undefined
                ? // A frame before any snapshot still deserves to be shown; the
                  // URL fills in on the next state result.
                  ({ url: '', frameCount: 1, hasOpenDialog: false, capturedAt: frame.capturedAt, frame } as LiveStateSnapshot)
                : { ...previous, frame },
          });
        }
        break;
      }

      append({
        kind: 'event',
        label: message.event.type,
        detail: JSON.stringify(message.event.payload).slice(0, 200),
      });
      break;
    }

    case 'command-result': {
      // Any result clears the in-flight marker. Keyed on nothing in
      // particular on purpose: the follow loop only needs to know that the
      // socket is answering again, and tracking snapshot ids separately would
      // strand the flag forever on a result that never arrives.
      snapshotInFlight = false;

      // Settle an awaiting caller first, and before the early returns below:
      // a scan step that never learns its command failed would stall until its
      // timeout, turning one bad element into a ten-second pause.
      const waiting = pending.get(message.result.commandId);
      if (waiting !== undefined) {
        pending.delete(message.result.commandId);
        waiting(message.result.ok ? message.result.result : undefined);
      }

      if (message.result.ok) {
        /*
         * A succeeded command clears the last failure.
         *
         * Otherwise a warning outlives its cause: correcting a bad scan root
         * left "ELEMENT_NOT_FOUND: inspection root #nope" sitting above a
         * panel that had just scanned correctly. A stale warning is worse than
         * none, because it teaches the reader that the warnings are noise.
         */
        if (get().error !== undefined) set({ error: undefined });

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

        if (snapshotResult !== undefined) {
          /*
           * A frameless result never erases a frame already on screen.
           *
           * `state.inspect` and `state.snapshot` return the same shape, and
           * only the latter carries a screenshot — so an inspect landing here
           * used to replace the snapshot wholesale and leave `frame`
           * undefined. The preview's entire frame block is conditional on
           * that, so a region scan made the picture, the overlay, the region
           * and the caption all disappear at once, which looked like the scan
           * had broken the panel rather than like a missing field.
           *
           * Keeping the previous frame is also the truthful choice: it is
           * still the last picture the Runner captured of this page.
           */
          const previous = get().snapshot;
          set({
            snapshot:
              snapshotResult.frame === undefined && previous?.frame !== undefined
                ? { ...snapshotResult, frame: previous.frame }
                : snapshotResult,
          });

          // Restore this host's remembered root the first time a page from it
          // appears. Only when the box is empty, so it never overwrites what
          // the user is currently typing.
          if (get().scanRoot.length === 0) {
            const remembered = loadScanRoot(snapshotResult.url);
            if (remembered.length > 0) set({ scanRoot: remembered });
          }
        } else if (pickedResult !== undefined) set({ picked: pickedResult });
        else if (isPreviewResult(message.result.result)) {
          set({ lastPreview: message.result.result });
        }
      } else {
        append({
          kind: 'error',
          label: message.result.error?.code ?? 'command failed',
          detail: message.result.error?.message,
        });

        // Also surfaced on the panel that issued it, not only in the event log.
        // A failed login left the Live Session panel showing "not yet" with no
        // reason, while the reason sat in a column the user was not reading.
        set({
          error: `${message.result.error?.code ?? 'Command failed'}: ${
            message.result.error?.message ?? 'no reason given'
          }`,
        });
      }
      break;
    }

    case 'error':
      append({ kind: 'error', label: message.code, detail: message.message });
      break;
  }
}

/** Clears the follow timer, if one is running. */
function stopFollowing(): void {
  if (followTimer !== undefined) window.clearInterval(followTimer);
  followTimer = undefined;
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
