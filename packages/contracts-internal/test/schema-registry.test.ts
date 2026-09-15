import { describe, expect, it } from 'vitest';
import { SCHEMA_IDS, buildCapabilities, createSchemaRegistry } from '../src/index.js';

const registry = createSchemaRegistry();

function validRequest(): Record<string, unknown> {
  return {
    contractVersion: 'runner.execution.v1',
    irVersion: 'test-ir.v1',
    workspaceRef: 'workspace_checkout',
    test: {
      id: 'ir-1',
      name: 'Login',
      steps: [
        { id: 'step-1', type: 'goto', value: '/login' },
        { id: 'step-2', type: 'click', target: { name: 'Login Button' } },
      ],
    },
  };
}

describe('execution request schema', () => {
  it('accepts a well-formed request', () => {
    const result = registry.validate(SCHEMA_IDS.executionRequest, validRequest());
    expect(result.ok).toBe(true);
  });

  it('rejects an unsupported contract version', () => {
    const request = { ...validRequest(), contractVersion: 'runner.execution.v2' };
    const result = registry.validate(SCHEMA_IDS.executionRequest, request);
    expect(result.ok).toBe(false);
  });

  it('rejects a request with no workspace reference', () => {
    const request = validRequest();
    delete request.workspaceRef;
    expect(registry.validate(SCHEMA_IDS.executionRequest, request).ok).toBe(false);
  });

  it('rejects unknown top-level fields so typos surface immediately', () => {
    const request = { ...validRequest(), workspacRef: 'typo' };
    expect(registry.validate(SCHEMA_IDS.executionRequest, request).ok).toBe(false);
  });

  it('reports the offending path in the error details', () => {
    const request = validRequest();
    (request.test as Record<string, unknown>).steps = [{ id: 's1', type: 'click' }];
    const result = registry.validate(SCHEMA_IDS.executionRequest, request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error.details)).toContain('/test/steps/0');
  });
});

describe('test ir schema', () => {
  it('requires a target for a click step', () => {
    const ir = { id: 'ir-1', name: 'x', steps: [{ id: 's1', type: 'click' }] };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(false);
  });

  it('requires a value for a fill step', () => {
    const ir = {
      id: 'ir-1',
      name: 'x',
      steps: [{ id: 's1', type: 'fill', target: { name: 'Email' } }],
    };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(false);
  });

  it('requires an assertion for an assert step', () => {
    const ir = {
      id: 'ir-1',
      name: 'x',
      steps: [{ id: 's1', type: 'assert', target: { name: 'Title' } }],
    };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(false);
  });

  it('accepts an assert step carrying an assertion', () => {
    const ir = {
      id: 'ir-1',
      name: 'x',
      steps: [
        {
          id: 's1',
          type: 'assert',
          target: { name: 'Title' },
          assertion: { type: 'containsText', expected: 'Welcome' },
        },
      ],
    };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(true);
  });

  it('rejects an empty element intent', () => {
    const ir = { id: 'ir-1', name: 'x', steps: [{ id: 's1', type: 'click', target: {} }] };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(false);
  });

  it('rejects a raw selector, which belongs in the Registry', () => {
    const ir = {
      id: 'ir-1',
      name: 'x',
      steps: [{ id: 's1', type: 'click', target: { name: 'X', selector: '#btn' } }],
    };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(false);
  });

  it('requires a profile on an authenticated precondition', () => {
    const ir = {
      id: 'ir-1',
      name: 'x',
      steps: [
        {
          id: 's1',
          type: 'click',
          target: { name: 'Approve' },
          preconditions: [{ type: 'authenticated' }],
        },
      ],
    };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(false);
  });

  it('accepts a fully specified precondition set', () => {
    const ir = {
      id: 'ir-1',
      name: 'x',
      steps: [
        {
          id: 's1',
          type: 'click',
          target: { name: 'Approve' },
          preconditions: [
            { type: 'authenticated', profile: 'MANAGER' },
            { type: 'entityState', entity: 'ORDER', state: 'SUBMITTED' },
            { type: 'uiState', state: 'REVIEW_TAB_OPEN' },
          ],
        },
      ],
    };
    expect(registry.validate(SCHEMA_IDS.testIr, ir).ok).toBe(true);
  });
});

