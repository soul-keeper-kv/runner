import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './infrastructure/config/config.js';
import { createContainer } from './infrastructure/container.js';
import { registerLiveSessionGateway } from './presentation/websocket/live-session.gateway.js';

/**
 * API process entry point.
 *
 * This process owns the public contract and the queue; it never drives a
 * browser. Playwright lives in apps/worker, so a crashed or hung browser cannot
 * take the public API down with it (blueprint section 2.5).
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forContainer(container),
    new FastifyAdapter({ logger: false, bodyLimit: 8 * 1024 * 1024 }),
    { bufferLogs: true },
  );

  app.enableCors({
    // The live workspace is a separate Vite origin in development.
    origin: config.nodeEnv === 'production' ? false : true,
    credentials: true,
  });

  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  await fastify.register(fastifyWebsocket);
  registerLiveSessionGateway(fastify, container);

  // Drain in-flight requests and close the queue connection on SIGTERM.
  app.enableShutdownHooks();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        container.logger.info(`Received ${signal}; shutting down.`);
        await app.close();
        await container.shutdown();
        process.exit(0);
      })();
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });

  container.logger.info('Runner API listening', {
    port: config.port,
    docs: `http://localhost:${config.port}/openapi.json`,
    capabilities: `http://localhost:${config.port}/api/v1/capabilities`,
  });
}

bootstrap().catch((error: unknown) => {
  console.error('Runner API failed to start:', error);
  process.exit(1);
});
