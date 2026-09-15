import { Redis } from 'ioredis';
import type { EventBusPort, EventHandler, Subscription } from '@runner/application';
import type { LiveEventType, LiveSessionEvent } from '@runner/live-protocol';
import type { Logger } from '@runner/shared';

/**
 * The event bus across processes, over Redis pub/sub.
 *
 * `InProcessEventBus` is the right bus inside one process and useless between
 * two: the worker owns the browser and the API owns the public WebSocket, so an
 * event the worker produces — a streamed frame, a navigation, a picked element
 * — has no way to reach the client that is waiting for it. This is that way.
 *
 * Pub/sub rather than the blocking lists `RedisLiveCommandTransport` uses, and
 * the difference is the messaging shape, not taste. A command is request/reply
 * with exactly one consumer, so a list is right: whoever pops it owns it. An
 * event is fan-out to however many subscribers happen to be attached, and it is
 * worthless once it is late — a frame from two seconds ago helps nobody. Pub/sub
 * drops for absent subscribers instead of accumulating a backlog, which for
 * this traffic is the behaviour you want rather than a limitation.
 *
 * Nothing here is durable, deliberately. A subscriber that reconnects has
 * missed whatever arrived while it was gone, and for a live view that is
 * correct — it wants the *current* page, not a replay.
 */

/** One channel per session, so a socket subscribes to its own traffic only. */
const SESSION_CHANNEL_PREFIX = 'runner:live:events:';

/** Everything, for the timeline and any all-events consumer. */
const ALL_CHANNEL = 'runner:live:events:all';

export class RedisEventBus implements EventBusPort {
  /**
   * Publishing and subscribing need separate connections: a Redis connection in
   * subscriber mode rejects ordinary commands, so sharing one would break every
   * publish the moment the first subscription was made.
   */
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  private readonly byType = new Map<LiveEventType, Set<EventHandler>>();
  private readonly all = new Set<EventHandler>();
  private readonly bySession = new Map<string, Set<EventHandler>>();

  /** Channels this instance has told Redis about, so it subscribes once. */
  private readonly subscribed = new Set<string>();

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
  ) {
    this.publisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.subscriber.on('message', (channel: string, payload: string) => {
      void this.deliver(channel, payload);
    });
  }

  async publish<T>(event: LiveSessionEvent<T>): Promise<void> {
    const body = JSON.stringify(event);

    try {
      // Both channels, because a session subscriber and an all-events
      // subscriber are different consumers with different lifetimes. Publishing
      // once and fanning out in the subscriber would mean every process
      // received every session's frames.
      await Promise.all([
        this.publisher.publish(`${SESSION_CHANNEL_PREFIX}${event.sessionId}`, body),
        this.publisher.publish(ALL_CHANNEL, body),
      ]);
    } catch (cause) {
      // A dropped event must not fail the work that produced it: a frame that
      // never reaches a viewer is a worse picture, not a broken session.
      this.logger.debug('Event publish failed', {
        eventType: event.type,
        sessionId: event.sessionId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  subscribe<T>(type: LiveEventType, handler: EventHandler<T>): Subscription {
    const handlers = this.byType.get(type) ?? new Set<EventHandler>();
    handlers.add(handler as EventHandler);
    this.byType.set(type, handlers);

    // A type subscription cannot know which sessions will produce it, so it
    // listens to everything and filters on arrival.
    void this.ensureSubscribed(ALL_CHANNEL);

    return { unsubscribe: () => handlers.delete(handler as EventHandler) };
  }

  subscribeAll(handler: EventHandler): Subscription {
    this.all.add(handler);
    void this.ensureSubscribed(ALL_CHANNEL);
    return { unsubscribe: () => this.all.delete(handler) };
  }

  subscribeSession(sessionId: string, handler: EventHandler): Subscription {
    const channel = `${SESSION_CHANNEL_PREFIX}${sessionId}`;
    const handlers = this.bySession.get(sessionId) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.bySession.set(sessionId, handlers);

    void this.ensureSubscribed(channel);

    return {
      unsubscribe: () => {
        handlers.delete(handler);
        if (handlers.size > 0) return;

        // Last listener for this session: stop receiving its traffic. A live
        // view streams frames continuously, so a channel nobody reads is real
        // bandwidth rather than a tidiness concern.
        this.bySession.delete(sessionId);
        this.subscribed.delete(channel);
        void this.subscriber.unsubscribe(channel).catch(() => undefined);
      },
    };
  }

  async close(): Promise<void> {
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }

  private async ensureSubscribed(channel: string): Promise<void> {
    if (this.subscribed.has(channel)) return;
    this.subscribed.add(channel);

    try {
      await this.subscriber.subscribe(channel);
    } catch (cause) {
      this.subscribed.delete(channel);
      this.logger.warn('Could not subscribe to an event channel', {
        channel,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private async deliver(channel: string, payload: string): Promise<void> {
    let event: LiveSessionEvent;
    try {
      event = JSON.parse(payload) as LiveSessionEvent;
    } catch {
      this.logger.debug('Discarded an unparsable event', { channel });
      return;
    }

    // The all-channel feeds type and all-events subscribers; a session channel
    // feeds that session's. Keeping them apart is what stops one event being
    // delivered twice to a consumer subscribed both ways.
    const handlers =
      channel === ALL_CHANNEL
        ? [...(this.byType.get(event.type) ?? []), ...this.all]
        : [...(this.bySession.get(event.sessionId) ?? [])];

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (cause) {
        this.logger.error('Event handler failed', {
          eventType: event.type,
          sessionId: event.sessionId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }
}
