/**
 * The Runner HTTP client for the live workspace.
 *
 * Every call goes through the same public API an external service would use.
 * The workspace has no privileged back door, which keeps the published contract
 * honest: if something is awkward to do here, it is awkward for every
 * integrator, and that is worth discovering early.
 */

export interface RunnerError {
  code: string;
  kind: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: RunnerError,
  ) {
    super(error.message);
    this.name = 'RunnerApiError';
  }
}

export interface Capabilities {
  runner: { name: string; version: string };
  contracts: { execution: string[]; testIr: string[] };
  actionTypes: string[];
  selectorStrategies: string[];
  executionModes: string[];
  liveCommands: string[];
  integrationStyles: string[];
  features: { name: string; status: 'AVAILABLE' | 'PLANNED' | 'DISABLED'; description: string }[];
}

export interface ExecutionStep {
  stepId: string;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs?: number;
  evidence?: string[];
  error?: RunnerError;
  resolvedElement?: {
    elementId?: string;
    displayName?: string;
    confidence: number;
    selector: unknown;
  };
}

export interface ExecutionResult {
  executionId: string;
  workspaceRef: string;
  status: 'QUEUED' | 'RUNNING' | 'WAITING_USER' | 'PASSED' | 'FAILED' | 'CANCELLED';
  mode: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  steps: ExecutionStep[];
  error?: RunnerError;
}

export interface InspectionSelector {
  type: string;
  value?: string;
  role?: string;
  name?: string;
  score: number;
}

/**
 * A draft registry entry as returned by an inspection.
 *
 * This is the shape Page Object generation consumes, which is why the
 * workspace shows it verbatim rather than a prettier summary: what you see
 * here is what a generator would receive.
 */
export interface InspectionElement {
  systemName: string;
  displayName: string;
  description?: string;
  role: string;
  semanticType?: string;
  aliases?: string[];
  interactable: boolean;
  editable: boolean;
  required: boolean;
  enabled: boolean;
  fieldType?: string;
  fieldName?: string;
  placeholder?: string;
  selector: InspectionSelector;
  fallbacks: InspectionSelector[];
  confidence: number;
}

export interface InspectionPage {
  systemName: string;
  displayName: string;
  urlPattern: string;
}

export interface InspectionResult {
  inspectionId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  requestId?: string;
  url: string;
  requestedUrl: string;
  title?: string;
  page?: InspectionPage;
  elements: InspectionElement[];
  fields: {
    name: string;
    type: string;
    fieldName?: string;
    placeholder?: string;
    required: boolean;
    enabled: boolean;
    selector: InspectionSelector;
    fallbacks: InspectionSelector[];
  }[];
  submit?: { name: string; role: string; selector: InspectionSelector };
  error?: RunnerError;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LiveSession {
  id: string;
  workspaceRef: string;
  browserSessionId: string;
  executionState: 'IDLE' | 'RUNNING' | 'PAUSED' | 'WAITING_USER' | 'FAILED' | 'CLOSED';
  currentStepId?: string;
  selectedElementId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    // The Runner always answers with a structured error; the fallback covers a
    // proxy or gateway failing before the API is reached.
    const error = (body as { error?: RunnerError } | undefined)?.error ?? {
      code: 'INTERNAL_ERROR',
      kind: 'INFRASTRUCTURE_FAILURE',
      message: `Request failed with status ${response.status}.`,
      retryable: true,
    };
    throw new RunnerApiError(response.status, error);
  }

  return body as T;
}

export const runnerApi = {
  health(): Promise<{ status: string; version: string; uptimeSeconds: number }> {
    return request('/health');
  },

  capabilities(): Promise<Capabilities> {
    return request('/api/v1/capabilities');
  },

  getExecution(executionId: string): Promise<ExecutionResult> {
    return request(`/api/v1/executions/${encodeURIComponent(executionId)}`);
  },

  submitExecution(
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<{ executionId: string; status: string; statusUrl: string; eventsUrl: string }> {
    return request('/api/v1/executions', {
      method: 'POST',
      body: JSON.stringify(payload),
      ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
    });
  },

  validateTestIr(testIr: unknown): Promise<{ valid: true }> {
    return request('/api/v1/validate/test-ir', {
      method: 'POST',
      body: JSON.stringify(testIr),
    });
  },

  cancelExecution(executionId: string): Promise<{ executionId: string; status: string }> {
    return request(`/api/v1/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: 'POST',
    });
  },

  submitInspection(
    url: string,
    workspaceRef: string,
    options?: Record<string, unknown>,
  ): Promise<{ inspectionId: string; status: string; statusUrl: string }> {
    return request('/api/v1/inspections', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: 'runner.inspection.v1',
        workspaceRef,
        url,
        ...(options === undefined ? {} : { options }),
      }),
    });
  },

  getInspection(inspectionId: string): Promise<InspectionResult> {
    return request(`/api/v1/inspections/${encodeURIComponent(inspectionId)}`);
  },

  createLiveSession(workspaceRef: string, executionId?: string): Promise<LiveSession> {
    return request('/api/v1/live-sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceRef, executionId }),
    });
  },

  getLiveSession(sessionId: string): Promise<LiveSession> {
    return request(`/api/v1/live-sessions/${encodeURIComponent(sessionId)}`);
  },

  closeLiveSession(sessionId: string): Promise<void> {
    return request(`/api/v1/live-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  },
};
