import type { LiveCommandResult, RawLiveCommand } from '@runner/live-protocol';
import type { Result } from '@runner/shared';

/**
 * Carries a live command from the API to the worker and its result back
 * (blueprint sections 2.5, 27 and 28).
 *
 * This port exists because of a boundary the Runner refuses to collapse: the
 * API owns the public WebSocket, the worker owns the browser, and neither may
 * import the other. A live command therefore has to cross a process boundary —
 * but unlike an execution it is *interactive*, so the caller waits for the
 * answer rather than polling a queue.
 *
 * That is why this is not `ExecutionQueuePort`. A queue is fire-and-forget with
 * retries; a selector preview is request/reply with a short deadline, and a
 * retried `browser.navigate` would be a bug rather than resilience.
 *
 * Nothing here mentions Redis. The API holds a `dispatch` side, the worker holds
 * a `serve` side, and the transport in between is a composition-root decision.
 */

/** Handles one command in the process that owns the browser. */
export type LiveCommandHandler = (command: RawLiveCommand) => Promise<LiveCommandResult>;

export interface LiveCommandDispatchOptions {
  /**
   * How long to wait for the worker's reply.
   *
   * A live command holds a user's attention, so the deadline is short and a
   * miss is reported as such: leaving a socket waiting indefinitely on a worker
   * that has died is worse than telling the client the command timed out.
   */
  readonly timeoutMs?: number;
}

export interface LiveCommandTransportPort {
  /**
   * Sends a command to the worker owning live sessions and awaits its result.
   *
   * A failure here means the command could not be *delivered or answered* — the
   * worker is gone, or it did not reply in time. A command that reached a
   * capability and failed there returns `ok` with a `LiveCommandResult` whose
   * `ok` is false, because that is a normal outcome the client must render.
   */
  dispatch(
    command: RawLiveCommand,
    options?: LiveCommandDispatchOptions,
  ): Promise<Result<LiveCommandResult>>;

  /** Registers the handler that serves commands. Called only by the worker. */
  serve(handler: LiveCommandHandler): Promise<Result<void>>;

  close(): Promise<void>;
}
