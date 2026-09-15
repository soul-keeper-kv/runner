import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

// ajv-formats is CommonJS using `export =`; under NodeNext the callable lives
// on `.default` at runtime while the type resolves to the namespace.
const addFormats = (ajvFormatsModule as unknown as { default: (ajv: Ajv2020) => unknown }).default;

/**
 * Schema loading and validation for the public wire contracts.
 *
 * The schemas in `contracts/json-schema` are the published artifact an external
 * IR Generator integrates against, in any language. Validating against those
 * exact files — rather than a hand-maintained TypeScript copy — means the
 * Runner can never accept a payload its own published contract rejects.
 */

export const SCHEMA_IDS = {
  testIr: 'test-ir-v1.schema.json',
  executionRequest: 'execution-request-v1.schema.json',
  executionResult: 'execution-result-v1.schema.json',
  inspectionRequest: 'inspection-request-v1.schema.json',
  liveCommand: 'live-command-v1.schema.json',
  publicEvent: 'public-event-v1.schema.json',
} as const;

export type SchemaId = (typeof SCHEMA_IDS)[keyof typeof SCHEMA_IDS];

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly keyword?: string;
}

export interface SchemaRegistry {
  validate(schemaId: SchemaId, payload: unknown): Result<void>;
  getSchema(schemaId: SchemaId): Result<object>;
  listSchemas(): readonly SchemaId[];
}

/**
 * Locates `contracts/json-schema` by walking up from this module.
 *
 * Walking rather than counting `..` segments keeps this correct whether the
 * code runs from `src/` under vitest or from `dist/` in a built app, and
 * survives a change in nesting depth.
 */
function defaultSchemaDir(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, 'contracts', 'json-schema');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    'Could not locate contracts/json-schema. Pass an explicit directory to createSchemaRegistry().',
  );
}

export function createSchemaRegistry(schemaDir: string = defaultSchemaDir()): SchemaRegistry {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    // Draft 2020-12 $ref across files needs every schema registered up front.
    loadSchema: undefined,
  });
  addFormats(ajv);

  const rawSchemas = new Map<SchemaId, object>();
  const validators = new Map<SchemaId, ValidateFunction>();

  // Register every schema first so cross-file $ref resolves without async loading.
  for (const schemaId of Object.values(SCHEMA_IDS)) {
    const schema = JSON.parse(readFileSync(join(schemaDir, schemaId), 'utf8')) as object;
    rawSchemas.set(schemaId, schema);
    ajv.addSchema(schema, schemaId);
  }

  for (const schemaId of Object.values(SCHEMA_IDS)) {
    const validator = ajv.getSchema(schemaId);
    if (validator === undefined) {
      throw new Error(`Schema "${schemaId}" failed to compile.`);
    }
    validators.set(schemaId, validator);
  }

  return {
    validate(schemaId, payload) {
      const validator = validators.get(schemaId);
      if (validator === undefined) {
        return err(RunnerErrors.internal(`Unknown schema "${schemaId}".`));
      }

      if (validator(payload)) return ok(undefined);

      const issues = toIssues(validator.errors ?? []);
      return err(
        RunnerErrors.validationFailed(
          `Payload does not match ${schemaId}: ${summarize(issues)}`,
          { schemaId, issues },
        ),
      );
    },

    getSchema(schemaId) {
      const schema = rawSchemas.get(schemaId);
      return schema === undefined
        ? err(RunnerErrors.internal(`Unknown schema "${schemaId}".`))
        : ok(schema);
    },

    listSchemas() {
      return Object.values(SCHEMA_IDS);
    },
  };
}

function toIssues(errors: readonly ErrorObject[]): ValidationIssue[] {
  return errors.map((error) => ({
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'is invalid',
    ...(error.keyword === undefined ? {} : { keyword: error.keyword }),
  }));
}

function summarize(issues: readonly ValidationIssue[]): string {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issue.path} ${issue.message}`)
    .join('; ');
  return issues.length > 3 ? `${shown} (+${issues.length - 3} more)` : shown;
}
