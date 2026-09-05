type Row = Record<string, unknown>;

export interface DashboardLotFeedback {
  readonly id: string;
  readonly listingId: string;
  readonly decision: "lot" | "not_lot" | "automatic";
  readonly source: "operator_dashboard" | "migration";
  readonly createdAt: string;
}

/** Reads the latest immutable operator correction for each listing. */
export async function readDashboardLotFeedback(
  database: D1Database,
  listingIds: readonly string[],
): Promise<ReadonlyMap<string, DashboardLotFeedback>> {
  const uniqueListingIds = [...new Set(listingIds.filter(Boolean))];
  if (uniqueListingIds.length === 0) return new Map();

  const result = await database.prepare(`
    WITH requested_primary AS (
      SELECT CAST(value AS TEXT) AS listing_id
      FROM json_each(?)
    ), feedback_candidates AS (
      SELECT
        requested.listing_id AS dashboard_listing_id,
        feedback.id,
        feedback.listing_id,
        feedback.decision,
        feedback.source,
        feedback.created_at
      FROM requested_primary requested
      JOIN listing_lot_feedback feedback
        ON feedback.listing_id = requested.listing_id

    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY dashboard_listing_id
        ORDER BY created_at DESC, id DESC
      ) AS feedback_ordinal
      FROM feedback_candidates
    )
    SELECT
      dashboard_listing_id,
      id,
      listing_id,
      decision,
      source,
      created_at
    FROM ranked
    WHERE feedback_ordinal = 1
    ORDER BY dashboard_listing_id
  `).bind(JSON.stringify(uniqueListingIds)).all<Row>();

  const feedback = new Map<string, DashboardLotFeedback>();
  for (const row of result.results ?? []) {
    if (
      typeof row.dashboard_listing_id !== "string" ||
      typeof row.id !== "string" ||
      typeof row.listing_id !== "string" ||
      (row.decision !== "lot" && row.decision !== "not_lot" && row.decision !== "automatic") ||
      (row.source !== "operator_dashboard" && row.source !== "migration") ||
      typeof row.created_at !== "string"
    ) continue;
    feedback.set(row.dashboard_listing_id, {
      id: row.id,
      listingId: row.listing_id,
      decision: row.decision,
      source: row.source,
      createdAt: row.created_at,
    });
  }
  return feedback;
}
