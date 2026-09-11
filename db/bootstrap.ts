import { SCHEMA_V46_MIGRATION_STATEMENTS } from "./listing-end-state-v46-sql.ts";
import {
  CREATE_SCHEMA_METADATA_SQL,
  DATABASE_SCHEMA_VERSION,
  READ_SCHEMA_VERSION_SQL,
  PUBLIC_SCHEMA_STATEMENTS,
} from "./bootstrap-sql.ts";

export { DATABASE_SCHEMA_VERSION } from "./bootstrap-sql.ts";

export interface DatabaseBootstrapResult {
  readonly version: number;
  readonly initialized: boolean;
}

interface DatabaseBootstrapMemo {
  readonly promise: Promise<DatabaseBootstrapResult>;
  completed: boolean;
}

let databaseBootstrapMemo = new WeakMap<D1Database, DatabaseBootstrapMemo>();

async function resolveDatabase(binding?: D1Database): Promise<D1Database> {
  if (binding) return binding;

  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable; pass a binding to ensureDatabase or configure DB in the Worker environment.",
    );
  }
  return env.DB;
}

/**
 * Creates or upgrades the public schema on a local D1 database. The public schema
 * has its own metadata marker and does not migrate private installation data.
 *
 * D1 executes `batch` statements serially and atomically. All schema objects
 * use IF NOT EXISTS, making concurrent first-run attempts safe, while the
 * version marker is deliberately the final statement in the batch.
 */
export function ensureDatabase(
  binding?: D1Database,
): Promise<DatabaseBootstrapResult> {
  if (binding) return ensureResolvedDatabase(binding);
  return resolveDatabase().then(ensureResolvedDatabase);
}

function ensureResolvedDatabase(
  database: D1Database,
): Promise<DatabaseBootstrapResult> {
  const existing = databaseBootstrapMemo.get(database);
  if (existing) {
    if (!existing.completed) return existing.promise;
    return Promise.resolve({
      version: DATABASE_SCHEMA_VERSION,
      initialized: false,
    });
  }

  const memo = {} as DatabaseBootstrapMemo;
  const promise = bootstrapDatabase(database).then(
    (result) => {
      memo.completed = true;
      return result;
    },
    (error: unknown) => {
      databaseBootstrapMemo.delete(database);
      throw error;
    },
  );
  Object.assign(memo, { promise, completed: false });
  databaseBootstrapMemo.set(database, memo);
  return promise;
}

async function bootstrapDatabase(
  database: D1Database,
): Promise<DatabaseBootstrapResult> {
  let row: { version: number } | null;
  let metadataTableCreated = false;
  try {
    row = await database
      .prepare(READ_SCHEMA_VERSION_SQL)
      .first<{ version: number }>();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/\bno such table:\s*_auction_discovery_public_schema\b/iu.test(error.message)
    ) {
      throw error;
    }

    // The metadata table is intentionally outside the main batch because its
    // version must be readable before a brand-new database can be migrated.
    await database.prepare(CREATE_SCHEMA_METADATA_SQL).run();
    metadataTableCreated = true;
    row = await database
      .prepare(READ_SCHEMA_VERSION_SQL)
      .first<{ version: number }>();
  }
  if (row === null && !metadataTableCreated) {
    // Preserve the prior empty-metadata-table initialization path as well as
    // the missing-table fallback above.
    await database.prepare(CREATE_SCHEMA_METADATA_SQL).run();
  }
  const currentVersion = row?.version ?? 0;

  if (currentVersion === DATABASE_SCHEMA_VERSION) {
    return { version: DATABASE_SCHEMA_VERSION, initialized: false };
  }

  if (
    !Number.isInteger(currentVersion) ||
    (currentVersion !== 0 && currentVersion !== 45)
  ) {
    throw new Error(
      `Unsupported auction-discovery database schema version ${currentVersion}; this build supports version ${DATABASE_SCHEMA_VERSION}.`,
    );
  }

  const migrationSql = currentVersion === 45
    ? SCHEMA_V46_MIGRATION_STATEMENTS
    : PUBLIC_SCHEMA_STATEMENTS;
  const statements = migrationSql.map((sql) => database.prepare(sql));
  await database.batch(statements);

  return { version: DATABASE_SCHEMA_VERSION, initialized: true };
}

/** Test-only reset for process-local bootstrap memoization. */
export function resetDatabaseBootstrapMemoizationForTests(): void {
  databaseBootstrapMemo = new WeakMap<D1Database, DatabaseBootstrapMemo>();
}


