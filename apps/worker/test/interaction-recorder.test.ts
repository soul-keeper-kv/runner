import { describe, expect, it } from 'vitest';
import { noopLogger } from '@runner/shared';
import {
  InteractionRecorder,
  normalizeInteractions,
  toTestActions,
  type ObservedInteraction,
} from '../src/modules/recorder/interaction-recorder.js';

/**
 * Normalization is the substance of the recorder, not capture.
 *
 * A raw event stream makes a terrible test: a person typing produces dozens of
 * events and means one `fill`, clicking a field before typing is focus rather
 * than a step, and re-navigating to the current page is noise. These tests pin
 * those decisions, plus the two rules that keep a recording safe to replay —
 * no selectors, and no typed values in labels.
 */

const SESSION = 'ls_rec';

function observe(
  action: ObservedInteraction['action'],
  target?: { name?: string; role?: string; elementId?: string },
  value?: string | number | boolean,
): ObservedInteraction {
  return {
    action,
    ...(target === undefined ? {} : { target }),
    ...(value === undefined ? {} : { value }),
  };
}

describe('recording lifecycle', () => {
  it('records, observes and returns steps', () => {
    const recorder = new InteractionRecorder(noopLogger);

    expect(recorder.start(SESSION, 'Login flow').ok).toBe(true);
    expect(recorder.isRecording(SESSION)).toBe(true);
    expect(recorder.observe(SESSION, observe('goto', undefined, 'https://app.test/')).ok).toBe(true);
    expect(recorder.observe(SESSION, observe('click', { name: 'Login' })).ok).toBe(true);

    const stopped = recorder.stop(SESSION);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.value).toHaveLength(2);
    expect(recorder.isRecording(SESSION)).toBe(false);
  });

  it('refuses to start a second recording over a live one', () => {
    // Restarting silently would discard interactions the user believes are safe.
    const recorder = new InteractionRecorder(noopLogger);
    recorder.start(SESSION);

    const again = recorder.start(SESSION);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses to observe with no recording in progress', () => {
    const recorder = new InteractionRecorder(noopLogger);

    const observed = recorder.observe(SESSION, observe('click', { name: 'Login' }));

    expect(observed.ok).toBe(false);
    if (observed.ok) return;
    expect(observed.error.code).toBe('VALIDATION_FAILED');
  });

  it('drops the recording once stopped, so a second stop cannot re-emit it', () => {
    const recorder = new InteractionRecorder(noopLogger);
    recorder.start(SESSION);
    recorder.observe(SESSION, observe('click', { name: 'Login' }));
    recorder.stop(SESSION);

    expect(recorder.stop(SESSION).ok).toBe(false);
  });

  it('refuses an action that needs a target but carries none', () => {
    // A recorded step with no way to find its element is worse than a gap.
    const recorder = new InteractionRecorder(noopLogger);
    recorder.start(SESSION);

    const observed = recorder.observe(SESSION, observe('click'));

    expect(observed.ok).toBe(false);
    if (observed.ok) return;
    expect(observed.error.message).toContain('named target');
  });

  it('refuses a target that names nothing usable', () => {
    const recorder = new InteractionRecorder(noopLogger);
    recorder.start(SESSION);

    // A role alone cannot find one element.
    expect(recorder.observe(SESSION, observe('click', { role: 'button' })).ok).toBe(false);
  });

  it('refuses a goto with no URL', () => {
    const recorder = new InteractionRecorder(noopLogger);
    recorder.start(SESSION);

    expect(recorder.observe(SESSION, observe('goto')).ok).toBe(false);
  });

  it('caps a recording rather than growing without limit', () => {
    const recorder = new InteractionRecorder(noopLogger);
    recorder.start(SESSION);

    for (let index = 0; index < 500; index += 1) {
      recorder.observe(SESSION, observe('click', { name: `Button ${index}` }));
    }

    const overflow = recorder.observe(SESSION, observe('click', { name: 'One too many' }));
    expect(overflow.ok).toBe(false);
  });
});

