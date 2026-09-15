import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { SCHEMA_IDS } from '@runner/contracts-internal';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * Serves the published JSON Schemas (blueprint section 3.9).
 *
 * This is what makes "integrate via contract, not via source code" concrete:
 * a generator written in Java or Python fetches these documents and validates
 * locally, with no Runner package to install.
 */
@Controller('api/v1/schemas')
export class SchemasController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  @Get()
  list(): { schemas: { name: string; url: string }[] } {
    return {
      schemas: [
        { name: 'test-ir', url: '/api/v1/schemas/test-ir' },
        { name: 'execution-request', url: '/api/v1/schemas/execution-request' },
        { name: 'execution-result', url: '/api/v1/schemas/execution-result' },
        { name: 'inspection-request', url: '/api/v1/schemas/inspection-request' },
        { name: 'live-command', url: '/api/v1/schemas/live-command' },
        { name: 'public-event', url: '/api/v1/schemas/public-event' },
      ],
    };
  }

  @Get(':name')
  get(@Param('name') name: string): object {
    const schemaId = SCHEMA_ID_BY_NAME[name];
    if (schemaId === undefined) {
      throw new NotFoundException(`Unknown schema "${name}".`);
    }

    const schema = this.container.schemas.getSchema(schemaId);
    if (!schema.ok) throw schema.error;
    return schema.value;
  }
}

const SCHEMA_ID_BY_NAME: Readonly<Record<string, (typeof SCHEMA_IDS)[keyof typeof SCHEMA_IDS]>> = {
  'test-ir': SCHEMA_IDS.testIr,
  'execution-request': SCHEMA_IDS.executionRequest,
  'execution-result': SCHEMA_IDS.executionResult,
  'inspection-request': SCHEMA_IDS.inspectionRequest,
  'live-command': SCHEMA_IDS.liveCommand,
  'public-event': SCHEMA_IDS.publicEvent,
};
