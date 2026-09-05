export const NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER =
  "x-auction-discovery-scheduler-authorization" as const;

export const NIGHTLY_SCHEDULER_AUTHORIZATION_TTL_MS =
  13 * 60 * 60 * 1_000;
export const NIGHTLY_SCHEDULER_AUTHORIZATION_LIMIT = 64;

export type SchedulerAuthorizationCoverageMode =
  | "auto"
  | "complete_current";

export interface SchedulerRuntimeAuthorizationBinding {
  readonly campaignId: string;
  readonly coverageMode: SchedulerAuthorizationCoverageMode;
  readonly includeSourceAcquisitions: boolean;
}

export type SchedulerRuntimeOptimizedFeature =
  | "enrichmentSessionResidency"
  | "queueBackedProximity";

export interface SchedulerRuntimeAuthorizationOptions {
  /**
   * Optimized implementations whose current readiness receipt was verified
   * before this campaign authorization was issued. The grant is process-local
   * and campaign-bound; it is never persisted or widened after issuance.
   */
  readonly optimizedFeatures?: readonly SchedulerRuntimeOptimizedFeature[];
}

interface SchedulerRuntimeAuthorizationEntry {
  readonly binding: SchedulerRuntimeAuthorizationBinding;
  readonly optimizedFeatures: readonly SchedulerRuntimeOptimizedFeature[];
  readonly expiresAt: number;
}

/**
 * Worker-memory bearer authorizations for one readiness-validated scheduler
 * invocation. No token or token-derived identity is persisted.
 */
export class SchedulerRuntimeAuthorizationRegistry {
  readonly #entries = new Map<string, SchedulerRuntimeAuthorizationEntry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maximumActive: number;
  readonly #randomToken: () => string;

  constructor(input: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly maximumActive?: number;
    readonly randomToken?: () => string;
  } = {}) {
    this.#now = input.now ?? Date.now;
    this.#ttlMs = input.ttlMs ?? NIGHTLY_SCHEDULER_AUTHORIZATION_TTL_MS;
    this.#maximumActive = input.maximumActive ??
      NIGHTLY_SCHEDULER_AUTHORIZATION_LIMIT;
    this.#randomToken = input.randomToken ?? cryptographicToken;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 12 * 60 * 60 * 1_000) {
      throw new RangeError("scheduler authorization TTL must cover the 12-hour task guard");
    }
    if (!Number.isSafeInteger(this.#maximumActive) || this.#maximumActive < 1) {
      throw new RangeError("scheduler authorization capacity must be positive");
    }
  }

  issue(
    binding: SchedulerRuntimeAuthorizationBinding,
    options: SchedulerRuntimeAuthorizationOptions = {},
  ): string {
    this.#purgeExpired();
    if (this.hasCampaign(binding.campaignId)) {
      throw new Error("scheduler campaign already has an active authorization");
    }
    if (this.#entries.size >= this.#maximumActive) {
      throw new Error("scheduler authorization capacity is exhausted");
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = this.#randomToken();
      if (token.length < 32 || this.#entries.has(token)) continue;
      this.#entries.set(token, Object.freeze({
        binding: frozenBinding(binding),
        optimizedFeatures: frozenOptimizedFeatures(options.optimizedFeatures),
        expiresAt: this.#now() + this.#ttlMs,
      }));
      return token;
    }
    throw new Error("scheduler authorization generation failed");
  }

  authorize(
    token: string,
    binding: SchedulerRuntimeAuthorizationBinding,
  ): boolean {
    const authorized = this.read(token);
    return authorized !== null && sameBinding(authorized, binding);
  }

  read(token: string): SchedulerRuntimeAuthorizationBinding | null {
    this.#purgeExpired();
    const entry = this.#entries.get(token);
    return entry?.binding ?? null;
  }

  readOptimizedFeature(
    token: string,
    feature: SchedulerRuntimeOptimizedFeature,
  ): SchedulerRuntimeAuthorizationBinding | null {
    this.#purgeExpired();
    const entry = this.#entries.get(token);
    return entry?.optimizedFeatures.includes(feature) === true
      ? entry.binding
      : null;
  }

  hasCampaign(campaignId: string): boolean {
    this.#purgeExpired();
    for (const { binding } of this.#entries.values()) {
      if (binding.campaignId === campaignId) return true;
    }
    return false;
  }

  retire(token: string): boolean {
    this.#purgeExpired();
    return this.#entries.delete(token);
  }

  /** One-way same-campaign narrowing after the exact source phase terminates. */
  transitionToPreparation(
    token: string,
    expected: SchedulerRuntimeAuthorizationBinding,
  ): SchedulerRuntimeAuthorizationBinding | null {
    this.#purgeExpired();
    const entry = this.#entries.get(token);
    if (
      entry === undefined || !sameBinding(entry.binding, expected) ||
      !entry.binding.includeSourceAcquisitions
    ) return null;
    const binding = frozenBinding({
      ...entry.binding,
      includeSourceAcquisitions: false,
    });
    this.#entries.set(token, Object.freeze({
      binding,
      optimizedFeatures: entry.optimizedFeatures,
      expiresAt: entry.expiresAt,
    }));
    return binding;
  }

  /** Models a Worker/runtime restart in focused tests. */
  reset(): void {
    this.#entries.clear();
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }
}

function frozenOptimizedFeatures(
  features: readonly SchedulerRuntimeOptimizedFeature[] | undefined,
): readonly SchedulerRuntimeOptimizedFeature[] {
  if (features === undefined) return Object.freeze([]);
  const unique = new Set<SchedulerRuntimeOptimizedFeature>();
  for (const feature of features) {
    if (
      (feature !== "enrichmentSessionResidency" &&
        feature !== "queueBackedProximity") ||
      unique.has(feature)
    ) {
      throw new TypeError("scheduler optimized feature grants are invalid");
    }
    unique.add(feature);
  }
  return Object.freeze([...unique].sort());
}

export const schedulerRuntimeAuthorizationRegistry =
  new SchedulerRuntimeAuthorizationRegistry();

function cryptographicToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function frozenBinding(
  binding: SchedulerRuntimeAuthorizationBinding,
): SchedulerRuntimeAuthorizationBinding {
  if (binding.coverageMode !== "auto" && binding.coverageMode !== "complete_current") {
    throw new TypeError("scheduler coverage must be auto or complete_current");
  }
  return Object.freeze({
    campaignId: binding.campaignId,
    coverageMode: binding.coverageMode,
    includeSourceAcquisitions: binding.includeSourceAcquisitions,
  });
}

function sameBinding(
  left: SchedulerRuntimeAuthorizationBinding,
  right: SchedulerRuntimeAuthorizationBinding,
): boolean {
  return left.campaignId === right.campaignId &&
    left.coverageMode === right.coverageMode &&
    left.includeSourceAcquisitions === right.includeSourceAcquisitions;
}