describe('normalizing a stream', () => {
  it('collapses consecutive fills on one target to the final value', () => {
    // A person typing "hello" produces five events and means one step.
    const normalized = normalizeInteractions([
      observe('fill', { name: 'Email' }, 'h'),
      observe('fill', { name: 'Email' }, 'he'),
      observe('fill', { name: 'Email' }, 'hello'),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.value).toBe('hello');
  });

  it('treats a click before a fill on the same target as focus', () => {
    const normalized = normalizeInteractions([
      observe('click', { name: 'Email' }),
      observe('fill', { name: 'Email' }, 'user@example.com'),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.action).toBe('fill');
  });

  it('keeps a click on a different target than the fill', () => {
    const normalized = normalizeInteractions([
      observe('click', { name: 'Show password' }),
      observe('fill', { name: 'Password' }, 'secret'),
    ]);

    expect(normalized).toHaveLength(2);
  });

  it('drops a goto to the page already open', () => {
    const normalized = normalizeInteractions([
      observe('goto', undefined, 'https://app.test/'),
      observe('goto', undefined, 'https://app.test/'),
      observe('goto', undefined, 'https://app.test/next'),
    ]);

    expect(normalized.map((entry) => entry.value)).toEqual([
      'https://app.test/',
      'https://app.test/next',
    ]);
  });

  it('keeps fills on different targets apart', () => {
    const normalized = normalizeInteractions([
      observe('fill', { name: 'Email' }, 'a@b.test'),
      observe('fill', { name: 'Password' }, 'secret'),
    ]);

    expect(normalized).toHaveLength(2);
  });

  it('distinguishes targets by elementId when one is present', () => {
    const normalized = normalizeInteractions([
      observe('fill', { elementId: 'el_1', name: 'Field' }, 'one'),
      observe('fill', { elementId: 'el_2', name: 'Field' }, 'two'),
    ]);

    expect(normalized).toHaveLength(2);
  });

  it('leaves an unrelated sequence untouched', () => {
    const stream = [
      observe('goto', undefined, 'https://app.test/'),
      observe('fill', { name: 'Email' }, 'a@b.test'),
      observe('click', { name: 'Login' }),
    ];

    expect(normalizeInteractions(stream)).toHaveLength(3);
  });
});

describe('the Test IR it produces', () => {
  const stream = [
    observe('goto', undefined, 'https://app.test/'),
    observe('click', { name: 'Email' }),
    observe('fill', { name: 'Email' }, 'user@example.com'),
    observe('fill', { name: 'Password' }, 'sup3r-secret'),
    observe('click', { name: 'Login', role: 'button' }),
  ];

  it('numbers steps in order', () => {
    const steps = toTestActions(stream);
    expect(steps.map((step) => step.id)).toEqual(['rec_1', 'rec_2', 'rec_3', 'rec_4']);
  });

  it('names targets and never emits a selector', () => {
    // The whole point: a recorded step that referenced a selector would break on
    // the first UI change, which is what the Registry exists to avoid.
    const steps = toTestActions(stream);

    for (const step of steps) {
      expect(JSON.stringify(step)).not.toContain('selector');
    }
    expect(steps[1]?.target?.name).toBe('Email');
  });

  it('keeps a typed value out of the label', () => {
    // A recorded password would otherwise appear in every timeline that replays
    // this step.
    const steps = toTestActions(stream);
    const passwordStep = steps.find((step) => step.target?.name === 'Password');

    expect(passwordStep?.value).toBe('sup3r-secret');
    expect(passwordStep?.label).toBe('fill Password');
    expect(passwordStep?.label).not.toContain('sup3r-secret');
  });

  it('produces replayable steps with no preconditions of its own', () => {
    // The recorder records what happened; declaring preconditions is an
    // authoring decision a person makes afterwards.
    const steps = toTestActions(stream);
    expect(steps.every((step) => step.preconditions.length === 0)).toBe(true);
  });

  it('labels a goto with its URL', () => {
    const steps = toTestActions(stream);
    expect(steps[0]?.label).toBe('go to https://app.test/');
  });

  it('returns nothing for an empty recording', () => {
    expect(toTestActions([])).toEqual([]);
  });
});
