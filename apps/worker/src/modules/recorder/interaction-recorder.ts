import type { ElementIntent, TestAction } from '@runner/domain';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * Turns observed interactions into Test IR (blueprint section 42).
 *
 * The output is **Test IR, not Playwright code**. Recording to code would bake a
 * selector into the artifact and lose the registry reference that lets a
 * recorded step survive a UI change — which is the entire reason this Runner
 * treats the Registry as the source of truth and generated code as an output.
 *
 * Observation is client-driven. The worker does not inject listeners into the
 * page, because doing so would alter the application under test; the live
 * workspace reports what the user did and this module decides what it *means*.
 *
 * That decision is the substance here, and it is why normalization matters more
 * than capture: a raw event stream makes a terrible test. A person typing into a
 * field produces one `fill`, not eight keystrokes; clicking a field before
 * typing into it is focus, not a step; and re-navigating to the page you are
 * already on is noise.
 */

/** One interaction as reported by the client, already named. */
export interface ObservedInteraction {
  readonly action:
    | 'click'
    | 'dblclick'
    | 'fill'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'hover'
    | 'press'
    | 'goto';
  readonly target?: ElementIntent;
  readonly value?: string | number | boolean;
  readonly at?: string;
}

export interface RecordingSession {
  readonly sessionId: string;
  readonly testName: string;
  readonly startedAt: string;
  readonly interactions: readonly ObservedInteraction[];
}

/** How many interactions one recording may hold before it is refused. */
const MAX_INTERACTIONS = 500;

export class InteractionRecorder {
  private readonly sessions = new Map<string, RecordingSession>();

  constructor(private readonly logger: Logger) {}

  start(sessionId: string, testName?: string, startedAt = new Date().toISOString()): Result<void> {
    if (this.sessions.has(sessionId)) {
      // Restarting silently would discard interactions the user believes are
      // recorded, so the caller is told to stop the current recording first.
      return err(
        RunnerErrors.validationFailed(
          `A recording is already in progress for session "${sessionId}".`,
          { sessionId },
        ),
      );
    }

    this.sessions.set(sessionId, {
      sessionId,
      testName: testName ?? 'Recorded test',
      startedAt,
      interactions: [],
    });

    this.logger.info('Recording started', { sessionId });
    return ok(undefined);
  }

  /** Appends one observed interaction to an in-progress recording. */
  observe(sessionId: string, interaction: ObservedInteraction): Result<number> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return err(
        RunnerErrors.validationFailed(
          `No recording is in progress for session "${sessionId}".`,
          { sessionId },
        ),
      );
    }

    if (session.interactions.length >= MAX_INTERACTIONS) {
      return err(
        RunnerErrors.validationFailed(
          `A recording may hold at most ${MAX_INTERACTIONS} interactions.`,
          { sessionId, limit: MAX_INTERACTIONS },
        ),
      );
    }

    // An action that needs a target but carries none cannot become a step: a
    // recorded step with no way to find its element is worse than a gap.
    if (interaction.action !== 'goto' && !hasUsableTarget(interaction.target)) {
      return err(
        RunnerErrors.validationFailed(
          `A recorded "${interaction.action}" needs a named target.`,
          { action: interaction.action },
        ),
      );
    }

    if (interaction.action === 'goto' && typeof interaction.value !== 'string') {
      return err(RunnerErrors.validationFailed('A recorded "goto" needs a URL value.'));
    }

    this.sessions.set(sessionId, {
      ...session,
      interactions: [...session.interactions, interaction],
    });

    return ok(session.interactions.length + 1);
  }

  /**
   * Ends the recording and returns the normalized Test IR steps.
   *
   * The recording is dropped afterwards: a recorder that kept state would let a
   * second stop return steps the user had already taken away.
   */
  stop(sessionId: string): Result<TestAction[]> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return err(
        RunnerErrors.validationFailed(
          `No recording is in progress for session "${sessionId}".`,
          { sessionId },
        ),
      );
    }

    this.sessions.delete(sessionId);

    const steps = toTestActions(session.interactions);
    this.logger.info('Recording stopped', {
      sessionId,
      observed: session.interactions.length,
      steps: steps.length,
    });

    return ok(steps);
  }

  /** The recording in progress for a session, if any. */
  current(sessionId: string): RecordingSession | undefined {
    return this.sessions.get(sessionId);
  }

  isRecording(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

/**
 * Normalizes an interaction stream into steps.
 *
 * Three rules, each removing noise a raw stream would otherwise turn into a
 * brittle test:
 *
 *  1. Consecutive `fill`s on the same target collapse to the final value — a
 *     person typing produces many events and means one.
 *  2. A `click` immediately followed by a `fill` on the same target is focus,
 *     not an action worth asserting.
 *  3. A `goto` to the URL already current is a no-op.
 */
export function normalizeInteractions(
  interactions: readonly ObservedInteraction[],
): ObservedInteraction[] {
  const normalized: ObservedInteraction[] = [];
  let currentUrl: string | undefined;

  for (const interaction of interactions) {
    if (interaction.action === 'goto') {
      const url = String(interaction.value ?? '');
      if (url === currentUrl) continue;
      currentUrl = url;
      normalized.push(interaction);
      continue;
    }

    const previous = normalized[normalized.length - 1];

    if (
      interaction.action === 'fill' &&
      previous?.action === 'fill' &&
      sameTarget(previous.target, interaction.target)
    ) {
      // Keep the last value typed, not the keystroke history.
      normalized[normalized.length - 1] = interaction;
      continue;
    }

    if (
      interaction.action === 'fill' &&
      previous?.action === 'click' &&
      sameTarget(previous.target, interaction.target)
    ) {
      // The click only moved focus; the fill is the step.
      normalized[normalized.length - 1] = interaction;
      continue;
    }

    normalized.push(interaction);
  }

  return normalized;
}

/** Maps normalized interactions onto internal Test IR actions. */
export function toTestActions(
  interactions: readonly ObservedInteraction[],
): TestAction[] {
  return normalizeInteractions(interactions).map((interaction, index) => {
    const step: Record<string, unknown> = {
      id: `rec_${index + 1}`,
      type: interaction.action,
      label: describeInteraction(interaction),
      preconditions: [],
      continueOnFailure: false,
    };

    if (interaction.target !== undefined) step.target = interaction.target;
    if (interaction.value !== undefined) step.value = interaction.value;

    return step as unknown as TestAction;
  });
}

/** A short, human label for the timeline. */
function describeInteraction(interaction: ObservedInteraction): string {
  if (interaction.action === 'goto') return `go to ${String(interaction.value ?? '')}`;

  const name =
    interaction.target?.name ?? interaction.target?.elementId ?? 'the target element';

  switch (interaction.action) {
    case 'fill':
      // The value is deliberately not in the label: a recorded password would
      // otherwise appear in every timeline that replays this step.
      return `fill ${name}`;
    case 'select':
      return `select in ${name}`;
    case 'press':
      return `press ${String(interaction.value ?? '')} on ${name}`;
    default:
      return `${interaction.action} ${name}`;
  }
}

function hasUsableTarget(target: ElementIntent | undefined): boolean {
  if (target === undefined) return false;
  return (
    isPresent(target.elementId) ||
    isPresent(target.name) ||
    isPresent(target.description)
  );
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function sameTarget(a: ElementIntent | undefined, b: ElementIntent | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (isPresent(a.elementId) || isPresent(b.elementId)) return a.elementId === b.elementId;
  return a.name === b.name && a.role === b.role;
}
