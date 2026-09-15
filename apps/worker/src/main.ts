import { Redis } from 'ioredis';
import { Worker, type Job } from 'bullmq';
import type { ExecutionJob, InspectionJob } from '@runner/application';
import { createConsoleLogger, createSecretBox, systemClock, type LogLevel } from '@runner/shared';
import { PlaywrightBrowserManager } from './infrastructure/playwright/playwright-browser-manager.js';
import {
  RedisEventBus,
  RedisExecutionStore,
  RedisInspectionStore,
  RedisLiveCommandTransport,
  RedisRegistryStore,
  RedisSessionStore,
  RedisStorageStateStore,
} from '@runner/infrastructure-redis';
import { AuthService } from './modules/auth/auth-service.js';
import { AuthenticatedStateHandler } from './modules/auth/authenticated-state-handler.js';
import { AuthCapability } from './capabilities/auth/auth-capability.js';
import { EnvSecretProvider } from './infrastructure/secrets/env-secret-provider.js';
import { CompositeSecretProvider } from './infrastructure/secrets/composite-secret-provider.js';
import { FetchHttpClient } from './infrastructure/http/fetch-http-client.js';
import { SessionManager } from './modules/session/session-manager.js';
import { DomInspector } from './modules/inspector/dom-inspector.js';
import { DeterministicElementResolver } from './modules/resolver/element-resolver.js';
import { StateObserver } from './modules/observer/state-observer.js';
import { PreconditionEngine } from './modules/state/precondition-engine.js';
import {
  ElementVisibleHandler,
  EntityStateHandler,
  UiStateHandler,
  UrlMatchesHandler,
} from './modules/state/page-state-handlers.js';
import {
  DEFAULT_LIVE_RUNTIME_OPTIONS,
  LiveSessionRuntime,
} from './modules/live/live-session-runtime.js';
import { CapabilityRegistry } from './capabilities/capability-registry.js';
import { BrowserCapability } from './capabilities/browser/browser-capability.js';
import { ElementCapability } from './capabilities/element/element-capability.js';
import { RegistryCapability } from './capabilities/registry/registry-capability.js';
import { RecordingCapability } from './capabilities/recording/recording-capability.js';
import { InteractionRecorder } from './modules/recorder/interaction-recorder.js';
import { HealingEngine } from './modules/healing/healing-engine.js';
import { HeuristicSemanticResolver } from './infrastructure/semantic/heuristic-semantic-resolver.js';
import {
  PostgresAuthProfileStore,
  PostgresRegistryStore,
  createPostgresClient,
} from '@runner/infrastructure-postgres';
import { SelectorCapability } from './capabilities/selector/selector-capability.js';
import { StateCapability } from './capabilities/state/state-capability.js';
import { ViewCapability } from './capabilities/view/view-capability.js';
import { DefaultLocatorGenerator } from './modules/locator/locator-generator.js';
import { runExecution } from './application/use-cases/run-execution.js';
import { runInspection } from './application/use-cases/run-inspection.js';

/**
 * Worker process entry point.
 *
 * This process owns Playwright and nothing else owns it. It is separate from
 * the API so a hung page, a browser crash or an OOM affects only in-flight
 * executions, while the public API keeps accepting and reporting work
 * (blueprint section 2.5).
 *
 * The worker is internal: no external service ever addresses it directly.
 */

export const EXECUTION_QUEUE_NAME = 'runner.executions';
export const INSPECTION_QUEUE_NAME = 'runner.inspections';

