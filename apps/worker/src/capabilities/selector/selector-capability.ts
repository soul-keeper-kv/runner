import type { LiveCommandType, RawLiveCommand, SelectorPreviewResult } from '@runner/live-protocol';
import type { SelectorPreviewPayload } from '@runner/live-protocol';
import { stabilityOfScore, validateSelectorDefinition } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';

/**
 * Live selector preview and validation (blueprint section 30).
 *
 * This is what makes the live workspace useful: the user edits a selector and
 * immediately sees how many elements it matches, whether the match is visible
 * and enabled, and where it sits on the page — all without restarting the
 * browser or losing the state that produced the problem.
 *
 * Every incoming selector is validated as untrusted input before it reaches the
 * adapter, so the editor cannot be used to smuggle an executable expression
 * into the worker (blueprint rules 11 and 50).
 */
export class SelectorCapability implements LiveCapability<SelectorPreviewResult> {
  readonly type = 'selector' as const;
  readonly handles: readonly LiveCommandType[] = [
    'selector.preview',
    'selector.validate',
  ];

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<SelectorPreviewResult>> {
    const payload = payloadOf<SelectorPreviewPayload>(command);
    if (!payload.ok) return payload;

    const { selector } = payload.value;
    if (selector === undefined) {
      return err(RunnerErrors.validationFailed('A selector is required.'));
    }

    const validation = validateSelectorDefinition(selector);
    if (!validation.valid) {
      return err(
        RunnerErrors.selectorInvalid(
          selector.type,
          validation.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('; '),
        ),
      );
    }

    const probed = await context.browser.probe({
      selector,
      ...(payload.value.scoped?.within === undefined
        ? {}
        : { within: payload.value.scoped.within }),
    });

    // A selector that matches nothing is a normal editing state, reported as a
    // result rather than an error so the UI can keep showing live feedback.
    if (!probed.ok) {
      return ok({
        matchCount: 0,
        visible: false,
        enabled: false,
        selector,
        error: { code: probed.error.code, message: probed.error.message },
      });
    }

    const info = probed.value;
    // Ambiguity is the signal the editor most needs to surface, so the score
    // reflects it directly rather than being buried in a tooltip.
    const score = info.matchCount === 1 ? 90 : info.matchCount === 0 ? 0 : 40;

    return ok({
      matchCount: info.matchCount,
      visible: info.visible,
      enabled: info.enabled,
      ...(info.bbox === undefined ? {} : { bbox: info.bbox }),
      score,
      stability: stabilityOfScore(score),
      selector,
    });
  }
}
