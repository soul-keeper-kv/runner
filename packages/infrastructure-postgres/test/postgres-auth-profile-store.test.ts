import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox, fixedClock, noopLogger } from '@runner/shared';
import { createPostgresClient } from '../src/postgres-client.js';
import { PostgresAuthProfileStore } from '../src/postgres-auth-profile-store.js';

/**
 * Integration tests against a real Postgres.
 *
 * What they protect, in order of how expensive the mistake would be:
 *
 *  1. **A stored credential is never readable from the database.** The whole
 *     relaxation of blueprint section 50 rests on this one property.
 *  2. **A save never silently clears a credential.** Editing a login URL must
 *     not log a whole suite out, so an omitted secret is left alone and only an
 *     empty string removes one.
 *  3. **No read path returns a credential.** Only `resolveForExecution`
 *     decrypts, and that is the single call site an audit has to check.
 *
 * They skip themselves without `DATABASE_URL` reachable, so `pnpm test` stays
 * green on a machine with no database, and run after `pnpm infra:up`.
 */

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://runner:runner@localhost:5433/runner';
const WORKSPACE = `w_authtest_${Date.now()}`;
const PASSWORD = 'sup3r-s3cret-value';
const KEY = 'a-sufficiently-long-test-key-0123456789';

const sql = createPostgresClient(databaseUrl, { max: 2 });

function storeWith(key = KEY) {
  const box = createSecretBox(key);
  if (!box.ok) throw new Error('test key rejected');
  return new PostgresAuthProfileStore(
    sql,
    box.value,
    fixedClock('2026-03-01T00:00:00.000Z'),
    noopLogger,
  );
}

const store = storeWith();
let available = false;

