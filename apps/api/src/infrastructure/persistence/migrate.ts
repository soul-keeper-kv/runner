/**
 * Applies the SQL migrations in `infra/migrations` in filename order.
 *
 * `pnpm db:migrate` has pointed here since Phase 0 while the file did not exist —
 * the script was a promise the repository could not keep. Docker applies these
 * same files on a *first* boot via `docker-entrypoint-initdb.d`, which is why the
 * gap went unnoticed: it only matters for an existing database, which is exactly
 * the case a deployment has.
 *
 * Applied migrations are recorded in `schema_migrations`, so running this twice
 * is safe and adding a file later applies only that file.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_TABLE = 'schema_migrations';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error('DATABASE_URL is required. See .env.example.');
    process.exit(1);
  }

  const directory = await findMigrationsDirectory();
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  if (files.length === 0) {
    console.error(`No .sql files found in ${directory}.`);
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql(MIGRATIONS_TABLE)} (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const applied = await sql<{ filename: string }[]>`
      SELECT filename FROM ${sql(MIGRATIONS_TABLE)}
    `;
    const done = new Set(applied.map((row) => row.filename));

    /*
     * Adopt a schema Docker already created.
     *
     * `infra/migrations` is mounted into `docker-entrypoint-initdb.d`, so a fresh
     * container applies these files on first boot without recording them here.
     * Re-executing 0001 against that database fails with 42P07 (relation already
     * exists). If the schema is present but nothing is recorded, the right answer
     * is to adopt it as the baseline rather than to fail or to force it.
     */
    if (done.size === 0) {
      const existing = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'elements'
      `;

      if (existing.length > 0) {
        const baseline = files[0];
        if (baseline !== undefined) {
          await sql`INSERT INTO ${sql(MIGRATIONS_TABLE)} (filename) VALUES (${baseline})`;
          done.add(baseline);
          console.warn(`· ${baseline} (adopted: schema was already present)`);
        }
      }
    }

    let count = 0;
    for (const filename of files) {
      if (done.has(filename)) {
        console.warn(`· ${filename} (already applied)`);
        continue;
      }

      const statements = await readFile(join(directory, filename), 'utf8');

      // Each migration runs in its own transaction: a failure leaves the
      // database at the last complete migration rather than half-way through one.
      await sql.begin(async (tx) => {
        await tx.unsafe(statements);
        await tx`INSERT INTO ${tx(MIGRATIONS_TABLE)} (filename) VALUES (${filename})`;
      });

      console.warn(`✓ ${filename}`);
      count += 1;
    }

    console.warn(
      count === 0
        ? 'Schema is already up to date.'
        : `Applied ${count} migration${count === 1 ? '' : 's'}.`,
    );
  } finally {
    await sql.end();
  }
}

/** Walks up from this module to find `infra/migrations`. */
async function findMigrationsDirectory(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, 'infra', 'migrations');
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error('Could not locate infra/migrations.');
}

await main();
