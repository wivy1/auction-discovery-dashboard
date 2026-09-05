import { env } from "cloudflare:workers";
import {
  appendOnlyTimestampAfter,
  normalizeProfileSignalConcept,
  type LotFeedbackDecision,
  type ProfileSignalAction,
  type ProfileSignalPolarity,
} from "../operator-feedback";
import { readLatestProfileSignalFeedback } from "./profile-feedback";

export interface LotFeedbackEvent {
  id: string;
  listingId: string;
  decision: LotFeedbackDecision;
  source: "operator_dashboard";
  createdAt: string;
}

export interface ProfileSignalCorrectionResult {
  outcome: "queued";
  feedbackId: string;
  concept: string;
  normalizedConcept: string;
  polarity: ProfileSignalPolarity;
  action: ProfileSignalAction;
  sourceProfileVersionId: string;
  createdAt: string;
  reconciliationPending: true;
  warning: string;
}

export class OperatorFeedbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "OperatorFeedbackError";
  }
}

export async function appendListingLotFeedback(
  listingId: string,
  decision: LotFeedbackDecision,
): Promise<LotFeedbackEvent | null> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const row = await env.DB.prepare(`
    INSERT INTO listing_lot_feedback (
      id, listing_id, decision, source, created_at
    )
    SELECT ?, id, ?, 'operator_dashboard', ?
    FROM listing_stubs s
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = s.id
    WHERE s.id = ?
    RETURNING id, listing_id, decision, source, created_at
  `).bind(id, decision, createdAt, listingId).first<{
    id: string;
    listing_id: string;
    decision: LotFeedbackDecision;
    source: "operator_dashboard";
    created_at: string;
  }>();
  return row
    ? {
        id: row.id,
        listingId: row.listing_id,
        decision: row.decision,
        source: row.source,
        createdAt: row.created_at,
      }
    : null;
}

/**
 * Persists one append-only signal correction without rebuilding the profile.
 * Profile/scores are reconciled later by the explicit enrichment endpoint,
 * including the nightly wrapper's separate enrichment stage. Keeping this
 * click path DB-only avoids model startup and synchronous corpus reranking.
 */
export async function appendProfileSignalCorrection(input: {
  concept: string;
  polarity: ProfileSignalPolarity;
  action: ProfileSignalAction;
  sourceProfileVersionId: string;
}): Promise<ProfileSignalCorrectionResult> {
  const normalizedConcept = normalizeProfileSignalConcept(input.concept);
  const sourceVersion = await env.DB.prepare(`
    SELECT
      id, profile_id, interested_concepts_json, not_interested_concepts_json
    FROM profile_versions
    WHERE id = ?
    LIMIT 1
  `).bind(input.sourceProfileVersionId).first<{
    id: string;
    profile_id: string;
    interested_concepts_json: string;
    not_interested_concepts_json: string;
  }>();
  if (!sourceVersion) {
    throw new OperatorFeedbackError(
      "Profile version not found",
      404,
      "profile_version_not_found",
    );
  }

  const latestFeedback = await readLatestProfileSignalFeedback(sourceVersion.profile_id);
  const current = latestFeedback.find((entry) =>
    entry.polarity === input.polarity &&
    entry.normalizedConcept === normalizedConcept
  );
  let concept = input.concept.trim().replace(/\s+/gu, " ");

  if (input.action === "removed") {
    if (current?.action === "removed") {
      throw new OperatorFeedbackError(
        "This profile signal is already removed",
        409,
        "profile_signal_already_removed",
      );
    }
    const concepts = profileConceptNames(
      input.polarity === "positive"
        ? sourceVersion.interested_concepts_json
        : sourceVersion.not_interested_concepts_json,
    );
    const matched = concepts.find((entry) =>
      normalizeProfileSignalConcept(entry) === normalizedConcept
    );
    if (!matched) {
      throw new OperatorFeedbackError(
        "The selected concept is not present in that profile version",
        409,
        "profile_signal_not_in_version",
      );
    }
    concept = matched;
  } else {
    if (current?.action !== "removed") {
      throw new OperatorFeedbackError(
        "This profile signal is not currently removed",
        409,
        "profile_signal_not_removed",
      );
    }
    concept = current.concept;
  }

  const feedbackId = crypto.randomUUID();
  const createdAt = current
    ? appendOnlyTimestampAfter(current.createdAt)
    : new Date().toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO profile_signal_feedback (
      id, profile_id, concept, normalized_concept, polarity, action,
      source_profile_version_id, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'operator_dashboard', ?)
    RETURNING id
  `).bind(
    feedbackId,
    sourceVersion.profile_id,
    concept,
    normalizedConcept,
    input.polarity,
    input.action,
    sourceVersion.id,
    createdAt,
  ).first<{ id: string }>();
  if (!inserted) {
    throw new OperatorFeedbackError(
      "Profile feedback could not be saved",
      503,
      "profile_signal_feedback_not_saved",
    );
  }

  return {
    outcome: "queued",
    feedbackId,
    concept,
    normalizedConcept,
    polarity: input.polarity,
    action: input.action,
    sourceProfileVersionId: sourceVersion.id,
    createdAt,
    reconciliationPending: true,
    warning:
      "Correction queued; profile rankings will update during the next explicit enrichment or nightly run.",
  };
}

function profileConceptNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as { concept?: unknown; label?: unknown };
      const value = typeof row.concept === "string"
        ? row.concept
        : typeof row.label === "string" ? row.label : "";
      return value.trim() ? [value.trim().replace(/\s+/gu, " ")] : [];
    });
  } catch {
    return [];
  }
}
