import type { ElementIntent } from '@runner/domain';
import type {
  LiveCommandType,
  RawLiveCommand,
  RecordingObservePayload,
  RecordingStartPayload,
} from '@runner/live-protocol';
import type { TestActionV1 } from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';
import type {
  InteractionRecorder,
  ObservedInteraction,
} from '../../modules/recorder/interaction-recorder.js';

/**
 * Recording a live session into Test IR (blueprint section 42).
 *
 * The client reports what the user did; this capability keeps the stream and
 * hands back **Test IR** when the recording stops. It emits the published
 * `TestActionV1` shape rather than the internal one, because the output is meant
 * to be submitted straight back to `POST /api/v1/executions` — a recording that
 * needed translating before it could be replayed would not be much of a
 * recording.
 *
 * No selector ever appears in the result. Targets are named, which is what lets
 * a recorded step survive the UI change that would break a captured selector.
 */

export interface RecordingStatus {
  readonly recording: boolean;
  readonly observed?: number;
  readonly testName?: string;
}

export interface RecordingResult {
  readonly recording: false;
  readonly testName: string;
  readonly steps: readonly TestActionV1[];
}

export class RecordingCapability
  implements LiveCapability<RecordingStatus | RecordingResult>
{
  readonly type = 'recording' as const;
  readonly handles: readonly LiveCommandType[] = [
    'recording.start',
    'recording.observe',
    'recording.stop',
  ];

  constructor(private readonly recorder: InteractionRecorder) {}

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<RecordingStatus | RecordingResult>> {
    const sessionId = context.session.id;

    switch (command.type as LiveCommandType) {
      case 'recording.start': {
        const payload = payloadOf<RecordingStartPayload>(command);
        const testName = payload.ok ? payload.value.testName : undefined;

        const started = this.recorder.start(sessionId, testName);
        if (!started.ok) return started;

        context.logger.info('Recording started', { testName });
        return ok({
          recording: true,
          observed: 0,
          ...(testName === undefined ? {} : { testName }),
        });
      }

      case 'recording.observe': {
        const payload = payloadOf<RecordingObservePayload>(command);
        if (!payload.ok) return payload;

        const observed = this.recorder.observe(sessionId, toInteraction(payload.value));
        if (!observed.ok) return observed;

        return ok({ recording: true, observed: observed.value });
      }

      case 'recording.stop': {
        // Read the name *before* stopping: stopping drops the recording, so
        // asking afterwards would always fall back to the default.
        const testName = this.recorder.current(sessionId)?.testName ?? 'Recorded test';

        const stopped = this.recorder.stop(sessionId);
        if (!stopped.ok) return stopped;

        return ok({
          recording: false,
          testName,
          // Mapped to the public shape here, at the boundary, so the internal
          // action model stays free to change.
          steps: stopped.value.map(toPublicAction),
        });
      }

      default:
        return err(RunnerErrors.liveCommandUnsupported(command.type));
    }
  }
}

/**
 * Narrows the wire payload to the recorder's own input type.
 *
 * The wire target carries only `elementId`, `name` and `role`; widening it to a
 * full `ElementIntent` here keeps the recorder independent of the protocol.
 */
function toInteraction(payload: RecordingObservePayload): ObservedInteraction {
  const interaction: Record<string, unknown> = { action: payload.action };

  if (payload.target !== undefined) {
    const target: Record<string, unknown> = {};
    if (payload.target.elementId !== undefined) target.elementId = payload.target.elementId;
    if (payload.target.name !== undefined) target.name = payload.target.name;
    if (payload.target.role !== undefined) target.role = payload.target.role;
    interaction.target = target as ElementIntent;
  }

  if (payload.value !== undefined) interaction.value = payload.value;
  if (payload.at !== undefined) interaction.at = payload.at;

  return interaction as unknown as ObservedInteraction;
}

/** Internal action -> published `TestActionV1`. */
function toPublicAction(action: {
  id: string;
  type: string;
  label: string;
  target?: ElementIntent;
  value?: string | number | boolean;
}): TestActionV1 {
  const step: Record<string, unknown> = {
    id: action.id,
    type: action.type,
    label: action.label,
  };

  if (action.target !== undefined) step.target = action.target;
  if (action.value !== undefined) step.value = action.value;

  return step as unknown as TestActionV1;
}
