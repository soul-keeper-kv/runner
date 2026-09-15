import type { PublicExecutionEventV1 } from '@runner/test-ir-model';
import type { Result } from '@runner/shared';

/**
 * Outbound completion callbacks (blueprint section 52.5).
 *
 * One of three equally supported consumption styles alongside polling and the
 * realtime stream. Delivery is recorded so a failed callback is visible rather
 * than silently lost.
 */

export interface WebhookDelivery {
  readonly id: string;
  readonly executionId: string;
  readonly url: string;
  readonly event: PublicExecutionEventV1;
  readonly attempt: number;
  readonly status: 'PENDING' | 'DELIVERED' | 'FAILED';
  readonly responseStatus?: number;
  readonly error?: string;
  readonly deliveredAt?: string;
}

export interface WebhookPort {
  deliver(input: {
    readonly url: string;
    readonly event: PublicExecutionEventV1;
    readonly signatureHeader?: string;
  }): Promise<Result<WebhookDelivery>>;
}
