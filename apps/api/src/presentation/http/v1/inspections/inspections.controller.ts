import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getInspection, submitInspection } from '@runner/application';
import { SCHEMA_IDS } from '@runner/contracts-internal';
import type {
  InspectionAcceptedV1,
  InspectionRequestV1,
  InspectionResultV1,
} from '@runner/test-ir-model';
import { unwrapOrThrow } from '@runner/shared';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * The public page-inspection API.
 *
 * This is the entry point for a caller that has a URL and nothing else: it
 * submits the URL and polls for the page's input fields and submit control,
 * each carrying a ranked selector. No Test IR is involved, and nothing on the
 * page is clicked or filled.
 */
@Controller('api/v1')
export class InspectionsController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  /**
   * Accepts an inspection and returns 202 immediately.
   *
   * Browser work happens in a worker, so a page that takes thirty seconds to
   * render never occupies a public API connection.
   */
  @Post('inspections')
  @HttpCode(202)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InspectionAcceptedV1> {
    unwrapOrThrow(this.container.schemas.validate(SCHEMA_IDS.inspectionRequest, body));

    const accepted = await submitInspection(
      {
        store: this.container.inspectionStore,
        queue: this.container.inspectionQueue,
        clock: this.container.clock,
        logger: this.container.logger,
      },
      {
        request: body as InspectionRequestV1,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    );

    const value = unwrapOrThrow(accepted);
    void reply.header('Location', value.statusUrl);
    return value;
  }

  @Get('inspections/:inspectionId')
  async get(@Param('inspectionId') inspectionId: string): Promise<InspectionResultV1> {
    const result = await getInspection(
      { store: this.container.inspectionStore },
      inspectionId,
    );
    return unwrapOrThrow(result);
  }

  /** Validation without scheduling, so a caller can check a payload first. */
  @Post('validate/inspection')
  // 200, not Nest's POST default of 201: validating creates nothing. The
  // published contract says 200, and the two must agree.
  @HttpCode(200)
  validateInspection(@Body() body: unknown): { valid: true } {
    unwrapOrThrow(this.container.schemas.validate(SCHEMA_IDS.inspectionRequest, body));
    return { valid: true };
  }
}
