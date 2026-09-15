/**
 * End-to-end smoke test.
 *
 * Serves a small fixture page, submits a four-step Test IR through the public
 * API, and polls until the run reaches a terminal status — exercising the whole
 * path: contract validation, the queue, a real Chromium browser, page
 * inspection, deterministic resolution, execution, and the result contract.
 *
 * Run it after a change that touches the pipeline; unit tests cover the
 * decision logic, but only this proves the processes actually work together.
 *
 *   pnpm infra:up
 *   pnpm --filter @runner/api dev        # or: node apps/api/dist/main.js
 *   pnpm --filter @runner/worker dev     # or: node apps/worker/dist/main.js
 *   node scripts/e2e-smoke.mjs
 *
 * Environment:
 *   RUNNER_API_URL    default http://localhost:3001
 *   FIXTURE_PORT      default 8899
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.RUNNER_API_URL ?? 'http://localhost:3001';
const FIXTURE_PORT = Number.parseInt(process.env.FIXTURE_PORT ?? '8899', 10);
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 90_000;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures', 'login.html'), 'utf8');

function testIr() {
  return {
    id: 'tc-login-smoke',
    name: 'User logs in',
    steps: [
      { id: 's1', type: 'goto', value: `http://localhost:${FIXTURE_PORT}/` },
      {
        id: 's2',
        type: 'fill',
        target: { name: 'Email' },
        value: 'user@example.com',
      },
      // Named, not selected: the Runner resolves this to data-testid=login-submit
      // and must not pick the Cancel button beside it.
      { id: 's3', type: 'click', target: { name: 'Login', role: 'button' } },
      {
        id: 's4',
        type: 'assert',
        target: { name: 'Welcome back' },
        assertion: { type: 'containsText', expected: 'Welcome back' },
      },
    ],
  };
}

async function main() {
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  });
  await new Promise((resolve) => fixture.listen(FIXTURE_PORT, resolve));
  console.log(`fixture page on http://localhost:${FIXTURE_PORT}/`);

  try {
    await step('capabilities', async () => {
      const capabilities = await getJson('/api/v1/capabilities');
      console.log(
        `  contracts: ${capabilities.contracts.execution.join(', ')} / ${capabilities.contracts.testIr.join(', ')}`,
      );
    });

    await step('validate test-ir', async () => {
      const result = await postJson('/api/v1/validate/test-ir', testIr());
      if (result.valid !== true) throw new Error('validation did not pass');
    });

    const executionId = await step('submit execution', async () => {
      const accepted = await postJson(
        '/api/v1/executions',
        {
          contractVersion: 'runner.execution.v1',
          irVersion: 'test-ir.v1',
          requestId: `req_smoke_${Date.now()}`,
          workspaceRef: 'workspace_smoke',
          mode: 'AUTO',
          test: testIr(),
        },
        { 'idempotency-key': `smoke-${Date.now()}` },
      );
      console.log(`  executionId: ${accepted.executionId}`);
      return accepted.executionId;
    });

    const result = await step('poll until terminal', () => pollUntilTerminal(executionId));

    console.log(`\nstatus: ${result.status}  (${result.durationMs ?? 0}ms)`);
    for (const stepResult of result.steps) {
      const marker = stepResult.status === 'PASSED' ? 'ok  ' : 'FAIL';
      console.log(`  ${marker} ${stepResult.stepId} ${stepResult.type} -> ${stepResult.status}`);

      if (stepResult.resolvedElement !== undefined) {
        const { selector, confidence } = stepResult.resolvedElement;
        console.log(`       ${JSON.stringify(selector)}  confidence ${confidence}`);
      }
      for (const line of stepResult.evidence ?? []) console.log(`       . ${line}`);
      if (stepResult.error !== undefined) {
        console.log(`       ${stepResult.error.code} (${stepResult.error.kind}): ${stepResult.error.message}`);
      }
    }

    if (result.status !== 'PASSED') {
      console.error('\nSmoke test did not pass.');
      process.exitCode = 1;
    } else {
      console.log('\nSmoke test passed.');
    }
  } finally {
    fixture.close();
  }
}

async function pollUntilTerminal(executionId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const result = await getJson(`/api/v1/executions/${executionId}`);
    if (['PASSED', 'FAILED', 'CANCELLED'].includes(result.status)) return result;

    if (Date.now() > deadline) {
      throw new Error(
        `Execution ${executionId} was still ${result.status} after ${POLL_TIMEOUT_MS}ms. Is the worker running with the same REDIS_URL as the API?`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function step(label, fn) {
  process.stdout.write(`${label}…\n`);
  try {
    return await fn();
  } catch (cause) {
    console.error(`  failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    throw cause;
  }
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`);
  return readResponse(response, path);
}

async function postJson(path, body, headers = {}) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return readResponse(response, path);
}

async function readResponse(response, path) {
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = body?.error;
    throw new Error(
      error === undefined
        ? `${path} responded ${response.status}`
        : `${path} responded ${response.status}: ${error.code} — ${error.message}`,
    );
  }
  return body;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
