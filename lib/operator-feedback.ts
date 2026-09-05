export type LotFeedbackDecision = "lot" | "not_lot" | "automatic";
export type ProfileSignalPolarity = "positive" | "negative";
export type ProfileSignalAction = "removed" | "restored";

export interface ProfileSignalFeedbackState {
  normalizedConcept: string;
  polarity: ProfileSignalPolarity;
  action: ProfileSignalAction;
}

export interface ProfileLearningEvidence {
  vote: "interested" | "not_interested";
  concepts: readonly string[];
}

export class ProfileRebuildNoInputsError extends Error {
  constructor() {
    super("No current voted embeddings are available to rebuild the profile");
    this.name = "ProfileRebuildNoInputsError";
  }
}

export type AppendOnlyProfileCorrectionOutcome<Event, Rebuilt, Compensation> =
  | { outcome: "no_inputs" }
  | { outcome: "applied"; event: Event; rebuilt: Rebuilt }
  | {
      outcome: "reverted";
      event: Event;
      reason: unknown;
      compensation: Compensation;
    }
  | {
      outcome: "pending_rebuild";
      event: Event;
      reason: unknown;
      compensationError: unknown;
    };

export function profileSnapshotNeedsRecovery(input: {
  usableVotes: number;
  snapshotVotes: number;
  voteMismatches: number;
  scoreMismatches: number;
  feedbackMismatch: boolean;
  algorithmMatches: boolean;
}): boolean {
  return input.usableVotes > 0 && (
    input.usableVotes !== input.snapshotVotes ||
    input.voteMismatches > 0 ||
    input.scoreMismatches > 0 ||
    input.feedbackMismatch ||
    !input.algorithmMatches
  );
}

export function profileSignalFeedbackIdsMismatch(
  currentIds: readonly string[],
  snapshotIds: readonly string[],
): boolean {
  const current = [...currentIds].sort();
  const snapshot = [...snapshotIds].sort();
  return current.length !== snapshot.length ||
    current.some((id, index) => id !== snapshot[index]);
}

export function normalizeProfileSignalConcept(value: string): string {
  const normalized = normalizeConceptKey(value);
  if (!normalized || normalized.length > 200) {
    throw new RangeError("profile signal concept must contain 1 to 200 characters");
  }
  return normalized;
}

export function activeRemovedProfileSignalConcepts(
  feedback: readonly ProfileSignalFeedbackState[],
  polarity: ProfileSignalPolarity,
): ReadonlySet<string> {
  return new Set(feedback
    .filter((entry) => entry.polarity === polarity && entry.action === "removed")
    .map((entry) => entry.normalizedConcept));
}

export function maskRemovedProfileConcepts<T extends { concept: string }>(
  concepts: readonly T[],
  feedback: readonly ProfileSignalFeedbackState[],
  polarity: ProfileSignalPolarity,
): T[] {
  const removed = activeRemovedProfileSignalConcepts(feedback, polarity);
  return concepts.filter((entry) => !removed.has(normalizeConceptKey(entry.concept)));
}

export function matchingActiveProfileConcepts(
  candidateConcepts: readonly string[],
  activeConcepts: readonly { concept: string }[],
): string[] {
  const active = new Set(activeConcepts.map((entry) => normalizeConceptKey(entry.concept)));
  return candidateConcepts.filter((concept) => active.has(normalizeConceptKey(concept)));
}

/**
 * Masks the explicit concept metadata used for summaries, direct matches, and
 * explanations while retaining the vote and immutable factual listing vector.
 * The ranking layer separately projects any sufficiently supported removed
 * concept direction out of the matching polarity's derived preference vector;
 * neither step converts the evidence into the opposite class.
 */
export function maskRemovedProfileSignalEvidenceConcepts<
  T extends ProfileLearningEvidence,
>(
  evidence: readonly T[],
  feedback: readonly ProfileSignalFeedbackState[],
): T[] {
  const removedPositive = activeRemovedProfileSignalConcepts(feedback, "positive");
  const removedNegative = activeRemovedProfileSignalConcepts(feedback, "negative");
  return evidence.map((entry) => {
    const removed = entry.vote === "interested" ? removedPositive : removedNegative;
    const concepts = entry.concepts.filter((concept) =>
      !removed.has(normalizeConceptKey(concept))
    );
    return concepts.length === entry.concepts.length
      ? entry
      : { ...entry, concepts };
  });
}

export function effectiveLotType<T extends string>(
  automaticType: T,
  decision: LotFeedbackDecision | null,
): T | "multi_item_lot" | "single_item" {
  if (decision === "lot") return "multi_item_lot";
  if (decision === "not_lot") return "single_item";
  return automaticType;
}

export function compensationProfileSignalAction(
  action: ProfileSignalAction,
): ProfileSignalAction {
  return action === "removed" ? "restored" : "removed";
}

export function appendOnlyTimestampAfter(
  previous: string,
  now = new Date(),
): string {
  const previousMs = Date.parse(previous);
  const nowMs = now.getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) {
    throw new RangeError("append-only feedback timestamps must be valid");
  }
  return new Date(Math.max(nowMs, previousMs + 1)).toISOString();
}

/**
 * Preflights before the immutable append. Once appended, every rebuild
 * failure is answered with an inverse append. If even that append cannot be
 * confirmed, the original correction is reported as accepted but pending
 * recovery rather than being misreported as a failed, inactive correction.
 */
export async function runAppendOnlyProfileCorrection<
  Event,
  Rebuilt,
  Compensation,
>(input: {
  preflight: () => Promise<boolean>;
  append: () => Promise<Event>;
  rebuild: () => Promise<Rebuilt | null>;
  compensate: (event: Event) => Promise<Compensation>;
}): Promise<AppendOnlyProfileCorrectionOutcome<Event, Rebuilt, Compensation>> {
  if (!await input.preflight()) return { outcome: "no_inputs" };

  const event = await input.append();
  try {
    const rebuilt = await input.rebuild();
    if (rebuilt === null) throw new ProfileRebuildNoInputsError();
    return { outcome: "applied", event, rebuilt };
  } catch (reason) {
    try {
      const compensation = await input.compensate(event);
      return { outcome: "reverted", event, reason, compensation };
    } catch (compensationError) {
      return {
        outcome: "pending_rebuild",
        event,
        reason,
        compensationError,
      };
    }
  }
}

function normalizeConceptKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}
