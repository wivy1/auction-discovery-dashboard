import type { SourceManifest } from "./types";

export interface ManualAccessReview {
  readonly decision: "approved";
  readonly termsReviewedAt: string;
  readonly robotsReviewedAt: string;
  readonly evidence: string;
}

export interface SourceAccessGrant {
  readonly enabled: boolean;
  /** Explicitly permits one bounded diagnostic canary for a parser-ready source. */
  readonly allowParserReadyCanary?: boolean;
  readonly manualReview?: ManualAccessReview;
}

export type SourceAccessDecision =
  | {
      readonly allowed: true;
      readonly reason:
        | "official_public_api"
        | "recorded_permission"
        | "manual_review_approved";
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "source_disabled"
        | "adapter_not_implemented"
        | "adapter_not_ready"
        | "permission_prohibited"
        | "manual_review_missing";
    };

export type SourcePermissionDecision =
  | {
      readonly allowed: true;
      readonly reason:
        | "official_public_api"
        | "recorded_permission"
        | "manual_review_approved";
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "permission_prohibited"
        | "manual_review_missing";
    };

/** Reports the recorded permission state independently of adapter readiness. */
export function evaluateSourcePermission(
  manifest: SourceManifest,
  grant: SourceAccessGrant,
): SourcePermissionDecision {
  if (manifest.access.permissionBasis === "prohibited") {
    return { allowed: false, reason: "permission_prohibited" };
  }

  if (manifest.access.permissionBasis === "official_public_api") {
    return { allowed: true, reason: "official_public_api" };
  }

  if (manifest.access.permissionBasis === "recorded_permission") {
    return { allowed: true, reason: "recorded_permission" };
  }

  const review = grant.manualReview;
  const policyReviewedAt = Date.parse(manifest.access.reviewedAt);
  if (
    !Number.isFinite(policyReviewedAt) ||
    !review ||
    review.decision !== "approved" ||
    !isIsoTimestamp(review.termsReviewedAt) ||
    !isIsoTimestamp(review.robotsReviewedAt) ||
    Date.parse(review.termsReviewedAt) < policyReviewedAt ||
    Date.parse(review.robotsReviewedAt) < policyReviewedAt ||
    review.evidence.trim().length < 8
  ) {
    return { allowed: false, reason: "manual_review_missing" };
  }

  return { allowed: true, reason: "manual_review_approved" };
}

export function evaluateSourceAccess(
  manifest: SourceManifest,
  grant: SourceAccessGrant,
): SourceAccessDecision {
  if (!grant.enabled) {
    return { allowed: false, reason: "source_disabled" };
  }

  const permission = evaluateSourcePermission(manifest, grant);
  if (!permission.allowed) return permission;

  if (manifest.implementationStatus === "not_implemented") {
    return { allowed: false, reason: "adapter_not_implemented" };
  }
  if (
    manifest.implementationStatus === "parser_ready_live_disabled" &&
    !grant.allowParserReadyCanary
  ) {
    return { allowed: false, reason: "adapter_not_ready" };
  }

  return permission;
}

export class SourceAccessDeniedError extends Error {
  readonly sourceId: string;
  readonly reason: Exclude<SourceAccessDecision, { allowed: true }>["reason"];

  constructor(
    sourceId: string,
    reason: Exclude<SourceAccessDecision, { allowed: true }>["reason"],
  ) {
    super(`Network access for ${sourceId} is blocked: ${reason}.`);
    this.name = "SourceAccessDeniedError";
    this.sourceId = sourceId;
    this.reason = reason;
  }
}

export function assertSourceAccess(
  manifest: SourceManifest,
  grant: SourceAccessGrant,
): void {
  const decision = evaluateSourceAccess(manifest, grant);
  if (!decision.allowed) {
    throw new SourceAccessDeniedError(manifest.id, decision.reason);
  }
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