describe('live command schema', () => {
  it('requires a url on browser.navigate', () => {
    const command = { id: 'c1', sessionId: 's1', type: 'browser.navigate', payload: {} };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });

  it('accepts a selector preview command', () => {
    const command = {
      id: 'c1',
      sessionId: 's1',
      type: 'selector.preview',
      payload: { elementId: 'el_1', selector: { type: 'role', role: 'button', name: 'Login' } },
    };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(true);
  });

  it('rejects an unknown command type', () => {
    const command = { id: 'c1', sessionId: 's1', type: 'browser.eval', payload: {} };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });

  it('accepts a described element named by a viewport point', () => {
    const command = {
      id: 'c1',
      sessionId: 's1',
      type: 'element.describe',
      payload: { point: { x: 478, y: 80 } },
    };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(true);
  });

  it('accepts a described element named by a selector', () => {
    const command = {
      id: 'c1',
      sessionId: 's1',
      type: 'element.describe',
      payload: { selector: { type: 'testId', value: 'login-submit' } },
    };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(true);
  });

  it('rejects an element.describe that names nothing', () => {
    // An empty payload would otherwise describe whatever happened to be first.
    const command = { id: 'c1', sessionId: 's1', type: 'element.describe', payload: {} };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });

  it('rejects a point with a negative coordinate', () => {
    const command = {
      id: 'c1',
      sessionId: 's1',
      type: 'element.describe',
      payload: { point: { x: -5, y: 80 } },
    };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });

  it('accepts an auth.login naming a profile', () => {
    const command = {
      id: 'c1',
      sessionId: 's1',
      type: 'auth.login',
      payload: { profileRef: 'MANAGER' },
    };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(true);
  });

  it('requires a profileRef on auth.login', () => {
    const command = { id: 'c1', sessionId: 's1', type: 'auth.login', payload: {} };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });

  it('rejects a credential in an auth.login payload', () => {
    /*
     * The rule this protects (blueprint section 50): a live command names a
     * profile, never a secret. This command arrives over a WebSocket from a
     * browser tab, so a payload carrying a password would put it in a client,
     * in a socket frame, and in every log between the two.
     */
    const command = {
      id: 'c1',
      sessionId: 's1',
      type: 'auth.login',
      payload: { profileRef: 'MANAGER', password: 'sup3r-s3cret' },
    };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });

  it('rejects a highlight that names nothing to highlight', () => {
    const command = { id: 'c1', sessionId: 's1', type: 'element.highlight', payload: {} };
    expect(registry.validate(SCHEMA_IDS.liveCommand, command).ok).toBe(false);
  });
});

describe('capabilities', () => {
  it('publishes the supported contract versions', () => {
    const capabilities = buildCapabilities({ version: '0.1.0' });
    expect(capabilities.contracts.execution).toContain('runner.execution.v1');
    expect(capabilities.contracts.testIr).toContain('test-ir.v1');
  });

  it('marks AI resolution as planned until one is configured', () => {
    const off = buildCapabilities({ version: '0.1.0' });
    const semantic = off.features.find((f) => f.name === 'resolver.semantic-ai');
    expect(semantic?.status).toBe('PLANNED');

    const on = buildCapabilities({ version: '0.1.0', semanticResolverAvailable: true });
    expect(on.features.find((f) => f.name === 'resolver.semantic-ai')?.status).toBe('AVAILABLE');
  });

  it('defaults every optional feature to unavailable', () => {
    // A forgotten flag must under-promise. This is the regression that let
    // registry.elements advertise AVAILABLE while every registry route
    // answered 501 CAPABILITY_NOT_IMPLEMENTED.
    const capabilities = buildCapabilities({ version: '0.1.0' });
    const optional = [
      'registry.elements',
      'live.sessions',
      'registry.self-healing',
      'resolver.semantic-ai',
      'recorder.interactive',
      // Needs a database *and* an encryption key, and has no fallback: a
      // deployment missing either must not be told it can store credentials.
      'auth.profiles.managed',
    ];

    for (const name of optional) {
      const feature = capabilities.features.find((f) => f.name === name);
      expect(feature, `${name} should be described`).toBeDefined();
      expect(feature?.status, `${name} must not default to AVAILABLE`).not.toBe('AVAILABLE');
    }
  });

  it('reports managed auth profiles as available only when both halves exist', () => {
    /*
     * The distinction a caller needs: `auth.profiles` is always available —
     * the Runner can always authenticate from a profile declared in the
     * worker's environment. `auth.profiles.managed` is about whether profiles
     * can be *edited over the API*, which needs a database and a key to seal
     * credentials with. Conflating them would tell a client it can store a
     * password when the route answers 501.
     */
    const off = buildCapabilities({ version: '0.1.0' });
    expect(off.features.find((f) => f.name === 'auth.profiles')?.status).toBe('AVAILABLE');
    expect(off.features.find((f) => f.name === 'auth.profiles.managed')?.status).toBe('DISABLED');

    const on = buildCapabilities({ version: '0.1.0', managedAuthProfilesAvailable: true });
    expect(on.features.find((f) => f.name === 'auth.profiles.managed')?.status).toBe('AVAILABLE');
  });

  it('reports registry and live sessions as available only when switched on', () => {
    const on = buildCapabilities({
      version: '0.1.0',
      registryAvailable: true,
      liveSessionsAvailable: true,
    });
    expect(on.features.find((f) => f.name === 'registry.elements')?.status).toBe('AVAILABLE');
    expect(on.features.find((f) => f.name === 'live.sessions')?.status).toBe('AVAILABLE');
  });

  it('lists every integration style so no caller needs source-code coupling', () => {
    const capabilities = buildCapabilities({ version: '0.1.0' });
    expect(capabilities.integrationStyles).toEqual(
      expect.arrayContaining(['polling', 'webhook', 'websocket']),
    );
  });
});
