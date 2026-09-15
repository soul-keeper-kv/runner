import type { LiveEventType, LiveSessionEvent } from '@runner/live-protocol';

/**
 * The internal event bus (blueprint section 29).
 *
 * Every consumer — timeline, recorder, registry learner, WebSocket fan-out,
 * a later AI observer — attaches here rather than to the browser adapter, so a
 * new consumer never requires a change to the adapter.
 */

export type EventHandler<T = unknown> = (event: LiveSessionEvent<T>) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

export interface EventBusPort {
  publish<T>(event: LiveSessionEvent<T>): Promise<void>;
  subscribe<T>(type: LiveEventType, handler: EventHandler<T>): Subscription;
  /** Receives every event; used by the timeline and the WebSocket bridge. */
  subscribeAll(handler: EventHandler): Subscription;
  subscribeSession(sessionId: string, handler: EventHandler): Subscription;
}
