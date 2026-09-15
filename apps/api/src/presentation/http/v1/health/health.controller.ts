import { Controller, Get, Inject } from '@nestjs/common';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * Liveness and readiness.
 *
 * `/health` answers "is this process up" and is what a load balancer polls.
 * It deliberately does not check Postgres or Redis: a dependency outage should
 * not make the API look dead and get restarted in a loop.
 */
@Controller()
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  @Get('health')
  health(): { status: string; version: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      version: this.container.config.version,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get('ready')
  ready(): { status: string; persistence: string } {
    return {
      status: 'ok',
      persistence: this.container.config.usePersistence ? 'postgres+redis' : 'in-memory',
    };
  }
}
