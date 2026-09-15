import postgres from 'postgres';

/**
 * The Postgres connection, created once per process.
 *
 * Kept in its own module so every adapter in this package shares one pool and
 * the composition root has a single thing to close. Nothing above the
 * infrastructure layer ever sees this type — ports are what the application
 * depends on.
 */

export type PostgresClient = postgres.Sql;

/**
 * A connection *or* a transaction.
 *
 * `sql.begin` hands its callback a `TransactionSql`, which is deliberately
 * narrower than `Sql` — it has no `end()`, because committing is the
 * transaction's job. Helpers that only issue queries accept this so the same
 * code can run inside or outside a transaction.
 */
export type PostgresQueryable = postgres.Sql | postgres.TransactionSql;

export interface PostgresClientOptions {
  /** Maximum pooled connections. The worker runs several jobs concurrently. */
  readonly max?: number;
  /** Seconds a connection may idle before it is released. */
  readonly idleTimeout?: number;
  readonly connectTimeout?: number;
}

export function createPostgresClient(
  databaseUrl: string,
  options: PostgresClientOptions = {},
): PostgresClient {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    // The Runner stores timestamps as ISO strings everywhere above this layer,
    // so dates come back as text rather than JS Date objects. Converting in one
    // place keeps every adapter's row mapping trivial.
    types: {
      date: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (value: string | Date) =>
          value instanceof Date ? value.toISOString() : value,
        parse: (value: string) => new Date(value).toISOString(),
      },
    },
    // Silence the library's own notices; the Runner logs through its own Logger.
    onnotice: () => undefined,
  });
}

/**
 * Verifies the connection and that the schema has been applied.
 *
 * Called at startup so a misconfigured deployment fails immediately with a clear
 * message, rather than surfacing as a confusing error on the first request that
 * happens to need a table.
 */
export async function verifyPostgresSchema(
  client: PostgresClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const rows = await client<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('elements', 'registry_modifications', 'registry_revisions')
    `;

    if (rows.length < 3) {
      return {
        ok: false,
        reason:
          'The Runner schema is missing. Run `pnpm db:migrate`, or start infrastructure with `pnpm infra:up` which applies migrations on first boot.',
      };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : 'Could not reach Postgres.',
    };
  }
}
