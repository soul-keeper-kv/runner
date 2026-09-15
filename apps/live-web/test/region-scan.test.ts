import { describe, expect, it } from 'vitest';
import {
  buildRegistryExport,
  containedInRegion,
  type ScannedElement,
  type ViewportRect,
} from '../src/lib/registry-export.js';

/**
 * Region-scoped scanning and export.
 *
 * The containment rule is the feature: a region exists so a dense page can be
 * scanned in one part rather than whole and then trimmed by hand, and an
 * intersection test would defeat that by keeping every ancestor the rectangle
 * happens to overlap. These pin the rule and the two things the export has to
 * say about a scope, because both failures are quiet — a wrapper that sneaks
 * into a draft, or a partial file that reads as a complete one.
 */
describe('containedInRegion', () => {
  const region: ViewportRect = { x: 100, y: 100, width: 200, height: 200 };

  it('keeps an element fully inside the region', () => {
    expect(containedInRegion({ x: 120, y: 120, width: 50, height: 20 }, region)).toBe(true);
  });

  it('keeps an element flush against the region edges', () => {
    // Inclusive bounds: a region drawn exactly around a control should keep it,
    // and a user cannot drag to sub-pixel precision to stay off the boundary.
    expect(containedInRegion({ x: 100, y: 100, width: 200, height: 200 }, region)).toBe(true);
  });

  it('drops a container that encloses the region', () => {
    // The whole reason containment beats intersection: <body> and the page
    // wrapper overlap every region ever drawn.
    expect(containedInRegion({ x: 0, y: 0, width: 1280, height: 720 }, region)).toBe(false);
  });

  it('drops an element clipped by the region edge', () => {
    expect(containedInRegion({ x: 250, y: 120, width: 100, height: 20 }, region)).toBe(false);
  });

  it('drops an element entirely outside the region', () => {
    expect(containedInRegion({ x: 400, y: 400, width: 10, height: 10 }, region)).toBe(false);
  });

  it('drops an element with no geometry', () => {
    // It cannot be shown to be inside, and a region scan that included
    // unplaceable elements would not be scoped.
    expect(containedInRegion(undefined, region)).toBe(false);
  });
});

describe('buildRegistryExport with a region', () => {
  const page = { url: 'https://example.com/orders', title: 'Orders' };

  function scanned(overrides: Partial<ScannedElement> = {}): ScannedElement {
    return {
      runtimeId: 'rt_1',
      tag: 'button',
      role: 'button',
      label: 'Save',
      interactable: true,
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      ...overrides,
    };
  }

  const region: ViewportRect = { x: 100, y: 100, width: 200, height: 200 };

  it('records the region and marks the source as region-scoped', () => {
    const result = buildRegistryExport([scanned()], { ...page, region });

    expect(result.region).toEqual(region);
    expect(result.source).toBe('live-session-region');
  });

  it('reports no region and a plain source for a whole-page export', () => {
    const result = buildRegistryExport([scanned()], page);

    expect(result.region).toBeUndefined();
    expect(result.source).toBe('live-session');
  });

  it('does not report truncation for a region export', () => {
    // Every element outside the region is missing by request. Reporting that as
    // a shortfall would describe an intentional scope as data loss, and send
    // the reader back to rescan the page the region was meant to avoid.
    const result = buildRegistryExport([scanned()], { ...page, region, candidateCount: 150 });

    expect(result.truncated).toBeUndefined();
  });

  it('still reports truncation for a whole-page export', () => {
    const result = buildRegistryExport([scanned()], { ...page, candidateCount: 150 });

    expect(result.truncated).toEqual({ returned: 1, available: 150 });
  });
});
