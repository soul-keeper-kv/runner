import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get } from '@nestjs/common';
import { load as parseYaml } from 'js-yaml';
import { RunnerErrors } from '@runner/shared';

/**
 * Serves `contracts/openapi/runner-v1.yaml` as JSON at `/openapi.json`.
 *
 * The YAML file in `contracts/` is the single source of truth: it is reviewed,
 * diffed and versioned alongside the JSON Schemas, and served from disk rather
 * than regenerated from decorators. That way the document a caller reads is
 * exactly the document the team edits.
 */
@Controller()
export class OpenApiController {
  private cached: object | undefined;

  @Get('openapi.json')
  openapi(): object {
    // Parsed once; the file does not change within a process lifetime.
    this.cached ??= loadOpenApiDocument();
    return this.cached;
  }
}

function loadOpenApiDocument(): object {
  const path = findOpenApiFile();
  const document = parseYaml(readFileSync(path, 'utf8'));

  if (document === null || typeof document !== 'object') {
    throw RunnerErrors.internal(`OpenAPI document at ${path} is not a valid object.`);
  }
  return document as object;
}

/** Walks up to the repository root, so this works from src/ and from dist/. */
function findOpenApiFile(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, 'contracts', 'openapi', 'runner-v1.yaml');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw RunnerErrors.internal('Could not locate contracts/openapi/runner-v1.yaml.');
}
