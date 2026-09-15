/**
 * Authenticated live session demo.
 *
 * Shows the thing an internal application makes unavoidable: the page worth
 * inspecting usually renders nothing to a visitor who is not signed in. It
 * serves a small app whose /orders page is genuinely gated on a session cookie,
 * then drives the Runner through its public API and live command protocol to
 * reach that page.
 *
 * Four acts, in this order on purpose:
 *
 *   1. No profile          -> /orders shows the login wall. The failure first,
 *                             so the success afterwards is not a coincidence.
 *   2. Profile, first ever -> nothing stored yet, so `auth.login` performs the
 *                             UI login *into the browser already open* and the
 *                             Runner captures the session it produced.
 *   3. Same browser        -> /orders now renders the orders table.
 *   4. A brand-new session -> opens already authenticated from the stored
 *                             session. No second login, which is the whole
 *                             point of storing it.
 *
 * The gate is checked on the server, not in the markup: a page that decided by
 * reading a query parameter would let the Runner "reach" it without ever
 * authenticating, which would make this demo prove nothing.
 *
 *   pnpm infra:up
 *   pnpm --filter @runner/api dev
 *   RUNNER_AUTH_PROFILES='…' MANAGER_USER=… MANAGER_PASS=… pnpm --filter @runner/worker dev
 *   node scripts/auth-demo.mjs
 *
 * The worker needs the profile in its environment; this script prints the exact
 * value to use if it is missing. Environment:
 *
 *   RUNNER_API_URL    default http://localhost:3001
 *   RUNNER_WS_URL     default ws://localhost:3001
 *   FIXTURE_PORT      default 8899
 *   WORKSPACE_REF     default workspace_demo
 *   AUTH_PROFILE_REF  default MANAGER
 *   DEMO_USER         default manager@example.com
 *   DEMO_PASS         default demo-password
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';


const API = process.env.RUNNER_API_URL ?? 'http://localhost:3001';
const WS = process.env.RUNNER_WS_URL ?? 'ws://localhost:3001';
const FIXTURE_PORT = Number.parseInt(process.env.FIXTURE_PORT ?? '8899', 10);
const WORKSPACE_REF = process.env.WORKSPACE_REF ?? 'workspace_demo';
const PROFILE_REF = process.env.AUTH_PROFILE_REF ?? 'MANAGER';
const DEMO_USER = process.env.DEMO_USER ?? 'manager@example.com';
const DEMO_PASS = process.env.DEMO_PASS ?? 'demo-password';

const COMMAND_TIMEOUT_MS = 30_000;
const SESSION_COOKIE = 'demo_session';

const here = dirname(fileURLToPath(import.meta.url));
const pages = {
  login: readFileSync(join(here, 'fixtures', 'login-app.html'), 'utf8'),
  app: readFileSync(join(here, 'fixtures', 'app.html'), 'utf8'),
  wall: readFileSync(join(here, 'fixtures', 'login-wall.html'), 'utf8'),
};

/** Sessions this demo app considers signed in. Server-side, like a real one. */
const validSessions = new Set();

// ---------------------------------------------------------------------------
// The application under test
// ---------------------------------------------------------------------------

