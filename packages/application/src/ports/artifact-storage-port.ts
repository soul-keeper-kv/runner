import type { Result } from '@runner/shared';

/**
 * Evidence storage — screenshots, traces, videos (blueprint section 49).
 *
 * Local disk in development, object storage later. Kept behind a port so that
 * swap needs no change outside infrastructure.
 */

export type ArtifactKind = 'screenshot' | 'trace' | 'video' | 'dom-snapshot' | 'log';

export interface ArtifactDescriptor {
  readonly id: string;
  readonly executionId?: string;
  readonly sessionId?: string;
  readonly stepId?: string;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  /** How a client retrieves it; may be a relative API path or a signed URL. */
  readonly url: string;
}

export interface ArtifactStoragePort {
  put(input: {
    readonly kind: ArtifactKind;
    readonly contentType: string;
    readonly data: Buffer;
    readonly executionId?: string;
    readonly sessionId?: string;
    readonly stepId?: string;
  }): Promise<Result<ArtifactDescriptor>>;

  get(artifactId: string): Promise<Result<{ descriptor: ArtifactDescriptor; data: Buffer }>>;
  listByExecution(executionId: string): Promise<Result<ArtifactDescriptor[]>>;
  delete(artifactId: string): Promise<Result<void>>;
}
