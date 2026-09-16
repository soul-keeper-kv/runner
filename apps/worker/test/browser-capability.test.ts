import { describe, expect, it } from 'vitest';
import type { BrowserPort, ScrollOptions } from '@runner/application';
import type { PageState } from '@runner/domain';
import type { LiveSession, RawLiveCommand } from '@runner/live-protocol';
import { noopLogger, ok } from '@runner/shared';
import type { LiveSessionContext } from '../src/capabilities/capability-registry.js';
import { BrowserCapability } from '../src/capabilities/browser/browser-capability.js';

/**
 * What these tests protect: a live page can be moved, and a client is told
 * where it ended up.
 *
 * Scrolling exists because every box the Runner reports is in viewport
 * coordinates and the frame is a picture of the viewport — content below the
 * fold is scanned and selectable but unreachable by a click on the frame. The
 * decisions worth pinning are the ones a browser cannot make for us: which
 * form of the payload wins, and what happens when a payload says nothing.
 */

function contextWith(browser: Partial<BrowserPort>): LiveSessionContext {
  const state: PageState = {
    url: 'https://example.test/long-page',
    title: 'A long page',
    frameCount: 1,
    hasOpenDialog: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };

  return {
    session: {
      id: 'ls_1',
      workspaceRef: 'w1',
      browserSessionId: 'bs_1',
      executionState: 'IDLE',
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as LiveSession,
    browser: {
      sessionId: 'bs_1',
      getCurrentState: async () => ok(state),
      scroll: async () => ok({ x: 0, y: 0, maxX: 0, maxY: 4200 }),
      ...browser,
    } as unknown as BrowserPort,
    logger: noopLogger,
  };
}

function commandOf(type: string, payload: unknown = {}): RawLiveCommand {
  return { id: 'cmd_1', sessionId: 'ls_1', type, payload };
}

/** Captures what reached the port, so payload translation is observable. */
function recordingBrowser() {
  const calls: ScrollOptions[] = [];
  return {
    calls,
    port: {
      scroll: async (options: ScrollOptions) => {
        calls.push(options);
        return ok({ x: 0, y: 1200, maxX: 0, maxY: 4200 });
      },
    } as Partial<BrowserPort>,
  };
}

describe('browser.scroll', () => {
  it('reports the position the page came to rest at', async () => {
    const result = await new BrowserCapability().execute(
      commandOf('browser.scroll', { by: { y: 600 } }),
      contextWith({
        scroll: async () => ok({ x: 0, y: 600, maxX: 0, maxY: 4200 }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The position is the point: a client that scrolled past the end needs to
    // see that it stopped short, not a bare "ok".
    expect(result.value.scroll).toEqual({ x: 0, y: 600, maxX: 0, maxY: 4200 });
    expect(result.value.url).toBe('https://example.test/long-page');
  });

  it('passes a relative nudge through as a delta', async () => {
    const browser = recordingBrowser();

    await new BrowserCapability().execute(
      commandOf('browser.scroll', { by: { x: 0, y: 320 } }),
      contextWith(browser.port),
    );

    expect(browser.calls[0]).toEqual({ by: { x: 0, y: 320 } });
  });

  it('scrolls to an element by selector, never by its box', async () => {
    const browser = recordingBrowser();
    const selector = { type: 'role', role: 'button', name: 'Submit' };

    await new BrowserCapability().execute(
      commandOf('browser.scroll', { target: { selector, block: 'center' } }),
      contextWith(browser.port),
    );

    /*
     * The selector reaches the port intact and no coordinate is invented from
     * it. A bbox is measured at the offset a scan ran at, so turning one into
     * a scroll target means adding a scroll position that has since changed —
     * the element would be looked for where it used to be.
     */
    expect(browser.calls[0]).toEqual({ target: { selector }, block: 'center' });
  });

  it('prefers an absolute destination over a relative one', async () => {
    const browser = recordingBrowser();

    await new BrowserCapability().execute(
      commandOf('browser.scroll', { to: 'bottom', by: { y: 100 } }),
      contextWith(browser.port),
    );

    // One command cannot mean both. The documented order is to, target, by.
    expect(browser.calls[0]).toEqual({ to: 'bottom' });
  });

  it('refuses a payload that names no destination', async () => {
    const browser = recordingBrowser();

    const result = await new BrowserCapability().execute(
      commandOf('browser.scroll', {}),
      contextWith(browser.port),
    );

    /*
     * Refused rather than treated as a no-op scroll. A client that meant to
     * send an offset and sent `{}` would otherwise get a success and an unmoved
     * page, which reads as "scrolling is broken" instead of as a bad command.
     */
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(browser.calls).toHaveLength(0);
  });

  it('refuses a runtimeId target rather than silently scrolling nowhere', async () => {
    const browser = recordingBrowser();

    const result = await new BrowserCapability().execute(
      commandOf('browser.scroll', { target: { runtimeId: 'rt_42' } }),
      contextWith(browser.port),
    );

    // A runtimeId is snapshot-local and the adapter holds no index of them.
    // Ignoring it would scroll nowhere and report success.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(result.error.message).toContain('runtimeId');
  });

  it('still answers with the URL for a plain navigation command', async () => {
    const result = await new BrowserCapability().execute(
      commandOf('browser.refresh'),
      contextWith({ reload: async () => ok(undefined) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No scroll happened, so no position is claimed.
    expect(result.value.scroll).toBeUndefined();
  });
});
