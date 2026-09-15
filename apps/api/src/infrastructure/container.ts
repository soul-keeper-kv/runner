import { Redis } from 'ioredis';
import type {
  AuthProfileStorePort,
  ExecutionQueuePort,
  ExecutionStorePort,
  InspectionQueuePort,
  InspectionStorePort,
  LiveCommandTransportPort,
  RegistryPort,
  SessionStorePort,
} from '@runner/application';
import { createSchemaRegistry, type SchemaRegistry } from '@runner/contracts-internal';
import {
  PostgresAuthProfileStore,
  PostgresRegistryStore,
  createPostgresClient,
} from '@runner/infrastructure-postgres';
import {
  RedisExecutionStore,
  RedisInspectionStore,
  RedisLiveCommandTransport,
  RedisRegistryStore,
  RedisSessionStore,
} from '@runner/infrastructure-redis';
import {
  createConsoleLogger,
  createSecretBox,
  systemClock,
  type Clock,
  type Logger,
} from '@runner/shared';
import type { ApiConfig } from './config/config.js';
import { InMemoryExecutionStore } from './persistence/in-memory-execution-store.js';
import { InMemoryInspectionStore } from './persistence/in-memory-inspection-store.js';
import { InMemoryRegistryStore } from './persistence/in-memory-registry-store.js';
import { InMemorySessionStore } from './persistence/in-memory-session-store.js';
import { BullMqExecutionQueue } from './queue/bullmq-execution-queue.js';
import { BullMqInspectionQueue } from './queue/bullmq-inspection-queue.js';
import { InMemoryExecutionQueue } from './queue/in-memory-execution-queue.js';
import { InMemoryInspectionQueue } from './queue/in-memory-inspection-queue.js';

/**
 * The composition root.
 *
 * Every decision about *which* adapter implements a port is made here and
 * nowhere else. Controllers and use cases receive ports; they never construct
 * a Redis client or a database handle, which is what keeps the architecture
 * boundaries in the blueprint enforceable rather than aspirational.
 */

export interface ApiContainer {
  readonly config: ApiConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly schemas: SchemaRegistry;
  readonly executionStore: ExecutionStorePort;
  readonly inspectionStore: InspectionStorePort;
  readonly registryStore: RegistryPort;
  /**
   * Undefined without Postgres *or* without an encryption key: the routes then
   * answer 501 rather than storing a credential the Runner cannot protect.
   */
  readonly authProfileStore: AuthProfileStorePort | undefined;
  readonly sessionStore: SessionStorePort;
  /** Undefined when no Redis is configured: live commands need the worker. */
  readonly liveCommands: LiveCommandTransportPort | undefined;
  readonly executionQueue: ExecutionQueuePort;
  readonly inspectionQueue: InspectionQueuePort;
  shutdown(): Promise<void>;
}

