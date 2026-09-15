import type { BrowserPort } from '@runner/application';
import type {
  LiveCapabilityType,
  LiveCommandType,
  LiveSession,
  RawLiveCommand,
} from '@runner/live-protocol';
import { capabilityForCommand } from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * Capability-based live command dispatch (blueprint section 28).
 *
 * The blueprint is explicit that this must not become one giant
 * `LivePreviewService`. Instead each command namespace — browser, selector,
 * element, registry, execution, state — is owned by a capability that can be
 * built, tested and replaced on its own, and a namespace that has not shipped
 * simply has no capability registered.
 *
 * The practical consequence: an unimplemented command returns a precise
 * LIVE_COMMAND_UNSUPPORTED naming the command, rather than a generic failure or
 * a silent no-op.
 */

export interface LiveSessionContext {
  readonly session: LiveSession;
  readonly browser: BrowserPort;
  readonly logger: Logger;
  /**
   * Records what a capability changed about the session itself.
   *
   * Only `auth` uses it so far, and only for `authenticatedAs`: the runtime
   * owns the session record, so a capability that wrote to the store directly
   * would race the revision the runtime is about to publish. Returning the
   * patch through the runtime keeps one writer.
   */
  patchSession?(patch: Partial<Pick<LiveSession, 'authenticatedAs'>>): void;
}

export interface LiveCapability<TResult = unknown> {
  readonly type: LiveCapabilityType;
  /** The command types this capability claims. */
  readonly handles: readonly LiveCommandType[];
  execute(command: RawLiveCommand, context: LiveSessionContext): Promise<Result<TResult>>;
}

export class CapabilityRegistry {
  private readonly byCommand = new Map<LiveCommandType, LiveCapability>();

  constructor(private readonly logger: Logger) {}

  register(capability: LiveCapability): void {
    for (const commandType of capability.handles) {
      const existing = this.byCommand.get(commandType);
      if (existing !== undefined) {
        // Two capabilities claiming one command is a wiring bug, not a
        // runtime condition: fail loudly at startup rather than picking one.
        throw RunnerErrors.internal(
          `Command "${commandType}" is already handled by capability "${existing.type}".`,
        );
      }
      this.byCommand.set(commandType, capability);
    }

    this.logger.debug('Live capability registered', {
      capability: capability.type,
      commands: capability.handles.length,
    });
  }

  async dispatch(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<unknown>> {
    const commandType = command.type as LiveCommandType;
    const capability = this.byCommand.get(commandType);

    if (capability === undefined) {
      const expected = capabilityForCommand(commandType);
      this.logger.warn('No capability registered for command', {
        commandType,
        expectedCapability: expected,
      });
      return err(RunnerErrors.liveCommandUnsupported(command.type));
    }

    const started = Date.now();
    const result = await capability.execute(command, context);

    context.logger.debug('Live command dispatched', {
      commandType,
      capability: capability.type,
      durationMs: Date.now() - started,
      result: result.ok ? 'ok' : result.error.code,
    });

    return result;
  }

  /** The command types this build can actually serve. */
  supportedCommands(): LiveCommandType[] {
    return [...this.byCommand.keys()];
  }

  supports(commandType: string): boolean {
    return this.byCommand.has(commandType as LiveCommandType);
  }
}

/** Reads a command payload with a narrow, checked cast. */
export function payloadOf<T>(command: RawLiveCommand): Result<T> {
  if (command.payload === null || typeof command.payload !== 'object') {
    return err(RunnerErrors.validationFailed('Command payload must be an object.'));
  }
  return ok(command.payload as T);
}
