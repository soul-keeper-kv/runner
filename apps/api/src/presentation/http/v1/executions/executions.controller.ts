import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { cancelExecution, getExecution, submitExecution } from '@runner/application';
import { SCHEMA_IDS } from '@runner/contracts-internal';
import type { ExecutionAcceptedV1, ExecutionRequestV1, ExecutionResultV1 } from '@runner/test-ir-model';
import { unwrapOrThrow } from '@runner/shared';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * The public execution API (blueprint section 52.1).
 *
 * Every request is validated against the *published* JSON Schema before it is
 * mapped to an internal plan. Validating twice — schema, then mapper — is not
 * redundant: the schema guarantees the caller sees exactly the errors the
 * published contract promises, while the mapper enforces the invariants the
 * pipeline depends on.
 */
@Controller('api/v1')
export class ExecutionsController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  /**
   * Accepts an execution and returns 202 immediately.
   *
   * Browser work happens in a worker, so a slow page can never occupy an API
   * connection. Callers then poll, subscribe, or receive a webhook.
   */
  @Post('executions')
  @HttpCode(202)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ExecutionAcceptedV1> {
    const validated = this.container.schemas.validate(SCHEMA_IDS.executionRequest, body);
    unwrapOrThrow(validated);

    const accepted = await submitExecution(
      {
        store: this.container.executionStore,
        queue: this.container.executionQueue,
        clock: this.container.clock,
        logger: this.container.logger,
      },
      {
        request: body as ExecutionRequestV1,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    );

    const value = unwrapOrThrow(accepted);
    void reply.header('Location', value.statusUrl);
    return value;
  }

  @Get('executions/:executionId')
  async get(@Param('executionId') executionId: string): Promise<ExecutionResultV1> {
    const result = await getExecution({ store: this.container.executionStore }, executionId);
    return unwrapOrThrow(result);
  }

  @Post('executions/:executionId/cancel')
  @HttpCode(202)
  async cancel(
    @Param('executionId') executionId: string,
  ): Promise<{ executionId: string; status: string }> {
    const result = await cancelExecution(
      {
        store: this.container.executionStore,
        queue: this.container.executionQueue,
        clock: this.container.clock,
        logger: this.container.logger,
      },
      executionId,
    );
    return unwrapOrThrow(result);
  }

  /** Validation without scheduling, so a generator can check IR before running it. */
  @Post('validate/execution')
  // 200, not Nest's POST default of 201: validating creates nothing. The
  // published contract says 200, and the two must agree.
  @HttpCode(200)
  validateExecution(@Body() body: unknown): { valid: true } {
    unwrapOrThrow(this.container.schemas.validate(SCHEMA_IDS.executionRequest, body));
    return { valid: true };
  }

  @Post('validate/test-ir')
  @HttpCode(200)
  validateTestIr(@Body() body: unknown): { valid: true } {
    unwrapOrThrow(this.container.schemas.validate(SCHEMA_IDS.testIr, body));
    return { valid: true };
  }
}
