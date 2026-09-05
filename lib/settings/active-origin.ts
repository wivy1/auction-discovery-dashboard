import { ensureDatabase } from "../../db/bootstrap";
import { getConfig } from "../config";
import {
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "../pipeline/mutation-invalidation";

const ACTIVE_ORIGIN_MUTATION_DERIVATION_VERSION =
  "active-origin-mutation-v1" as const;

export interface ActiveOrigin {
  postalCode: string;
  countryCode: "US";
  updatedAt: string;
}

export interface ActiveOriginInput {
  postalCode: string;
  countryCode?: string | null;
}

interface ActiveOriginRow {
  origin_postal_code: string;
  origin_country: string;
  updated_at: string;
}

/** Trims a US ZIP while requiring exactly five ASCII digits. */
export function normalizeUsPostalCode(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("origin postal code must be a string");
  }
  const normalized = value.trim();
  if (!/^\d{5}$/.test(normalized)) {
    throw new RangeError("origin postal code must contain exactly five digits");
  }
  return normalized;
}

/** Normalizes the only country supported by the local proximity workflow. */
export function normalizeUsCountryCode(value: string | null | undefined = "US"): "US" {
  if (typeof value !== "string") {
    throw new TypeError("origin country must be a string");
  }
  if (value.trim().toUpperCase() !== "US") {
    throw new RangeError("origin country must be US");
  }
  return "US";
}

/** Reads the active origin, atomically seeding it from configured defaults. */
export async function readActiveOrigin(binding?: D1Database): Promise<ActiveOrigin> {
  const database = await resolveDatabase(binding);
  await ensureDatabase(database);

  const current = await selectActiveOrigin(database);
  if (current) return mapRow(current);

  const config = getConfig();
  const postalCode = normalizeUsPostalCode(config.originPostalCode);
  const countryCode = normalizeUsCountryCode(config.originCountry);
  const now = new Date();
  const updatedAt = now.toISOString();
  const canonical = database.prepare(`
    INSERT INTO app_settings (
      singleton, origin_postal_code, origin_country, updated_at
    ) VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO NOTHING
  `).bind(postalCode, countryCode, updatedAt);
  const invalidation = await prepareActiveOriginInvalidation({
    database,
    postalCode,
    countryCode,
    now,
  });
  if (invalidation.length === 0) await canonical.run();
  else {
    const results = await database.batch([canonical, ...invalidation]);
    // The bootstrap unit-test binding records batches without executing them.
    // Real D1/SQLite bindings return one result per statement.
    if (results.length === 0) await canonical.run();
  }

  const seeded = await selectActiveOrigin(database);
  if (!seeded) throw new Error("Active origin could not be initialized");
  return mapRow(seeded);
}

/**
 * Reads an already-initialized origin without bootstrapping or seeding. This
 * is the read-only fast path for mutation-driven workers after their indexed
 * queue preflight proves there is no work.
 */
export async function readInitializedActiveOrigin(
  binding?: D1Database,
): Promise<ActiveOrigin> {
  const database = await resolveDatabase(binding);
  const current = await selectActiveOrigin(database);
  if (!current) throw new Error("Active origin has not been initialized");
  return mapRow(current);
}

/** Validates and replaces the active origin for subsequent server work. */
export async function setActiveOrigin(
  input: ActiveOriginInput,
  binding?: D1Database,
): Promise<ActiveOrigin> {
  const postalCode = normalizeUsPostalCode(input.postalCode);
  const countryCode = normalizeUsCountryCode(input.countryCode);
  const database = await resolveDatabase(binding);
  await ensureDatabase(database);
  const current = await selectActiveOrigin(database);
  if (
    current?.origin_postal_code === postalCode &&
    current.origin_country === countryCode
  ) {
    return mapRow(current);
  }
  const now = new Date();
  const updatedAt = now.toISOString();

  const canonical = database.prepare(`
    INSERT INTO app_settings (
      singleton, origin_postal_code, origin_country, updated_at
    ) VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      origin_postal_code = excluded.origin_postal_code,
      origin_country = excluded.origin_country,
      updated_at = excluded.updated_at
  `).bind(postalCode, countryCode, updatedAt);
  const invalidation = await prepareActiveOriginInvalidation({
    database,
    postalCode,
    countryCode,
    now,
  });
  if (invalidation.length === 0) await canonical.run();
  else {
    const results = await database.batch([canonical, ...invalidation]);
    if (results.length === 0) await canonical.run();
  }

  return { postalCode, countryCode, updatedAt };
}

async function prepareActiveOriginInvalidation(input: {
  database: D1Database;
  postalCode: string;
  countryCode: "US";
  now: Date;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: input.database,
    generations: [{
      domain: "active_origin",
      scopeType: "global",
      scopeId: "active",
      input: {
        postalCode: input.postalCode,
        countryCode: input.countryCode,
      },
      derivationVersion: ACTIVE_ORIGIN_MUTATION_DERIVATION_VERSION,
    }],
    refresh: {
      target: { type: "global", scopeId: "active-origin" },
      reasonCode: "active_origin_changed",
      priority: 1_000,
    },
    now: input.now,
  });
}

async function resolveDatabase(binding?: D1Database): Promise<D1Database> {
  if (binding) return binding;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable");
  }
  return env.DB;
}

async function selectActiveOrigin(database: D1Database): Promise<ActiveOriginRow | null> {
  return database.prepare(`
    SELECT origin_postal_code, origin_country, updated_at
    FROM app_settings
    WHERE singleton = 1
    LIMIT 1
  `).first<ActiveOriginRow>();
}

function mapRow(row: ActiveOriginRow): ActiveOrigin {
  return {
    postalCode: normalizeUsPostalCode(row.origin_postal_code),
    countryCode: normalizeUsCountryCode(row.origin_country),
    updatedAt: row.updated_at,
  };
}
