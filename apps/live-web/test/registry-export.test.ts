import { describe, expect, it } from 'vitest';
import { toSystemName as sharedToSystemName } from '@runner/shared';
import {
  buildRegistryExport,
  filenameForUrl,
  toSystemName,
  type ScannedElement,
} from '../src/lib/registry-export.js';

/**
 * The workspace reimplements `toSystemName` because it depends only on the wire
 * protocol packages (see the comment on the function itself). That duplication
 * is only safe while the two agree, so this test compares them directly — if
 * `@runner/shared` changes the naming rule, this fails rather than letting the
 * workspace quietly emit identifiers that differ from the ones an inspection
 * produces for the same page.
 */
describe('toSystemName parity with @runner/shared', () => {
  const cases = [
    'Create Customer Button',
    'Sign in',
    'email',
    '  Search   products  ',
    'Đăng nhập',
    'Café Münchén',
    '2FA code',
    '123',
    '!!!',
    '',
    'already-kebab-case',
    'UPPER CASE NAME',
  ];

  for (const input of cases) {
    it(`matches for ${JSON.stringify(input)}`, () => {
      expect(toSystemName(input)).toBe(sharedToSystemName(input));
    });
  }
});

describe('buildRegistryExport', () => {
  const page = { url: 'https://example.com/login', title: 'Sign in' };

  function scanned(overrides: Partial<ScannedElement> = {}): ScannedElement {
    return {
      runtimeId: 'rt_1',
      tag: 'button',
      role: 'button',
      label: 'Sign in',
      interactable: true,
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      ...overrides,
    };
  }

  it('ranks the first selector as primary and the rest as fallbacks', () => {
    const result = buildRegistryExport(
      [
        scanned({
          described: {
            runtimeId: 'rt_1',
            accessibleName: 'Sign in',
            candidateSelectors: [
              { selector: { type: 'testid', value: 'signin' }, score: 95, matchCount: 1 },
              { selector: { type: 'role', role: 'button', name: 'Sign in' }, score: 80, matchCount: 1 },
              { selector: { type: 'text', value: 'Sign in' }, score: 40, matchCount: 3 },
            ],
          } as ScannedElement['described'],
        }),
      ],
      page,
    );

    const [element] = result.elements;
    expect(element?.selector).toMatchObject({ type: 'testid', value: 'signin', matchCount: 1 });
    expect(element?.fallbacks).toHaveLength(2);
    expect(element?.described).toBe(true);
    expect(result.describedCount).toBe(1);
  });

  it('keeps an undescribed element, with no selector and described=false', () => {
    const result = buildRegistryExport([scanned()], page);

    expect(result.elements[0]?.selector).toBeUndefined();
    expect(result.elements[0]?.described).toBe(false);
    expect(result.describedCount).toBe(0);
    // The element is still worth exporting: it tells the reader the page had an
    // element there that the scan could not rank.
    expect(result.elementCount).toBe(1);
  });

  it('flags a describe whose box does not overlap the scanned element', () => {
    const result = buildRegistryExport(
      [
        scanned({
          bbox: { x: 0, y: 0, width: 100, height: 20 },
          described: {
            runtimeId: 'rt_999',
            // A covering panel elsewhere on the page.
            bbox: { x: 500, y: 400, width: 300, height: 200 },
            candidateSelectors: [
              { selector: { type: 'css', value: '.overlay' }, score: 10, matchCount: 1 },
            ],
          } as ScannedElement['described'],
        }),
      ],
      page,
    );

    // A covered element describes whatever sits on top of it. Silently writing
    // that selector under this element's name is how a Page Object clicks the
    // wrong control, so the mismatch is reported.
    expect(result.elements[0]?.describeMismatch).toBe(true);
  });

  it('does not flag a describe that landed on the same element', () => {
    const result = buildRegistryExport(
      [
        scanned({
          runtimeId: 'rt_1',
          bbox: { x: 10, y: 10, width: 100, height: 20 },
          described: {
            // Deliberately a different id: inspect and describe number elements
            // with unrelated counters, so ids never match even for one element.
            runtimeId: 'rt_described_1700000000',
            bbox: { x: 10, y: 10, width: 100, height: 20 },
            candidateSelectors: [
              { selector: { type: 'role', role: 'link', name: 'Learn more' }, score: 90, matchCount: 1 },
            ],
          } as ScannedElement['described'],
        }),
      ],
      page,
    );

    expect(result.elements[0]?.describeMismatch).toBeUndefined();
  });

  it('does not guess when either box is missing', () => {
    const result = buildRegistryExport(
      [
        scanned({
          bbox: undefined,
          described: {
            runtimeId: 'rt_2',
            candidateSelectors: [
              { selector: { type: 'css', value: '.x' }, score: 10, matchCount: 1 },
            ],
          } as ScannedElement['described'],
        }),
      ],
      page,
    );

    expect(result.elements[0]?.describeMismatch).toBeUndefined();
  });

  it('disambiguates repeated names so one does not overwrite the other', () => {
    const result = buildRegistryExport(
      [scanned({ runtimeId: 'a', label: 'Edit' }), scanned({ runtimeId: 'b', label: 'Edit' })],
      page,
    );

    expect(result.elements.map((element) => element.systemName)).toEqual(['edit', 'edit2']);
  });

  it('records the shortfall when the page held more elements than came back', () => {
    const result = buildRegistryExport([scanned()], { ...page, candidateCount: 400 });

    // The worker caps a snapshot's candidates. A file claiming to be every
    // element while omitting 399 of them is discovered far too late.
    expect(result.truncated).toEqual({ returned: 1, available: 400 });
  });

  it('omits the shortfall when nothing was left out', () => {
    const result = buildRegistryExport([scanned()], { ...page, candidateCount: 1 });

    expect(result.truncated).toBeUndefined();
  });

  it('falls back to the tag when an element has no label at all', () => {
    const result = buildRegistryExport(
      [scanned({ label: undefined, role: undefined, tag: 'input' })],
      page,
    );

    expect(result.elements[0]?.displayName).toBe('input');
    expect(result.elements[0]?.role).toBe('input');
  });
});

describe('filenameForUrl', () => {
  it('builds a filesystem-safe name from host and last path segment', () => {
    expect(filenameForUrl('https://example.com/admin/login', 'registry')).toBe(
      'example.com-login-registry.json',
    );
  });

  it('falls back rather than refusing when the URL is unparsable', () => {
    expect(filenameForUrl('', 'registry')).toBe('page-registry.json');
  });
});
