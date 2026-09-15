import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';

/**
 * The typed live command protocol (blueprint sections 27, 28, 57).
 *
 * Every realtime interaction is a named command with a typed payload and a
 * typed result. The frontend never reaches for Playwright; it emits a command,
 * a capability handler interprets it, and only an adapter behind a port touches
 * a browser (blueprint section 3.1).
 */

export const LIVE_COMMAND_TYPES = [
  // browser
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.refresh',

  // selector authoring
  'selector.preview',
  'selector.validate',
  'selector.confirm',
  'selector.reject',

  // element inspection
  'element.highlight',
  'element.pick.start',
  'element.pick.cancel',
  'element.describe',

  // registry editing
  'registry.create-draft',
  'registry.update-draft',
  'registry.rename',
  'registry.update-description',
  'registry.update-selector',
  'registry.confirm',
  'registry.reject',

  // execution control
  'step.execute',
  'step.retry',
  'step.insert-before',
  'step.insert-after',
  'session.pause',
  'session.resume',

  // authentication
  'auth.login',
  'auth.status',
  'auth.logout',

  // state
  'state.snapshot',
  'state.inspect',

  // recording
  'recording.start',
  'recording.observe',
  'recording.stop',
] as const;

export type LiveCommandType = (typeof LIVE_COMMAND_TYPES)[number];

/** The capability that owns each command, derived from its namespace. */
export type LiveCapabilityType =
  | 'browser'
  | 'selector'
  | 'element'
  | 'registry'
  | 'execution'
  | 'recording'
  | 'state'
  | 'auth'
  | 'debug';

const CAPABILITY_BY_NAMESPACE: Readonly<Record<string, LiveCapabilityType>> = {
  browser: 'browser',
  selector: 'selector',
  element: 'element',
  registry: 'registry',
  step: 'execution',
  session: 'execution',
  state: 'state',
  recording: 'recording',
  auth: 'auth',
  debug: 'debug',
};

export function capabilityForCommand(type: LiveCommandType): LiveCapabilityType | undefined {
  const namespace = type.split('.')[0];
  return namespace === undefined ? undefined : CAPABILITY_BY_NAMESPACE[namespace];
}