function formLogin(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    ref,
    workspaceRef: WORKSPACE,
    displayName: 'CARIS admin',
    strategy: 'FORM_LOGIN' as const,
    loginUrl: 'https://app.test/login/',
    formFields: {
      username: 'USERNAME *',
      password: 'PASSWORD *',
      submit: 'Log in',
    },
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM profile_secrets LIMIT 1`;
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available) {
    await sql`DELETE FROM external_workspaces WHERE workspace_ref = ${WORKSPACE}`;
  }
  await sql.end({ timeout: 5 });
});

describe('saving a profile', () => {
  it('stores it and reports which credentials are set, never their values', async () => {
    if (!available) return;

    const saved = await store.save(
      formLogin('P_SET', { secrets: { username: 'admin@test', password: PASSWORD } }),
    );

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.secretsPresent).toEqual(['password', 'username']);
    // The claim the whole feature rests on.
    expect(JSON.stringify(saved.value)).not.toContain(PASSWORD);
  });

  it('writes no plaintext into the database', async () => {
    if (!available) return;
    await store.save(formLogin('P_CIPHER', { secrets: { password: PASSWORD } }));

    const rows = await sql<{ ciphertext: string }[]>`
      SELECT s.ciphertext
      FROM profile_secrets s
      JOIN execution_profiles p ON p.id = s.profile_id
      WHERE p.workspace_ref = ${WORKSPACE} AND p.profile_ref = 'P_CIPHER'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext).not.toContain(PASSWORD);
    expect(Buffer.from(rows[0]!.ciphertext, 'base64').toString('utf8')).not.toContain(PASSWORD);
  });

  it('keeps a credential when a later save omits it', async () => {
    if (!available) return;
    // The regression this prevents: editing a login URL logging a suite out.
    await store.save(formLogin('P_KEEP', { secrets: { password: PASSWORD } }));

    await store.save(formLogin('P_KEEP', { loginUrl: 'https://app.test/signin/' }));

    const resolved = await store.resolveForExecution(WORKSPACE, 'P_KEEP');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.secrets.password).toBe(PASSWORD);
    expect(resolved.value.profile.loginUrl).toBe('https://app.test/signin/');
  });

  it('removes a credential only when explicitly emptied', async () => {
    if (!available) return;
    await store.save(formLogin('P_CLEAR', { secrets: { password: PASSWORD } }));

    await store.save(formLogin('P_CLEAR', { secrets: { password: '' } }));

    const got = await store.get(WORKSPACE, 'P_CLEAR');
    if (!got.ok) return;
    expect(got.value.secretsPresent).toEqual([]);
  });

  it('replaces a profile rather than creating a second one', async () => {
    if (!available) return;
    await store.save(formLogin('P_UPSERT', { displayName: 'First' }));
    await store.save(formLogin('P_UPSERT', { displayName: 'Second' }));

    const listed = await store.list(WORKSPACE);
    if (!listed.ok) return;
    const matching = listed.value.filter((profile) => profile.ref === 'P_UPSERT');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.displayName).toBe('Second');
  });

  it('refuses a FORM_LOGIN profile with no loginUrl', async () => {
    if (!available) return;
    const saved = await store.save(
      formLogin('P_BAD', { loginUrl: undefined }) as never,
    );

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a FORM_LOGIN profile that names no fields', async () => {
    if (!available) return;
    const saved = await store.save(formLogin('P_NOFIELDS', { formFields: {} }));

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('resolving a profile for a login', () => {
  it('returns the decrypted credentials and a usable profile', async () => {
    if (!available) return;
    await store.save(
      formLogin('P_RESOLVE', {
        secrets: { username: 'admin@test', password: PASSWORD, companyCode: 'ACME' },
        formFields: {
          username: 'USERNAME *',
          password: 'PASSWORD *',
          companyCode: 'COMPANY CODE *',
          submit: 'Log in',
        },
      }),
    );

    const resolved = await store.resolveForExecution(WORKSPACE, 'P_RESOLVE');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.value.secrets.password).toBe(PASSWORD);
    expect(resolved.value.secrets.companyCode).toBe('ACME');
    // AuthService looks a field up through secretRefs, so every stored
    // credential must be reachable that way or the login fills nothing.
    expect(resolved.value.profile.secretRefs.password).toBe('password');
    expect(resolved.value.profile.formFields?.companyCode).toBe('COMPANY CODE *');
  });

  it('keeps an external secret reference pointing at the environment', async () => {
    if (!available) return;
    // A vault-backed deployment stores nothing here, and must keep working.
    await store.save(
      formLogin('P_ENV', { secretRefs: { password: 'CARIS_PASS' } }),
    );

    const resolved = await store.resolveForExecution(WORKSPACE, 'P_ENV');
    if (!resolved.ok) return;
    expect(resolved.value.profile.secretRefs.password).toBe('CARIS_PASS');
    expect(resolved.value.secrets.password).toBeUndefined();
  });

  it('fails as a precondition, naming the field, when the key is wrong', async () => {
    if (!available) return;
    await store.save(formLogin('P_WRONGKEY', { secrets: { password: PASSWORD } }));

    const other = storeWith('a-completely-different-key-9876543210');
    const resolved = await other.resolveForExecution(WORKSPACE, 'P_WRONGKEY');

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // Not a test failure: nothing about the application under test is wrong.
    expect(resolved.error.code).toBe('PRECONDITION_FAILED');
    expect(resolved.error.message).toContain('password');
    expect(resolved.error.message).toContain('RUNNER_SECRET_KEY');
    expect(JSON.stringify(resolved.error.toJSON())).not.toContain(PASSWORD);
  });

  it('reports an unknown profile as a precondition failure', async () => {
    if (!available) return;
    const resolved = await store.resolveForExecution(WORKSPACE, 'NOPE');

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('reading and deleting', () => {
  it('scopes a list to one workspace', async () => {
    if (!available) return;
    await store.save(formLogin('P_SCOPE'));

    const other = await store.list(`${WORKSPACE}_other`);
    if (!other.ok) return;
    expect(other.value).toEqual([]);
  });

  it('reports a missing profile as not found', async () => {
    if (!available) return;
    const got = await store.get(WORKSPACE, 'ABSENT');

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });

  it('deletes a profile and its sealed credentials together', async () => {
    if (!available) return;
    await store.save(formLogin('P_DELETE', { secrets: { password: PASSWORD } }));

    expect((await store.delete(WORKSPACE, 'P_DELETE')).ok).toBe(true);

    // A sealed credential with nothing pointing at it would linger forever.
    const orphans = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM profile_secrets s
      LEFT JOIN execution_profiles p ON p.id = s.profile_id
      WHERE p.id IS NULL
    `;
    expect(orphans[0]?.count).toBe('0');
  });

  it('reports deleting a profile that does not exist', async () => {
    if (!available) return;
    const deleted = await store.delete(WORKSPACE, 'NEVER_EXISTED');

    expect(deleted.ok).toBe(false);
    if (deleted.ok) return;
    expect(deleted.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });
});