export function createContainer(config: ApiConfig): ApiContainer {
  const logger = createConsoleLogger(config.logLevel, { service: 'runner-api' });
  const clock = systemClock;
  const schemas = createSchemaRegistry();

  // Redis-backed adapters when configured; in-memory otherwise, so `pnpm dev`
  // and contract tests work without Docker.
  //
  // The execution store must be the *same* store the worker reads: the API
  // writes a record and enqueues, the worker reads that record and runs it.
  // An in-memory store here with a Redis worker would enqueue jobs that can
  // never find their plan.
  const redis = config.usePersistence
    ? new Redis(config.redisUrl, { maxRetriesPerRequest: null })
    : undefined;

  const executionQueue: ExecutionQueuePort =
    redis === undefined
      ? new InMemoryExecutionQueue(logger)
      : new BullMqExecutionQueue(config.redisUrl, logger);

  const executionStore: ExecutionStorePort =
    redis === undefined ? new InMemoryExecutionStore() : new RedisExecutionStore(redis);

  const inspectionQueue: InspectionQueuePort =
    redis === undefined
      ? new InMemoryInspectionQueue(logger)
      : new BullMqInspectionQueue(config.redisUrl, logger);

  const inspectionStore: InspectionStorePort =
    redis === undefined ? new InMemoryInspectionStore() : new RedisInspectionStore(redis);

  // A live session must be visible to the worker that holds its browser: the
  // API creates the record, the worker reads it before dispatching a command.
  // An in-memory store here with a Redis worker would accept a socket and then
  // fail every command with "session lost", which is far harder to diagnose
  // than a refusal at startup.
  const sessionStore: SessionStorePort =
    redis === undefined ? new InMemorySessionStore(clock) : new RedisSessionStore(redis, clock);

  // Live command dispatch requires the worker, so it exists only alongside
  // Redis. Without it the gateway reports precisely that, rather than timing
  // out against a worker that was never there.
  const liveCommands: LiveCommandTransportPort | undefined =
    redis === undefined ? undefined : new RedisLiveCommandTransport(config.redisUrl, logger);

  /*
   * The Registry's system of record is Postgres.
   *
   * Element identity is the one thing here that must not be disposable: every
   * previously generated Test IR references it, so a Redis flush would orphan
   * work that is supposed to outlive any process. Redis remains the fallback for
   * a developer running without a database, and in-memory for one running with
   * neither — each step down is a step further from durable.
   *
   * Every caller depends on `RegistryPort`, so this binding is the only thing
   * that changes.
   */
  const postgres = config.databaseUrl === '' ? undefined : createPostgresClient(config.databaseUrl);

  const registryStore: RegistryPort =
    postgres !== undefined
      ? new PostgresRegistryStore(postgres, clock, logger)
      : redis === undefined
        ? new InMemoryRegistryStore(clock, logger)
        : new RedisRegistryStore(redis, clock, logger);

  if (postgres === undefined) {
    logger.warn(
      'No DATABASE_URL: the Registry is not durable. Element identities are lost when this process or Redis restarts.',
    );
  }

  if (redis === undefined) {
    logger.warn(
      'Running with in-memory adapters. Executions are not shared with a worker and are lost on restart. Set DATABASE_URL and REDIS_URL for a working end-to-end setup.',
    );
  }

  /*
   * Managed auth profiles need Postgres *and* an encryption key.
   *
   * There is deliberately no in-memory or unencrypted fallback. A credential
   * the Runner cannot protect must not be stored at all, so a deployment
   * missing either one gets a 501 naming what is missing — which is a far
   * better outcome than a database quietly holding readable passwords.
   */
  const secretBox =
    config.secretKey === '' ? undefined : createSecretBox(config.secretKey);

  if (secretBox !== undefined && !secretBox.ok) {
    // A key too short to protect anything is a configuration error, and saying
    // so at startup beats discovering it on the first save.
    logger.error(secretBox.error.message);
  }

  const authProfileStore: AuthProfileStorePort | undefined =
    postgres !== undefined && secretBox?.ok === true
      ? new PostgresAuthProfileStore(postgres, secretBox.value, clock, logger)
      : undefined;

  if (authProfileStore === undefined) {
    logger.warn(
      config.secretKey === ''
        ? 'No RUNNER_SECRET_KEY: auth profiles cannot be managed over the API. Declare profiles in the worker\'s RUNNER_AUTH_PROFILES instead.'
        : 'Managed auth profiles are unavailable: they need DATABASE_URL and a valid RUNNER_SECRET_KEY.',
    );
  }

  return {
    config,
    logger,
    clock,
    schemas,
    executionStore,
    inspectionStore,
    registryStore,
    authProfileStore,
    sessionStore,
    liveCommands,
    executionQueue,
    inspectionQueue,
    async shutdown() {
      await executionQueue.close();
      await inspectionQueue.close();
      await liveCommands?.close();
      await postgres?.end();
      redis?.disconnect();
    },
  };
}
