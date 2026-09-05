import type { ManualAccessReview, SourceAccessGrant } from "./access";
import type { SourceAdapter, SourceId } from "./types";

/** Local integrations are code, reviewed and supplied by the operator. */
export interface SourceRegistration {
  readonly adapter: SourceAdapter;
  /** Initial setting only. Later operator switches are persisted in Settings. */
  readonly enabled?: boolean;
  readonly manualReview?: ManualAccessReview;
  readonly scheduling?: {
    readonly dependencies?: readonly SourceId[];
    readonly terminalDependencies?: readonly SourceId[];
    readonly networkLanes?: readonly string[];
    readonly priority?: number;
  };
}

export function sourceRegistrationAccessGrant(
  registration: SourceRegistration | undefined,
  enabled: boolean,
  allowParserReadyCanary = false,
): SourceAccessGrant {
  return {
    enabled: Boolean(registration) && enabled,
    allowParserReadyCanary,
    ...(registration?.manualReview ? { manualReview: registration.manualReview } : {}),
  };
}

export function validateSourceRegistrations(
  registrations: readonly SourceRegistration[],
): readonly SourceRegistration[] {
  if (!Array.isArray(registrations)) {
    throw new TypeError("Local source integrations must export an array.");
  }
  const ids = new Set<string>();
  const earlierIds = new Set<string>();
  for (const registration of registrations as readonly SourceRegistration[]) {
    const id = registration?.adapter?.manifest?.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) {
      throw new TypeError("A source ID must be 1-64 lowercase letters, digits, underscores or hyphens.");
    }
    if (ids.has(id)) throw new Error(`Duplicate source registration: ${id}.`);
    ids.add(id);
    if (registration.enabled !== undefined && typeof registration.enabled !== "boolean") {
      throw new TypeError(`Source ${id} has an invalid initial enabled setting.`);
    }
    const dependencies = [
      ...(registration.scheduling?.dependencies ?? []),
      ...(registration.scheduling?.terminalDependencies ?? []),
    ];
    if (new Set(dependencies).size !== dependencies.length ||
      dependencies.some((dependency) => !earlierIds.has(dependency))) {
      throw new Error(`Source ${id} dependencies must name distinct earlier registrations.`);
    }
    const lanes = registration.scheduling?.networkLanes;
    if (lanes && (lanes.length === 0 || new Set(lanes).size !== lanes.length ||
      lanes.some((lane) => typeof lane !== "string" || !/^[a-z][a-z0-9:_-]{0,127}$/u.test(lane)))) {
      throw new TypeError(`Source ${id} network lanes are invalid.`);
    }
    const priority = registration.scheduling?.priority;
    if (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 0)) {
      throw new TypeError(`Source ${id} priority must be a non-negative integer.`);
    }
    earlierIds.add(id);
  }
  return Object.freeze(registrations.map((registration) => Object.freeze({
    ...registration,
    ...(registration.scheduling ? {
      scheduling: Object.freeze({
        ...registration.scheduling,
        dependencies: Object.freeze([...(registration.scheduling.dependencies ?? [])]),
        terminalDependencies: Object.freeze([...(registration.scheduling.terminalDependencies ?? [])]),
        networkLanes: Object.freeze([...(registration.scheduling.networkLanes ?? [registration.adapter.manifest.id])]),
      }),
    } : {}),
  })));
}
