import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { ApiContainer } from './infrastructure/container.js';
import { CONTAINER } from './infrastructure/container.token.js';
import { RunnerExceptionFilter } from './presentation/middleware/runner-exception.filter.js';
import { HealthController } from './presentation/http/v1/health/health.controller.js';
import { CapabilitiesController } from './presentation/http/v1/capabilities/capabilities.controller.js';
import { OpenApiController } from './presentation/http/v1/capabilities/openapi.controller.js';
import { SchemasController } from './presentation/http/v1/schemas/schemas.controller.js';
import { ExecutionsController } from './presentation/http/v1/executions/executions.controller.js';
import { ExecutionEventsController } from './presentation/http/v1/executions/execution-events.controller.js';
import { InspectionsController } from './presentation/http/v1/inspections/inspections.controller.js';
import { LiveSessionsController } from './presentation/http/v1/live-sessions/live-sessions.controller.js';
import { AuthProfilesController } from './presentation/http/v1/auth-profiles/auth-profiles.controller.js';
import { RegistryController } from './presentation/http/v1/registry/registry.controller.js';

/**
 * The Nest module graph.
 *
 * The container is built outside Nest and injected as a value provider, so the
 * framework wires HTTP concerns while the composition root stays framework-free
 * and directly testable — a use case can be exercised without booting Nest.
 */
@Module({})
export class AppModule {
  static forContainer(container: ApiContainer): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CapabilitiesController,
        OpenApiController,
        SchemasController,
        ExecutionsController,
        ExecutionEventsController,
        InspectionsController,
        LiveSessionsController,
        AuthProfilesController,
        RegistryController,
      ],
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: APP_FILTER, useClass: RunnerExceptionFilter },
      ],
    };
  }
}
