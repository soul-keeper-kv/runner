import { Controller, Get, Inject } from '@nestjs/common';
import { buildCapabilities, type RunnerCapabilities } from '@runner/contracts-internal';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * Runner self-description (blueprint section 3.9).
 *
 * An external IR Generator calls this to discover which contract versions,
 * action types and features this deployment actually supports, instead of
 * assuming and failing at execution time.
 */
@Controller('api/v1')
export class CapabilitiesController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  @Get('capabilities')
  capabilities(): RunnerCapabilities {
    return buildCapabilities({
      version: this.container.config.version,
      // Every optional feature is stated explicitly, and every one of these is
      // false until its phase lands: the endpoint must tell the truth about
      // this build rather than about the roadmap. Leaving one to its default
      // is how `registry.elements` came to advertise AVAILABLE while every
      // registry route answered 501.
      // Phase 13: a semantic resolver is bound in the worker. It reranks a
      // shortlist only after deterministic resolution has refused it, and it
      // never executes — so this says "available", not "in charge".
      semanticResolverAvailable: true,
      // Phase 12: healing proposes replacement selectors. A run must still opt
      // in per execution via `options.enableSelfHealing`; this only says the
      // build can do it.
      selfHealingAvailable: true,
      // Phase 4: the Registry answers reads through RegistryPort, and writes go
      // through draft-then-commit.
      registryAvailable: true,
      // Phase 11: the recorder serves `recording.*` live commands and returns
      // Test IR. It needs the worker, so it tracks the same binding as the rest
      // of live session support.
      recorderAvailable: this.container.liveCommands !== undefined,
      // Phase 7: live commands reach the worker's capabilities. Only the
      // namespaces actually registered there answer; the rest report
      // LIVE_COMMAND_UNSUPPORTED naming the command, which `liveCommands` in
      // this document enumerates.
      liveSessionsAvailable: this.container.liveCommands !== undefined,
    });
  }
}