async function bootstrap(): Promise<void> {
  const logLevel = (process.env.RUNNER_LOG_LEVEL ?? 'info') as LogLevel;
  const logger = createConsoleLogger(logLevel, { service: 'runner-worker' });
  const redisUrl = process.env.REDIS_URL;
  const concurrency = Number.parseInt(process.env.RUNNER_WORKER_CONCURRENCY ?? '2', 10);

  if (redisUrl === undefined || redisUrl.length === 0) {
    logger.error('REDIS_URL is required. Start infrastructure with `pnpm infra:up`.');
    process.exit(1);
  }

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const store = new RedisExecutionStore(redis);
  const inspectionStore = new RedisInspectionStore(redis);

  const browsers = new PlaywrightBrowserManager(logger);
  const inspector = new DomInspector();
  /*
   * Phase 13: the AI seam, bound to a heuristic reranker.
   *
   * It ranks a shortlist on context the label pass ignores and never executes or
   * navigates — it is handed neither a browser nor the Registry. An LLM-backed
   * adapter implements the same port and replaces this binding; nothing above
   * the port changes, which is why the port existed before any model did.
   */
  const semanticResolver = new HeuristicSemanticResolver(logger, systemClock);
  const resolver = new DeterministicElementResolver(
    logger,
    undefined,
    undefined,
    undefined,
    semanticResolver,
  );

  /*
   * Phase 10: the worker reaches the Registry through the same Redis-backed
   * adapter the API uses, so a draft proposed from a live pick is immediately
   * visible at /api/v1/registry/modifications.
   */
  // Postgres is the Registry's system of record; Redis is the fallback when a
  // worker runs without a database. Both satisfy RegistryPort, so the healing
  // engine and the registry capability are unaffected either way.
  const databaseUrl = process.env.DATABASE_URL;
  const postgres =
    databaseUrl === undefined || databaseUrl.length === 0
      ? undefined
      : createPostgresClient(databaseUrl);

  if (postgres === undefined) {
    logger.warn(
      'No DATABASE_URL: the Registry is not durable in this worker. Set it so drafts and revisions survive a restart.',
    );
  }

  const registry =
    postgres === undefined
      ? new RedisRegistryStore(redis, systemClock, logger)
      : new PostgresRegistryStore(postgres, systemClock, logger);

  /*
   * Phase 5: authentication.
   *
   * Credentials come from the environment in this build; a deployment binds a
   * Vault or Secrets Manager adapter here instead and nothing above the port
   * changes. The captured session is cached in Redis so a UI login happens once
   * rather than at the start of every run.
   */
  const storageStates = new RedisStorageStateStore(redis, systemClock);

  /*
   * Profiles come from managed storage first, then from the environment.
   *
   * Both are legitimate: a profile stored through the API lets a team point the
   * Runner at a new application without a redeploy, while
   * `RUNNER_AUTH_PROFILES` remains the answer for a deployment that will not
   * put a credential in its database, and for local work with no Postgres.
   *
   * The key is required for the managed half and never stored with the data, so
   * a worker without it simply falls back — it does not read credentials it
   * cannot decrypt.
   */
  const envSecrets = new EnvSecretProvider(logger);
  const secretKey = process.env.RUNNER_SECRET_KEY ?? '';
  const secretBox = secretKey === '' ? undefined : createSecretBox(secretKey);

  if (secretBox !== undefined && !secretBox.ok) {
    logger.error(secretBox.error.message);
  }

  const authProfiles =
    postgres !== undefined && secretBox?.ok === true
      ? new PostgresAuthProfileStore(postgres, secretBox.value, systemClock, logger)
      : undefined;

  if (authProfiles === undefined) {
    logger.warn(
      'Managed auth profiles are unavailable in this worker (needs DATABASE_URL and RUNNER_SECRET_KEY); using RUNNER_AUTH_PROFILES only.',
    );
  }

  const auth = new AuthService({
    secrets:
      authProfiles === undefined
        ? envSecrets
        : new CompositeSecretProvider(authProfiles, envSecrets, logger),
    storageStates,
    resolver,
    clock: systemClock,
    logger,
    // The only outbound HTTP the Runner makes on its own behalf: exchanging
    // credentials for a token at an application's login endpoint.
    http: new FetchHttpClient(logger),
  });

  const sessions = new SessionManager(browsers, logger, auth);

  // The engine dispatches by precondition type, and an unregistered type fails
  // loudly rather than being skipped — so the handler has to be registered for
  // an `authenticated` precondition to mean anything.
  const preconditions = new PreconditionEngine(logger);
  preconditions.register(
    new AuthenticatedStateHandler(auth, browsers, storageStates, logger),
  );
  // Phase 6: the rest of the declared precondition types. Each one verifies
  // honestly and refuses to "prepare" a state it cannot actually reach — a
  // handler that faked preparation would turn a missing fixture into a pass.
  preconditions.register(new UrlMatchesHandler(browsers, logger));
  preconditions.register(new ElementVisibleHandler(browsers, resolver, logger));
  preconditions.register(new UiStateHandler());
  preconditions.register(new EntityStateHandler());

  // Phase 12: healing proposes a replacement when a stored selector stops
  // matching. It is passed the Registry so it can read the element it is
  // healing, and it never commits — a proposal is a record, not a repair.
  const healing = new HealingEngine({ registry, clock: systemClock, logger });

  const deps = {
    store,
    sessions,
    inspector,
    resolver,
    observer: new StateObserver(),
    preconditions,
    healing,
    registry,
    clock: systemClock,
    logger,
  };

  const inspectionDeps = {
    store: inspectionStore,
    sessions,
    inspector,
    generator: new DefaultLocatorGenerator(),
    clock: systemClock,
    logger,
  };

  /*
   * Redis-backed, because the events that matter most have to leave this
   * process: the worker owns the browser and the API owns the public socket, so
   * a streamed frame published in-process would reach nobody. `InProcessEventBus`
   * stays the right bus for consumers that live here.
   */
  const eventBus = new RedisEventBus(redisUrl, logger);

  // Capabilities that are implemented are registered; the rest are absent on
  // purpose, so an unimplemented live command reports itself precisely rather
  // than failing generically.
  const capabilities = new CapabilityRegistry(logger);
  capabilities.register(new BrowserCapability());
  capabilities.register(new SelectorCapability());
  // Phase 8: the state capability captures the frame the workspace renders, so
  // it is told the same viewport the runtime launches live browsers with.
  capabilities.register(new StateCapability(DEFAULT_LIVE_RUNTIME_OPTIONS.viewport));
  // Phase 9: picking an element from a click on that frame.
  capabilities.register(new ElementCapability(undefined, undefined, registry));
  // Phase 10: registry editing. Every command proposes a draft; confirming is a
  // second, recorded step, which is what keeps undo and review possible.
  capabilities.register(new RegistryCapability(registry, systemClock));
  // Phase 11: recording a session into Test IR. The client reports what the user
  // did — nothing is injected into the page under test.
  capabilities.register(new RecordingCapability(new InteractionRecorder(logger)));
  // Phase 5 in a live session: a session started from a profile opens with that
  // profile's stored session applied, and this capability covers the two cases
  // that need a command — a profile logging in for the very first time, and an
  // application that signed the user out while the view stayed open.
  capabilities.register(new AuthCapability(auth, storageStates));
  // The live view's streaming half: `state.snapshot` answers one request with
  // one frame, this turns the engine's own stream on so the preview stops being
  // a still image that only changes when someone asks.
  capabilities.register(new ViewCapability());

  logger.info('Live capabilities registered', {
    commands: capabilities.supportedCommands().length,
  });

  /**
   * Phase 7: live commands are served here, against browsers this process holds
   * open per session.
   *
   * The API owns the public WebSocket and this process owns the browser, so a
   * command crosses between them over the transport rather than either
   * importing the other. The runtime keeps each session's browser alive between
   * commands — editing a selector must not restart the page whose state made
   * the selector worth checking.
   */
  const liveSessions = new RedisSessionStore(redis, systemClock);
  const liveRuntime = new LiveSessionRuntime(
    browsers,
    liveSessions,
    capabilities,
    systemClock,
    logger,
    DEFAULT_LIVE_RUNTIME_OPTIONS,
    // So a session that names a profile opens with that profile's stored
    // session already applied, rather than on a login page.
    auth,
    // So `view.start` has somewhere to publish frames that the API can hear.
    eventBus,
  );

  const liveTransport = new RedisLiveCommandTransport(redisUrl, logger);
  const serving = await liveTransport.serve((command) => liveRuntime.handle(command));
  if (!serving.ok) {
    logger.error('Could not serve live commands', { errorCode: serving.error.code });
    process.exit(1);
  }

  // A live session pins a browser context, so an abandoned one must not hold it
  // forever. This is deliberately independent of the API's session TTL: either
  // process can lose the other without leaking a browser.
  const reaper = setInterval(() => {
    void liveRuntime.reapIdle();
  }, 60_000);
  // Keeping the interval unref'd means it never by itself holds the process open.
  reaper.unref();

  const worker = new Worker<ExecutionJob>(
    EXECUTION_QUEUE_NAME,
    async (job: Job<ExecutionJob>) => {
      const { executionId } = job.data;
      const runLogger = logger.child({ runId: executionId });

      const record = await store.get(executionId);
      if (!record.ok) {
        // The API persists the record before enqueueing, so a missing one means
        // the record expired or the store was reset. Failing the job surfaces
        // that instead of retrying against state that will never appear.
        runLogger.error('Execution record not found; nothing to run', {
          errorCode: record.error.code,
        });
        throw record.error;
      }

      await eventBus.publish({
        id: `evt_${job.id ?? executionId}`,
        sessionId: executionId,
        type: 'execution.started',
        sequence: 0,
        timestamp: systemClock.nowIso(),
        payload: { executionId },
      });

      const outcome = await runExecution(deps, record.value.plan);

      // A failed *test* is a completed job: the run produced a verdict. Only an
      // infrastructure failure should make BullMQ mark the job itself failed.
      if (!outcome.ok) {
        runLogger.error('Execution could not run', { errorCode: outcome.error.code });
        throw outcome.error;
      }

      await eventBus.publish({
        id: `evt_${job.id ?? executionId}_done`,
        sessionId: executionId,
        type: outcome.value === 'PASSED' ? 'execution.completed' : 'execution.failed',
        sequence: 1,
        timestamp: systemClock.nowIso(),
        payload: { executionId, status: outcome.value },
      });
    },
    {
      connection: { url: redisUrl },
      concurrency,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error('Execution job failed', {
      runId: job?.data.executionId,
      reason: error.message,
    });
  });

  worker.on('completed', (job) => {
    logger.info('Execution job completed', { runId: job.data.executionId });
  });

  /**
   * Page inspection runs on its own queue.
   *
   * An inspection is short and someone is usually waiting on it, while a test
   * run can hold a browser for minutes. Separate queues mean a backlog of
   * regression runs cannot delay an inspection, and each gets its own
   * concurrency.
   */
  const inspectionWorker = new Worker<InspectionJob>(
    INSPECTION_QUEUE_NAME,
    async (job: Job<InspectionJob>) => {
      const { inspectionId } = job.data;
      const jobLogger = logger.child({ inspectionId });

      const record = await inspectionStore.get(inspectionId);
      if (!record.ok) {
        jobLogger.error('Inspection record not found; nothing to inspect', {
          errorCode: record.error.code,
        });
        throw record.error;
      }

      // A page that cannot be inspected is recorded as FAILED on the record
      // itself, with its error; the job only fails when the Runner could not
      // even record that outcome.
      const outcome = await runInspection(inspectionDeps, record.value);
      if (!outcome.ok) {
        jobLogger.warn('Inspection finished without findings', {
          errorCode: outcome.error.code,
        });
      }
    },
    {
      connection: { url: redisUrl },
      concurrency,
    },
  );

  inspectionWorker.on('failed', (job, error) => {
    logger.error('Inspection job failed', {
      inspectionId: job?.data.inspectionId,
      reason: error.message,
    });
  });

  logger.info('Runner worker started', {
    queues: [EXECUTION_QUEUE_NAME, INSPECTION_QUEUE_NAME],
    concurrency,
    liveCommands: capabilities.supportedCommands().length,
  });

  const shutdown = (signal: string): void => {
    void (async () => {
      logger.info(`Received ${signal}; draining worker.`);
      // Close the workers first so no new job starts, then release browsers.
      await worker.close();
      await inspectionWorker.close();
      clearInterval(reaper);
      // Stop accepting live commands before tearing down the browsers they
      // would otherwise be dispatched against.
      await liveTransport.close();
      await liveRuntime.shutdown();
      await browsers.shutdown();
      redis.disconnect();
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error: unknown) => {
  console.error('Runner worker failed to start:', error);
  process.exit(1);
});
