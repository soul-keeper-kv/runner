import type { SelectorDefinition } from '@runner/selector-model';

/**
 * Normalized live events (blueprint section 29).
 *
 * Browser-native events are translated into this vocabulary by the adapter, so
 * every downstream consumer — timeline, recorder, registry learner, the live
 * WebSocket, a future AI observer — subscribes to one stable shape rather than
 * to Playwright's API surface.
 */

export const LIVE_EVENT_TYPES = [
  // page lifecycle
  'page.navigated',
  'dom.changed',
  'frame.attached',
  'popup.opened',
  'dialog.opened',

  // network & console
  'network.request',
  'network.response',
  'console.message',
  'console.error',

  // interaction
  'element.selected',
  'element.picked',

  // execution
  'execution.started',
  'execution.step.started',
  'execution.step.completed',
  'execution.completed',
  'execution.failed',
  'execution.waiting_user',

  // selector & registry
  'selector.failed',
  'selector.preview.result',
  'registry.proposed',
  'registry.updated',

  // session
  'session.state.changed',
  'session.closed',
  'command.failed',

  // live view
  'browser.frame',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The result of previewing a selector against the live page (section 30). */
export interface SelectorPreviewResult {
  readonly matchCount: number;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly bbox?: BoundingBox;
  readonly score?: number;
  readonly stability?: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly selector: SelectorDefinition;
  /** Present when the selector could not be evaluated at all. */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface PickedElementSnapshot {
  readonly runtimeId: string;
  readonly tag: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly text?: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly bbox?: BoundingBox;
  readonly candidateSelectors: readonly {
    readonly selector: SelectorDefinition;
    readonly score: number;
    readonly matchCount: number;
  }[];
  /** Set when the picked element already exists in the Registry. */
  readonly matchedElementId?: string;
}

/** A screenshot frame for the MVP live view (blueprint section 37). */
export interface BrowserFramePayload {
  readonly format: 'png' | 'jpeg';
  /** Base64-encoded image data. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}

export interface LiveSessionEvent<TPayload = unknown> {
  readonly id: string;
  readonly sessionId: string;
  readonly type: LiveEventType;
  /** Monotonic per session; clients use it to detect dropped events. */
  readonly sequence: number;
  readonly timestamp: string;
  /** Correlates an event with the command that caused it. */
  readonly commandId?: string;
  readonly payload: TPayload;
}

export interface LiveCommandResult<TResult = unknown> {
  readonly commandId: string;
  readonly sessionId: string;
  readonly ok: boolean;
  readonly result?: TResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
  readonly completedAt: string;
  /** Session revision after the command was applied. */
  readonly revision: number;
}

/** Messages the server may send over the live WebSocket. */
export type LiveServerMessage =
  | { readonly kind: 'event'; readonly event: LiveSessionEvent }
  | { readonly kind: 'command-result'; readonly result: LiveCommandResult }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

/** Messages the client may send over the live WebSocket. */
export type LiveClientMessage =
  | { readonly kind: 'command'; readonly command: unknown }
  | { readonly kind: 'ping' };

export function isLiveEventType(value: unknown): value is LiveEventType {
  return typeof value === 'string' && (LIVE_EVENT_TYPES as readonly string[]).includes(value);
}