function startFixture() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${FIXTURE_PORT}`);

    const html = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };

    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const form = new URLSearchParams(body);

        if (form.get('email') !== DEMO_USER || form.get('password') !== DEMO_PASS) {
          // A wrong credential must look like a wrong credential, so a failed
          // login in the demo is distinguishable from a broken selector.
          html(pages.login, 303, { location: '/login?error=1' });
          return;
        }

        const sessionId = randomUUID();
        validSessions.add(sessionId);
        html('', 303, {
          location: '/orders',
          'set-cookie': `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly`,
        });
      });
      return;
    }

    if (url.pathname === '/login') {
      html(pages.login);
      return;
    }

    if (url.pathname === '/logout') {
      html('', 303, {
        location: '/login',
        'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
      });
      return;
    }

    if (url.pathname === '/orders') {
      // Two documents behind one URL, chosen by the cookie — the gate this
      // whole demo turns on.
      html(signedIn(req) ? pages.app : pages.wall, signedIn(req) ? 200 : 401);
      return;
    }

    html(pages.wall, 404);
  });

  return new Promise((resolve) => {
    server.listen(FIXTURE_PORT, () => resolve(server));
  });
}

function signedIn(req) {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)demo_session=([^;]+)/.exec(cookie);
  return match !== null && validSessions.has(match[1]);
}

// ---------------------------------------------------------------------------
// Driving the Runner
// ---------------------------------------------------------------------------

/**
 * One live session, with its socket.
 *
 * Commands are correlated by `commandId` rather than by arrival order: a result
 * for something else must never be handed to the caller waiting here.
 */
class LiveSessionClient {
  constructor(session) {
    this.session = session;
    this.pending = new Map();
    this.socket = undefined;
  }

  static async open({ authProfileRef } = {}) {
    const session = await postJson('/api/v1/live-sessions', {
      workspaceRef: WORKSPACE_REF,
      ...(authProfileRef === undefined ? {} : { authProfileRef }),
    });

    const client = new LiveSessionClient(session);
    await client.connect();
    return client;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS}/api/v1/live-sessions/${this.session.id}/ws`);
      this.socket = socket;

      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }

        // An error frame is the gateway refusing the command outright — an
        // unknown type, a schema rejection, a lost session. It carries no
        // commandId, so it cannot be matched to one caller; failing every
        // in-flight command is right, and beats letting them all wait out a
        // timeout over an answer that already arrived.
        if (message.kind === 'error') {
          const waiting = [...this.pending.values()];
          this.pending.clear();
          for (const settle of waiting) {
            settle({ ok: false, error: { code: message.code, message: message.message } });
          }
          return;
        }

        if (message.kind !== 'command-result') return;

        const waiting = this.pending.get(message.result.commandId);
        if (waiting === undefined) return;

        this.pending.delete(message.result.commandId);
        waiting(message.result);
      });

      socket.on('open', () => resolve());
      socket.on('error', (cause) => reject(cause));
    });
  }

  send(type, payload = {}) {
    const id = `cmd_${randomUUID()}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} did not answer within ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      this.socket.send(
        JSON.stringify({ kind: 'command', command: { id, sessionId: this.session.id, type, payload } }),
      );
    });
  }

  /** Navigates, then reads the page back. Returns what the Runner can see. */
  async look(url) {
    const navigated = await this.send('browser.navigate', { url });
    if (!navigated.ok) throw new Error(`navigate failed: ${describeError(navigated)}`);

    const inspected = await this.send('state.inspect', {
      includeScreenshot: false,
      includeCandidates: true,
    });
    if (!inspected.ok) throw new Error(`inspect failed: ${describeError(inspected)}`);

    const snapshot = inspected.result;
    const names = (snapshot.candidates ?? [])
      .map((candidate) => candidate.label ?? candidate.role ?? candidate.tag)
      .filter((name) => typeof name === 'string' && name.length > 0);

    return { url: snapshot.url, title: snapshot.title, names };
  }

  async close() {
    this.socket?.close();
    await fetch(`${API}/api/v1/live-sessions/${this.session.id}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
}

