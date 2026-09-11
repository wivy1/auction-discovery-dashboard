export const LISTING_END_OVERRIDES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS listing_end_overrides (
  listing_id TEXT PRIMARY KEY NOT NULL REFERENCES listing_stubs(id) ON DELETE CASCADE,
  marked_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'operator_dashboard',
  CONSTRAINT listing_end_overrides_timestamp_check
    CHECK (marked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(marked_at) IS NOT NULL),
  CONSTRAINT listing_end_overrides_source_check CHECK (source = 'operator_dashboard')
)`;

export const SCHEMA_V46_MIGRATION_STATEMENTS = [
  LISTING_END_OVERRIDES_TABLE_SQL,
  `INSERT INTO _auction_discovery_public_schema (singleton, version, applied_at) VALUES (1, 46, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at WHERE _auction_discovery_public_schema.version = 45`,
] as const;
