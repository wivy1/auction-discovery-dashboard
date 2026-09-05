import { env } from "cloudflare:workers";
import {
  profileSignalFeedbackIdsMismatch,
  type ProfileSignalAction,
  type ProfileSignalPolarity,
} from "../operator-feedback";

export interface ProfileSignalFeedbackSnapshot {
  id: string;
  profileId: string;
  concept: string;
  normalizedConcept: string;
  polarity: ProfileSignalPolarity;
  action: ProfileSignalAction;
  sourceProfileVersionId: string;
  createdAt: string;
}

/** Reads only the current append-only correction state; it has no AI dependency. */
export async function readLatestProfileSignalFeedback(
  profileId = "default",
): Promise<ProfileSignalFeedbackSnapshot[]> {
  const result = await env.DB.prepare(`
    WITH ranked AS (
      SELECT
        feedback.*,
        ROW_NUMBER() OVER (
          PARTITION BY profile_id, polarity, normalized_concept
          ORDER BY created_at DESC, id DESC
        ) AS ordinal
      FROM profile_signal_feedback feedback
      WHERE profile_id = ?
    )
    SELECT * FROM ranked
    WHERE ordinal = 1
    ORDER BY polarity, normalized_concept, id
  `).bind(profileId).all<{
    id: string;
    profile_id: string;
    concept: string;
    normalized_concept: string;
    polarity: ProfileSignalPolarity;
    action: ProfileSignalAction;
    source_profile_version_id: string;
    created_at: string;
  }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    profileId: row.profile_id,
    concept: row.concept,
    normalizedConcept: row.normalized_concept,
    polarity: row.polarity,
    action: row.action,
    sourceProfileVersionId: row.source_profile_version_id,
    createdAt: row.created_at,
  }));
}

/**
 * Checks only append-only feedback identities against the newest profile
 * snapshot. Intermediate enrichment batches use this inexpensive read before
 * deciding whether the full artifact/rating freshness audit is necessary.
 */
export async function profileSignalFeedbackNeedsReconciliation(
  profileId = "default",
): Promise<boolean> {
  const [currentFeedback, latestProfile] = await Promise.all([
    readLatestProfileSignalFeedback(profileId),
    env.DB.prepare(`
      SELECT id
      FROM profile_versions
      WHERE profile_id = ?
      ORDER BY created_at DESC, version DESC
      LIMIT 1
    `).bind(profileId).first<{ id: string }>(),
  ]);
  if (!latestProfile) return currentFeedback.length > 0;

  const snapshotFeedback = await env.DB.prepare(`
    SELECT feedback_id
    FROM profile_version_signal_feedback
    WHERE profile_version_id = ?
    ORDER BY feedback_id
  `).bind(latestProfile.id).all<{ feedback_id: string }>();
  return profileSignalFeedbackIdsMismatch(
    currentFeedback.map((entry) => entry.id),
    (snapshotFeedback.results ?? []).map((entry) => entry.feedback_id),
  );
}