async function main() {
  const fixture = await startFixture();
  const base = `http://localhost:${FIXTURE_PORT}`;
  console.log(`demo app on ${base}  (/login, /orders)`);
  console.log(`  /orders renders the orders table only with a valid ${SESSION_COOKIE} cookie\n`);

  await assertLiveCommandsAvailable();

  try {
    // Each act closes its session before the next opens one. Holding three
    // sockets at once is not what the demo is about, and one live session at a
    // time is also how a workspace actually behaves.

    // --- 1. Without a profile -------------------------------------------------
    console.log('1. live session with no auth profile');
    const wall = await withSession({}, (client) => client.look(`${base}/orders`));

    console.log(`   /orders -> "${wall.title}"`);
    console.log(`   sees: ${wall.names.slice(0, 6).join(', ')}`);
    const gated = wall.title !== 'Orders';
    console.log(
      gated
        ? '   as expected: the page is gated, so the Runner is looking at a login wall\n'
        : '   UNEXPECTED: the page rendered without a session — the gate is not working\n',
    );

    // --- 2 and 3. A profile, logging in, then reaching the page ---------------
    // One session for both, because act 3's whole claim is that the login
    // happened in the browser that is *already* open.
    console.log(`2. live session with authProfileRef=${PROFILE_REF}`);
    const loggedIn = await withSession({ authProfileRef: PROFILE_REF }, async (client) => {
      const before = await client.send('auth.status');
      console.log(
        `   auth.status -> ${
          before.ok
            ? before.result.authenticatedAs === undefined
              ? 'not authenticated yet (nothing stored for this profile)'
              : `already authenticated as ${before.result.authenticatedAs}`
            : describeError(before)
        }`,
      );

      const login = await client.send('auth.login', { profileRef: PROFILE_REF });
      if (!login.ok) return { login };

      console.log(
        `   auth.login -> authenticated as ${login.result.authenticatedAs}` +
          (login.result.expiresAt === undefined
            ? ''
            : `, session stored until ${login.result.expiresAt}`),
      );

      console.log('3. same browser, no restart');
      const orders = await client.look(`${base}/orders`);
      return { login, orders };
    });

    if (!loggedIn.login.ok) {
      console.log(`   auth.login -> ${describeError(loggedIn.login)}`);
      explainLoginFailure(loggedIn.login, base);
      process.exitCode = 1;
      return;
    }

    const { orders } = loggedIn;
    console.log(`   /orders -> "${orders.title}"`);
    console.log(`   sees: ${orders.names.slice(0, 8).join(', ')}`);

    const reachedTheApp = orders.title === 'Orders';
    console.log(
      reachedTheApp
        ? '   the page only a signed-in user can see\n'
        : '   UNEXPECTED: still not signed in\n',
    );

    // --- 4. A new session reuses the stored one -------------------------------
    console.log('4. a brand-new live session with the same profile');
    const reused = await withSession({ authProfileRef: PROFILE_REF }, async (client) => {
      const status = await client.send('auth.status');
      const page = await client.look(`${base}/orders`);
      return { status, page };
    });

    console.log(
      `   auth.status -> ${
        reused.status.ok && reused.status.result.authenticatedAs !== undefined
          ? `authenticated as ${reused.status.result.authenticatedAs} from the stored session`
          : 'not authenticated'
      }`,
    );
    console.log(`   /orders -> "${reused.page.title}"  (no second login)\n`);

    const reusedWithoutLoggingIn = reused.page.title === 'Orders';

    if (gated && reachedTheApp && reusedWithoutLoggingIn) {
      console.log('Demo passed: a gated page was reached, and the login happened once.');
    } else {
      console.error('Demo did not reach the authenticated page as expected.');
      process.exitCode = 1;
    }
  } finally {
    fixture.close();
  }
}

/** Opens a live session, runs one act against it, and always closes it. */
async function withSession(options, act) {
  const client = await LiveSessionClient.open(options);
  try {
    return await act(client);
  } finally {
    await client.close();
  }
}

/**
 * Fails early when live dispatch is not available.
 *
 * Without this the first command times out after 30 seconds against a worker
 * that was never running, which reads like a Runner bug rather than a missing
 * process.
 */
async function assertLiveCommandsAvailable() {
  const capabilities = await getJson('/api/v1/capabilities');
  const live = capabilities.features.find((feature) => feature.name === 'live.sessions');

  if (live?.status !== 'AVAILABLE') {
    throw new Error(
      `The API reports live.sessions as ${live?.status ?? 'missing'}. Start it with REDIS_URL set and run the worker.`,
    );
  }

  if (!capabilities.liveCommands.includes('auth.login')) {
    throw new Error(
      'This API build does not publish auth.login. Rebuild it after adding the auth live commands.',
    );
  }
}

/** Turns the most common misconfiguration into an actionable message. */
function explainLoginFailure(result, base) {
  const message = result.error?.message ?? '';

  if (message.includes('RUNNER_AUTH_PROFILES') || message.includes('No auth profile')) {
    console.log('\n   The worker has no profile for this demo. Start it with:\n');
    console.log(
      `   RUNNER_AUTH_PROFILES='${JSON.stringify([
        {
          ref: PROFILE_REF,
          workspaceRef: WORKSPACE_REF,
          displayName: 'Store manager',
          strategy: 'FORM_LOGIN',
          loginUrl: `${base}/login`,
          formFields: { username: 'Email', password: 'Password', submit: 'Sign in' },
          secretRefs: { username: 'MANAGER_USER', password: 'MANAGER_PASS' },
        },
      ])}' \\`,
    );
    console.log(`   MANAGER_USER='${DEMO_USER}' MANAGER_PASS='${DEMO_PASS}' \\`);
    console.log('   pnpm --filter @runner/worker dev\n');
    return;
  }

  if (message.includes('Missing credential')) {
    console.log(
      `\n   The profile is loaded but its credentials are not: set MANAGER_USER='${DEMO_USER}' and MANAGER_PASS='${DEMO_PASS}' in the worker's environment.\n`,
    );
  }
}

function describeError(result) {
  const error = result.error;
  return error === undefined ? 'unknown error' : `${error.code} (${error.kind ?? '—'}): ${error.message}`;
}

async function getJson(path) {
  return readResponse(await fetch(`${API}${path}`), path);
}

async function postJson(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
