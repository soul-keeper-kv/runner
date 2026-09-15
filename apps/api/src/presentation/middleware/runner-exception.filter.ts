import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RunnerError, type RunnerErrorCode } from '@runner/shared';

/**
 * Translates internal errors into the published HTTP error shape.
 *
 * Two things happen here that matter to callers. First, a RunnerError's code
 * determines the status, so a contract violation is a 400 and a missing run is
 * a 404 — never an opaque 500. Second, nothing but the serialized RunnerError
 * reaches the wire, so internal stack traces and causes stay in the logs.
 */

const STATUS_BY_CODE: Partial<Record<RunnerErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  CONTRACT_VERSION_UNSUPPORTED: 400,
  SELECTOR_INVALID: 400,
  EXECUTION_NOT_FOUND: 404,
  INSPECTION_NOT_FOUND: 404,
  REGISTRY_ENTITY_NOT_FOUND: 404,
  LIVE_SESSION_LOST: 404,
  ELEMENT_NOT_FOUND: 404,
  REGISTRY_CONFLICT: 409,
  EXECUTION_CANCELLED: 409,
  LIVE_COMMAND_UNSUPPORTED: 501,
  CAPABILITY_NOT_IMPLEMENTED: 501,
  AUTH_FAILED: 401,
};

@Catch()
export class RunnerExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (RunnerError.is(exception)) {
      const status = STATUS_BY_CODE[exception.code] ?? 500;
      void reply.status(status).send({ error: exception.toJSON() });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      void reply.status(status).send({
        error: {
          code: status === 404 ? 'EXECUTION_NOT_FOUND' : 'VALIDATION_FAILED',
          kind: 'CONTRACT_FAILURE',
          message: exception.message,
          retryable: false,
        },
      });
      return;
    }

    // An unexpected throw is a bug: report it as INTERNAL_ERROR without
    // leaking the underlying message to an external caller.
    void reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        kind: 'INFRASTRUCTURE_FAILURE',
        message: 'An unexpected error occurred.',
        retryable: true,
      },
    });
  }
}
