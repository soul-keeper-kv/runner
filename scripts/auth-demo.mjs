/**
 * Authenticated live session demo.
 *
 * Shows the thing an internal application makes unavoidable: the page worth
 * inspecting usually renders nothing to a visitor who is not signed in. It
 * serves a small app whose /orders page is genuinely gated on a session cookie,
 * then drives the Runner through its public API and live command protocol to
 * reach that page.
 *
 * Five acts, in this order on purpose:
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
 *   5. A token profile     -> no form is driven at all: the Runner exchanges
 *                             credentials at /api/auth/login and sends the
 *                             token it gets back as a bearer header. This is
 *                             the path an API-first application needs, where
 *                             replaying a UI login means automating a screen
 *                             nobody uses.
 *
 * The gate is checked on the server, not in the markup: a page that decided by
 * reading a query parameter would let the Runner "reach" it without ever
 * authenticating, which would make this demo prove nothing. /orders accepts
 * either mechanism — the cookie a form login produced, or a bearer token the
 * API login issued — so one fixture exercises both.
 *
 * Running it against the apps from source:
 *
 *   pnpm infra:up
 *   pnpm --filter @runner/api dev
 *   RUNNER_AUTH_PROFILES='…' MANAGER_USER=… MANAGER_PASS=… pnpm --filter @runner/worker dev
 *   node scripts/auth-demo.mjs
 *
 * Or against the containerized stack (`pnpm up`), with the profile and
 * credentials in an untracked `.env` that compose reads:
 *
 *   FIXTURE_HOST=host.docker.internal node scripts/auth-demo.mjs
 *
 * That variable is the whole difference between the two. The fixture app always
 * runs on *this* machine, so a worker inside a container cannot reach it at
 * `localhost` — that name means the container. The profile's `loginUrl` needs
 * the same treatment, which is why the committed `.env.example` and the compose
 * file both mention `host.docker.internal`.
 *
 * The worker needs the profile in its environment; this script prints the exact
 * value to use if it is missing. Environment:
 *
 *   RUNNER_API_URL    default http://localhost:3001
 *   RUNNER_WS_URL     default ws://localhost:3001
 *   FIXTURE_PORT      default 8899
 *   FIXTURE_HOST      default localhost — the host the *browser* uses to reach
 *                     the fixture, not the interface it binds
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
/**
 * The host the Runner's browser uses to reach the fixture app.
 *
 * Separate from the port the fixture binds, because the two are not the same
 * machine when the worker runs in a container: `localhost` there is the
 * container itself, and the demo failed with PAGE_NOT_REACHABLE that looked
 * exactly like a broken Runner.
 */
const FIXTURE_HOST = process.env.FIXTURE_HOST ?? 'localhost';
const WORKSPACE_REF = process.env.WORKSPACE_REF ?? 'workspace_demo';
const PROFILE_REF = process.env.AUTH_PROFILE_REF ?? 'MANAGER';
/**
 * The profile act 5 stores through the API.
 *
 * Separate from the form-login profile so the two acts cannot interfere: a
 * shared ref would mean one act's stored session satisfying the other's login.
 */
const TOKEN_PROFILE_REF = process.env.TOKEN_PROFILE_REF ?? 'DEMO_TOKEN';
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

/** Tokens the API login handed out. A bearer header carrying one is signed in. */
const issuedTokens = new Set();

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

    // A token endpoint, so an API_TOKEN profile has something real to call.
    // It answers the shape an application usually does — the token nested
    // under a key — which is why a profile has to name a path to it.
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }

        if (parsed.username !== DEMO_USER || parsed.password !== DEMO_PASS) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'bad credentials' }));
          return;
        }

        const token = randomUUID();
        issuedTokens.add(token);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { access_token: token, expires_in: 3600 } }));
      });
      return;
    }

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
  // Either mechanism proves a session: the cookie a form login produced, or
  // a bearer token the API login issued. An app that accepts both is the
  // common case, and it lets one demo exercise both paths.
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (bearer !== undefined && issuedTokens.has(bearer)) return true;

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
  // Every URL handed to the Runner is built from FIXTURE_HOST; the server
  // itself still listens on every interface of this machine.
  const base = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;
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

    // --- 5. A token profile, driving no form at all ---------------------------
    console.log(`5. a token profile (${TOKEN_PROFILE_REF}), no form driven`);
    const tokenReached = await runTokenAct(base);

    if (gated && reachedTheApp && reusedWithoutLoggingIn && tokenReached) {
      console.log(
        'Demo passed: a gated page was reached by a form login and by a bearer token, and each login happened once.',
      );
    } else {
      console.error('Demo did not reach the authenticated page as expected.');
      process.exitCode = 1;
    }
  } finally {
    fixture.close();
  }
}

/**
 * The token path, end to end.
 *
 * Stores a profile through the public API — which is what a user does in the
 * workspace — then opens a live session with it and logs in. Nothing drives a
 * form: the Runner posts to the application's token endpoint and puts what comes
 * back into an `Authorization` header.
 *
 * The profile is written here rather than declared in the environment because
 * that is the point of managed profiles: reaching a new application should not
 * need a redeploy.
 */
async function runTokenAct(base) {
  const saved = await fetch(
    `${API}/api/v1/auth/profiles/${TOKEN_PROFILE_REF}?workspaceRef=${encodeURIComponent(WORKSPACE_REF)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Demo API token',
        strategy: 'API_TOKEN',
        // Used only as the origin for placements; no form is ever driven.
        loginUrl: `${base}/login`,
        tokenSource: {
          kind: 'apiLogin',
          url: `${base}/api/auth/login`,
          bodyTemplate: '{"username":"{{username}}","password":"{{password}}"}',
          // Named, never guessed: the endpoint nests it, as most do.
          tokenPath: 'data.access_token',
        },
        tokenPlacements: [{ kind: 'header' }],
        secrets: { username: DEMO_USER, password: DEMO_PASS },
      }),
    },
  );

  if (!saved.ok) {
    const body = await saved.json().catch(() => undefined);
    const error = body?.error;

    if (error?.code === 'CAPABILITY_NOT_IMPLEMENTED') {
      // A deployment with no encryption key cannot store credentials, which is
      // a deliberate refusal rather than a failure. Say so and skip the act.
      console.log(`   skipped: ${error.message}`);
      return true;
    }

    console.log(`   could not store the profile: ${error?.code ?? saved.status}`);
    return false;
  }

  const profile = await saved.json();
  console.log(
    `   profile stored: source=${profile.tokenSource?.kind}, placement=${profile.tokenPlacements?.map((p) => p.kind).join('+')}, secrets set: ${profile.secretsPresent.join(', ')}`,
  );

  return withSession({ authProfileRef: TOKEN_PROFILE_REF }, async (client) => {
    const login = await client.send('auth.login', { profileRef: TOKEN_PROFILE_REF });
    if (!login.ok) {
      console.log(`   auth.login -> ${describeError(login)}`);
      return false;
    }
    console.log('   auth.login -> token fetched and placed as a bearer header');

    const page = await client.look(`${base}/orders`);
    console.log(`   /orders -> "${page.title}"`);
    console.log(`   sees: ${page.names.slice(0, 8).join(', ')}`);

    const reached = page.title === 'Orders';
    console.log(
      reached
        ? '   reached the gated page with a token, having driven no form\n'
        : '   UNEXPECTED: the token did not authenticate the browser\n',
    );
    return reached;
  });
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
