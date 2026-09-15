import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { closeLiveSession, getLiveSession, startLiveSession } from '@runner/application';
import type { LiveSession } from '@runner/live-protocol';
import { RunnerErrors, unwrapOrThrow } from '@runner/shared';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

interface CreateLiveSessionBody {
  readonly workspaceRef?: string;
  readonly executionId?: string;
  readonly ttlSeconds?: number;
}

/**
 * Live session lifecycle over HTTP (blueprint section 52.4).
 *
 * Creation and teardown are plain HTTP; the realtime interaction happens over
 * the WebSocket at /api/v1/live-sessions/:id/ws. Splitting them this way means
 * a client can create and inspect sessions with ordinary REST tooling, and only
 * opens a socket when it actually needs live commands.
 */
@Controller('api/v1/live-sessions')
export class LiveSessionsController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  private deps() {
    return {
      sessions: this.container.sessionStore,
      clock: this.container.clock,
      logger: this.container.logger,
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateLiveSessionBody): Promise<LiveSession> {
    if (body?.workspaceRef === undefined || body.workspaceRef.trim().length === 0) {
      throw RunnerErrors.validationFailed('workspaceRef is required.');
    }

    const session = await startLiveSession(this.deps(), {
      workspaceRef: body.workspaceRef,
      ...(body.executionId === undefined ? {} : { executionId: body.executionId }),
      ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
    });
    return unwrapOrThrow(session);
  }

  @Get(':sessionId')
  async get(@Param('sessionId') sessionId: string): Promise<LiveSession> {
    return unwrapOrThrow(await getLiveSession(this.deps(), sessionId));
  }

  @Delete(':sessionId')
  @HttpCode(204)
  async close(@Param('sessionId') sessionId: string): Promise<void> {
    unwrapOrThrow(await closeLiveSession(this.deps(), sessionId));
  }
}
