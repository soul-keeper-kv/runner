import type { EventBusPort, EventHandler, Subscription } from '@runner/application';
import type { LiveEventType, LiveSessionEvent } from '@runner/live-protocol';
import type { Logger } from '@runner/shared';

/**
 * In-process event bus (blueprint section 29).
 *
 * Normalized browser and execution events are published here, and every
 * consumer — timeline, recorder, registry learner, the WebSocket bridge —
 * subscribes rather than being called directly by the adapter. Adding a
 * consumer therefore never requires touching the producer.
 *
 * A handler that throws is logged and isolated: one bad subscriber must not
 * abort an execution or prevent other subscribers from seeing the event.
 */
export class InProcessEventBus implements EventBusPort {
  private readonly byType = new Map<LiveEventType, Set<EventHandler>>();
  private readonly all = new Set<EventHandler>();
  private readonly bySession = new Map<string, Set<EventHandler>>();

  constructor(private readonly logger: Logger) {}

  async publish<T>(event: LiveSessionEvent<T>): Promise<void> {
    const handlers = [
      ...(this.byType.get(event.type) ?? []),
      ...this.all,
      ...(this.bySession.get(event.sessionId) ?? []),
    ];

    for (const handler of handlers) {
      try {
        await handler(event as LiveSessionEvent);
      } catch (cause) {
        this.logger.error('Event handler failed', {
          eventType: event.type,
          sessionId: event.sessionId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  subscribe<T>(type: LiveEventType, handler: EventHandler<T>): Subscription {
    const handlers = this.byType.get(type) ?? new Set<EventHandler>();
    handlers.add(handler as EventHandler);
    this.byType.set(type, handlers);
    return { unsubscribe: () => handlers.delete(handler as EventHandler) };
  }

  subscribeAll(handler: EventHandler): Subscription {
    this.all.add(handler);
    return { unsubscribe: () => this.all.delete(handler) };
  }

  subscribeSession(sessionId: string, handler: EventHandler): Subscription {
    const handlers = this.bySession.get(sessionId) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.bySession.set(sessionId, handlers);
    return { unsubscribe: () => handlers.delete(handler) };
  }
}
