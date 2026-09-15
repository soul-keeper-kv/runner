import { describe, expect, it } from 'vitest';
import { SCHEMA_IDS, createSchemaRegistry } from '../src/index.js';

const registry = createSchemaRegistry();

function validRequest(): Record<string, unknown> {
  return {
    contractVersion: 'runner.inspection.v1',
    workspaceRef: 'workspace_checkout',
    url: 'https://example.com/login',
  };
}

describe('inspection request schema', () => {
  it('accepts a URL and a workspace, with no Test IR', () => {
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, validRequest()).ok).toBe(true);
  });

  it('rejects an unsupported contract version', () => {
    const request = { ...validRequest(), contractVersion: 'runner.inspection.v2' };
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(false);
  });

  it('requires a url', () => {
    const request = validRequest();
    delete request.url;
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(false);
  });

  it('requires a workspace reference', () => {
    const request = validRequest();
    delete request.workspaceRef;
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(false);
  });

  /**
   * A file: or data: URL would point the Runner's own browser at the worker's
   * filesystem, so the scheme is part of the contract rather than a runtime
   * navigation concern.
   */
  it('rejects a non-http scheme', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>x', 'ftp://example.com']) {
      const result = registry.validate(SCHEMA_IDS.inspectionRequest, {
        ...validRequest(),
        url,
      });
      expect(result.ok, url).toBe(false);
    }
  });

  it('rejects unknown top-level fields so typos surface immediately', () => {
    const request = { ...validRequest(), workspacRef: 'typo' };
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(false);
  });

  it('rejects a Test IR payload, which belongs on the execution endpoint', () => {
    const request = { ...validRequest(), test: { id: 'ir-1', name: 'x', steps: [] } };
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(false);
  });

  it('accepts the documented options', () => {
    const request = {
      ...validRequest(),
      requestId: 'req-1',
      tenantRef: 'tenant-1',
      authProfileRef: 'MANAGER',
      options: {
        viewport: { width: 1280, height: 800 },
        waitUntil: 'networkidle',
        waitForMs: 1500,
        includeNonInputControls: true,
      },
    };
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(true);
  });

  it('rejects an unknown wait strategy', () => {
    const request = { ...validRequest(), options: { waitUntil: 'whenever' } };
    expect(registry.validate(SCHEMA_IDS.inspectionRequest, request).ok).toBe(false);
  });
});