export function isLiveCommandType(value: unknown): value is LiveCommandType {
  return typeof value === 'string' && (LIVE_COMMAND_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface BrowserNavigatePayload {
  readonly url: string;
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface SelectorPreviewPayload {
  readonly elementId?: string;
  readonly selector: SelectorDefinition;
  readonly scoped?: ScopedSelector;
}

export interface SelectorConfirmPayload {
  readonly elementId: string;
  readonly selector: SelectorDefinition;
  readonly reason?: string;
}

export interface SelectorRejectPayload {
  readonly elementId: string;
  readonly selector: SelectorDefinition;
  readonly reason?: string;
}

export interface ElementHighlightPayload {
  readonly elementId?: string;
  readonly selector?: SelectorDefinition;
  readonly durationMs?: number;
}

export interface ElementPickStartPayload {
  /** Restricts picking to a subtree, e.g. a component root. */
  readonly withinSelector?: SelectorDefinition;
}

/**
 * A point in the live frame's coordinate space.
 *
 * The same space `probe` and `state.snapshot` report boxes in — the browser
 * viewport — so a click on the rendered frame maps straight onto the page
 * without the client ever converting a locator back into CSS.
 */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * How `element.describe` names its target.
 *
 * Exactly one of these is used, in this order: a point (how picking works, from
 * a click on the frame), or a selector (how the editor asks about something it
 * already has). `runtimeId` remains accepted for a caller holding one from a
 * snapshot, but it is snapshot-local and does not survive a page change, so a
 * point is the reliable form.
 */
export interface ElementDescribePayload {
  readonly point?: ViewportPoint;
  readonly selector?: SelectorDefinition;
  readonly runtimeId?: string;
}

export interface RegistryDraftPayload {
  readonly elementId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly selector?: SelectorDefinition;
  readonly aliases?: readonly string[];
}

export interface RegistryDecisionPayload {
  readonly modificationId: string;
  readonly reason?: string;
}

export interface StepExecutePayload {
  readonly stepId: string;
}

export interface StateSnapshotPayload {
  readonly includeScreenshot?: boolean;
  readonly includeCandidates?: boolean;
}

/**
 * Authenticates the live browser as a Runner-owned execution profile.
 *
 * The payload names a *profile*, never a credential. That is the same rule Test
 * IR follows (blueprint section 50), and it matters more here than anywhere
 * else: this command arrives over a WebSocket from a browser tab, so accepting
 * a username and password would put credentials in a client, in a socket frame
 * and in whatever logs sit between the two.
 *
 * `force` replays the login even when a stored session exists — how a user
 * recovers after the application invalidated the session under them, which
 * otherwise looks like an inexplicable "logged out" page in the live view.
 */
export interface AuthLoginPayload {
  readonly profileRef: string;
  readonly force?: boolean;
}

/**
 * What the session believes about its own authentication.
 *
 * `authenticatedAs` is reported from what the Runner actually did — a restored
 * session or a completed login — never inferred from page content. Concluding
 * "there is a Sign out link, so we are logged in" is how a whole suite runs
 * against a login page.
 */
export interface AuthStatusResult {
  readonly authenticatedAs?: string;
  /** True when a stored session exists for the profile and was applied. */
  readonly fromStoredSession: boolean;
  readonly profileRef?: string;
  readonly capturedAt?: string;
  readonly expiresAt?: string;
}

/**
 * One interaction the user performed, reported by the client.
 *
 * Recording is client-driven on purpose. Injecting listeners into the page to
 * observe clicks would alter the application under test — the same objection
 * that keeps pick mode a client state (Phase 9). The workspace already knows
 * what the user did, so it reports it here and the worker normalizes the stream
 * into Test IR.
 *
 * The target is named, never a selector: a recorded step must survive a UI
 * change, which is only true if it references the element by meaning.
 */
export interface RecordingObservePayload {
  readonly action: 'click' | 'dblclick' | 'fill' | 'select' | 'check' | 'uncheck' | 'hover' | 'press' | 'goto';
  /** How the element is named. Absent for `goto`. */
  readonly target?: {
    readonly elementId?: string;
    readonly name?: string;
    readonly role?: string;
  };
  /** Typed text, selected option, key, or the URL for `goto`. */
  readonly value?: string | number | boolean;
  /** Client timestamp, used only to order the stream. */
  readonly at?: string;
}

export interface RecordingStartPayload {
  /** Optional name for the test case the recording becomes. */
  readonly testName?: string;
}

/** Maps each command type to its payload, so handlers are type-checked. */
export interface LiveCommandPayloadMap {
  'browser.navigate': BrowserNavigatePayload;
  'browser.back': Record<string, never>;
  'browser.forward': Record<string, never>;
  'browser.refresh': Record<string, never>;

  'selector.preview': SelectorPreviewPayload;
  'selector.validate': SelectorPreviewPayload;
  'selector.confirm': SelectorConfirmPayload;
  'selector.reject': SelectorRejectPayload;

  'element.highlight': ElementHighlightPayload;
  'element.pick.start': ElementPickStartPayload;
  'element.pick.cancel': Record<string, never>;
  'element.describe': ElementDescribePayload;

  'registry.create-draft': RegistryDraftPayload;
  'registry.update-draft': RegistryDraftPayload & { readonly modificationId: string };
  'registry.rename': { readonly elementId: string; readonly displayName: string };
  'registry.update-description': { readonly elementId: string; readonly description: string };
  'registry.update-selector': { readonly elementId: string; readonly selector: SelectorDefinition };
  'registry.confirm': RegistryDecisionPayload;
  'registry.reject': RegistryDecisionPayload;

  'step.execute': StepExecutePayload;
  'step.retry': StepExecutePayload;
  'step.insert-before': { readonly stepId: string; readonly action: unknown };
  'step.insert-after': { readonly stepId: string; readonly action: unknown };
  'session.pause': Record<string, never>;
  'session.resume': Record<string, never>;

  'auth.login': AuthLoginPayload;
  'auth.status': Record<string, never>;
  'auth.logout': Record<string, never>;

  'state.snapshot': StateSnapshotPayload;
  // The same payload as `state.snapshot`, with the defaults inverted: inspect
  // returns candidates and no frame unless asked otherwise. One shape, because
  // the two commands run one code path and must not disagree about the page.
  'state.inspect': StateSnapshotPayload;

  'recording.start': RecordingStartPayload;
  'recording.observe': RecordingObservePayload;
  'recording.stop': Record<string, never>;
}

export interface LiveSessionCommand<T extends LiveCommandType = LiveCommandType> {
  readonly id: string;
  readonly sessionId: string;
  readonly type: T;
  readonly payload: LiveCommandPayloadMap[T];
  readonly issuedAt?: string;
}

/** A generic command shape for transport, before the type is narrowed. */
export interface RawLiveCommand {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly issuedAt?: string;
}
