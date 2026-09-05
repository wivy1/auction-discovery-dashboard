import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../db/bootstrap";
import { findSourceAdapter } from "../sources";
import { syncConfiguredSourceManifests } from "./source-manifests";
import { sourceCanBeEnabled } from "./source-policy";

export class SourceToggleError extends Error {
  constructor(
    message: string,
    readonly code: "source_not_found" | "source_not_available",
  ) {
    super(message);
    this.name = "SourceToggleError";
  }
}

/** Persists the operator source switch used by subsequent discovery runs. */
export async function setAuctionSourceEnabled(
  sourceId: string,
  enabled: boolean,
): Promise<{ sourceId: string; enabled: boolean }> {
  const adapter = findSourceAdapter(sourceId);
  if (!adapter) {
    throw new SourceToggleError("Auction source was not found", "source_not_found");
  }

  await ensureDatabase();
  await syncConfiguredSourceManifests();
  const row = await env.DB.prepare(`
    SELECT permission_status
    FROM auction_sources
    WHERE id = ?
    LIMIT 1
  `).bind(sourceId).first<{ permission_status: string }>();
  if (!row) {
    throw new SourceToggleError(
      "Auction source has not been initialized yet",
      "source_not_found",
    );
  }
  if (
    enabled &&
    !sourceCanBeEnabled(
      adapter.manifest.implementationStatus,
      row.permission_status,
    )
  ) {
    throw new SourceToggleError(
      "This source cannot be enabled until its implementation and access review are complete",
      "source_not_available",
    );
  }

  await env.DB.prepare(`
    UPDATE auction_sources
    SET enabled = ?, updated_at = ?
    WHERE id = ?
  `).bind(enabled ? 1 : 0, new Date().toISOString(), sourceId).run();
  return { sourceId, enabled };
}
