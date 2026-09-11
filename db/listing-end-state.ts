import { ensureDatabase } from "./bootstrap.ts";
import { HttpError } from "../lib/http.ts";
import { MAX_BULK_END_LISTINGS, type BulkListingEndResult } from "../lib/listing-end-state.ts";

function exactListingIds(ids: readonly string[], maximum?: number): string[] {
  if (!Array.isArray(ids) || (maximum !== undefined && (ids.length < 1 || ids.length > maximum))) {
    throw new HttpError("listingIds must contain between 1 and 1000 entries", 400, "invalid_bulk_end_payload");
  }
  if (Array.from(ids).some((id) => typeof id !== "string" || id.length < 1 || id.length > 512 ||
    id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id))) {
    throw new HttpError("Every listing ID must be an exact bounded string", 400, "invalid_bulk_end_payload");
  }
  return [...new Set(ids)];
}

export async function readListingEndOverrides(
  database: D1Database,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const exactIds = exactListingIds(ids);
  if (exactIds.length === 0) return new Map();
  await ensureDatabase(database);
  const result = await database.prepare(`
    SELECT listing_id, marked_at FROM listing_end_overrides
    WHERE listing_id IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(exactIds)).all<{ listing_id: string; marked_at: string }>();
  return new Map((result.results ?? []).map((row) => [row.listing_id, row.marked_at]));
}

const TARGETS_SQL = `
  WITH requested AS (
    SELECT DISTINCT CAST(value AS TEXT) AS listing_id FROM json_each(?)
  ),
    targets AS (
    SELECT requested.listing_id, stub.id AS canonical_listing_id
    FROM requested JOIN listing_stubs stub ON stub.id = requested.listing_id
  ),
  eligible AS (
    SELECT requested.listing_id, target.canonical_listing_id,
      CASE WHEN
        TRIM(COALESCE(CASE WHEN observation.listing_id IS NOT NULL
          THEN observation.auction_ends_at ELSE detail.auction_ends_at END, ''), char(9) || char(10) || char(11) || char(12) || char(13) || ' ') = ''

      THEN 1 ELSE 0 END AS time_unavailable,
      override.marked_at
    FROM requested
    LEFT JOIN targets target ON target.listing_id = requested.listing_id
    LEFT JOIN listing_details detail ON detail.listing_id = target.canonical_listing_id
    LEFT JOIN listing_detail_observations observation ON observation.listing_id = target.canonical_listing_id

    LEFT JOIN listing_end_overrides override ON override.listing_id = target.canonical_listing_id
  )
`;

interface TargetRow {
  listing_id: string;
  canonical_listing_id: string | null;
  time_unavailable: number;
  marked_at: string | null;
}

/** Saves operator state without changing source evidence or preference feedback. */
export async function markListingsEnded(
  database: D1Database,
  ids: readonly string[],
): Promise<BulkListingEndResult> {
  const requested = exactListingIds(ids, MAX_BULK_END_LISTINGS);
  await ensureDatabase(database);
  const serialized = JSON.stringify(requested);
  const now = new Date().toISOString();
  // The invalid singleton makes an active lease roll back the whole batch,
  // including a lease that appeared after the request began.
  const guard = database.prepare(`
    INSERT INTO pipeline_run_lease (singleton, run_kind, run_id, acquired_at, expires_at)
    SELECT 0, 'discovery', 'listing-end-mutation-lease-guard',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE EXISTS (SELECT 1 FROM pipeline_run_lease WHERE singleton = 1
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  const read = () => database.prepare(`${TARGETS_SQL} SELECT * FROM eligible`).bind(serialized);
  let results: D1Result<TargetRow>[];
  try {
    results = await database.batch<TargetRow>([
      guard,
      read(),
      database.prepare(`${TARGETS_SQL}
        INSERT INTO listing_end_overrides (listing_id, marked_at, source)
        SELECT DISTINCT canonical_listing_id, ?, 'operator_dashboard'
        FROM eligible WHERE canonical_listing_id IS NOT NULL AND time_unavailable = 1
        ON CONFLICT(listing_id) DO NOTHING
      `).bind(serialized, now),
      read(),
    ]);
  } catch (error) {
    if (/pipeline_run_lease_singleton_check/u.test(error instanceof Error ? error.message : String(error))) {
      throw new HttpError("Discovery is running. Try again when it finishes.", 409, "pipeline_busy");
    }
    throw error;
  }
  const before = new Map((results[1]?.results ?? []).map((row) => [row.listing_id, row]));
  const after = new Map((results[3]?.results ?? []).map((row) => [row.listing_id, row]));
  return {
    requestedCount: requested.length,
    outcomes: requested.map((listingId) => {
      const prior = before.get(listingId);
      const saved = after.get(listingId);
      const canonicalListingId = saved?.canonical_listing_id ?? null;
      const markedEndedAt = saved?.marked_at ?? null;
      return {
        listingId,
        canonicalListingId,
        status: !canonicalListingId ? "skipped_not_found" : prior?.marked_at
          ? "already_ended" : markedEndedAt ? "changed" : "skipped_has_time",
        markedEndedAt,
      };
    }),
  };
}