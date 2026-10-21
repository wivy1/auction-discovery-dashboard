export const PUBLISHER_LEAD_EVIDENCE_CONFLICT_GUARD_SQL = `CREATE TRIGGER IF NOT EXISTS source_inventory_publications_conflict_guard
    BEFORE INSERT ON source_inventory_publications
    WHEN EXISTS (
      SELECT 1 FROM source_inventory_publications existing
      WHERE existing.source_id = NEW.source_id
        AND existing.inventory_run_id = NEW.inventory_run_id
        AND (
          existing.listing_count <> NEW.listing_count
          OR existing.collection_counts_json <> NEW.collection_counts_json
          OR existing.publisher_lead_evidence_json <> NEW.publisher_lead_evidence_json
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'source inventory publication proof conflicts with immutable evidence');
    END`;

export const SCHEMA_V47_MIGRATION_STATEMENTS = [
  `ALTER TABLE source_inventory_publications ADD COLUMN publisher_lead_evidence_json TEXT NOT NULL DEFAULT '[]'
    CONSTRAINT source_inventory_publications_publisher_lead_evidence_check CHECK (
      json_valid(publisher_lead_evidence_json) AND json_type(publisher_lead_evidence_json) = 'array'
      AND json_array_length(publisher_lead_evidence_json) <= 20
    )`,
  `DROP TRIGGER IF EXISTS source_inventory_publications_conflict_guard`,
  PUBLISHER_LEAD_EVIDENCE_CONFLICT_GUARD_SQL,
  `INSERT INTO _auction_discovery_public_schema (singleton, version, applied_at) VALUES (1, 47, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at WHERE _auction_discovery_public_schema.version = 46`,
] as const;
