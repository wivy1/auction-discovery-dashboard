import { hashCanonicalJson } from "../performance/generations";
import type { PerformanceTelemetryBuffer } from "../performance/telemetry";
import {
  refreshOperationalProjectionBatch,
  refreshOperationalProjectionListing,
  type OperationalProjectionContracts,
  type ProjectionScope,
} from "./operational-projection";
import {
  claimPipelineWorkItems,
  completePipelineWorkClaim,
  deferPipelineWorkClaim,
  failPipelineWorkClaim,
  pipelineWorkClaimIdentity,
  preparePipelineWorkCoalesceStatement,
  type PipelineWorkItem,
  type PipelineWorkStage,
  type PipelineWorkSubject,
} from "./work-queue";

export const PROJECTION_REFRESH_STAGES = [
  "projection_listing_refresh",
  "projection_source_refresh",
  "projection_group_refresh",
  "projection_global_refresh",
] as const satisfies readonly PipelineWorkStage[];

export type ProjectionRefreshStage = (typeof PROJECTION_REFRESH_STAGES)[number];

export type ProjectionRefreshTarget =
  | {
      readonly type: "listing";
      readonly listingId: string;
      readonly sourceId: string;
    }
  | { readonly type: "source"; readonly sourceId: string }
  | {
      readonly type: "group";
      readonly groupId: string;
      readonly groupKind: "shared_alias" | "upstream_tuple";
      readonly sourceId?: string | null;
    }
  | { readonly type: "global"; readonly scopeId: string };

export interface ProjectionRefreshDesiredInput {
  readonly target: ProjectionRefreshTarget;
  readonly inputHash: string;
  readonly targetGeneration: number;
  readonly reasonCode: string;
  readonly priority?: number;
  readonly now?: Date;
}

export interface ProjectionRefreshQuantumResult {
  readonly claimed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly failed: number;
  readonly stale: number;
  readonly rows: number;
  readonly statements: number;
}

const MAX_TARGET_GENERATION = Number.MAX_SAFE_INTEGER;

function stageAndSubject(target: ProjectionRefreshTarget): {
  readonly stage: ProjectionRefreshStage;
  readonly subject: PipelineWorkSubject;
  readonly laneKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
} {
  if (target.type === "listing") {
    return {
      stage: "projection_listing_refresh",
      subject: {
        type: "listing",
        id: target.listingId,
        sourceId: target.sourceId,
      },
      laneKey: target.sourceId,
      payload: Object.freeze({ scopeType: "listing" }),
    };
  }
  if (target.type === "source") {
    return {
      stage: "projection_source_refresh",
      subject: { type: "source", id: target.sourceId },
      laneKey: target.sourceId,
      payload: Object.freeze({ scopeType: "source" }),
    };
  }
  if (target.type === "group") {
    return {
      stage: "projection_group_refresh",
      subject: {
        type: "group",
        id: target.groupId,
        sourceId: target.sourceId ?? null,
      },
      laneKey: target.sourceId ?? `group:${target.groupKind}`,
      payload: Object.freeze({
        scopeType: "group",
        groupKind: target.groupKind,
      }),
    };
  }
  return {
    stage: "projection_global_refresh",
    subject: { type: "global", id: target.scopeId },
    laneKey: "global",
    payload: Object.freeze({ scopeType: "global" }),
  };
}

function targetGeneration(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > MAX_TARGET_GENERATION
  ) throw new TypeError("projection refresh target generation is invalid");
  return value;
}

/** Batchable canonical invalidation registration. */
export function prepareProjectionRefreshWorkStatement(input: {
  readonly database: D1Database;
  readonly desired: ProjectionRefreshDesiredInput;
}): D1PreparedStatement {
  const mapped = stageAndSubject(input.desired.target);
  const generation = targetGeneration(input.desired.targetGeneration);
  return preparePipelineWorkCoalesceStatement({
    database: input.database,
    stage: mapped.stage,
    subject: mapped.subject,
    laneKey: mapped.laneKey,
    inputHash: input.desired.inputHash,
    priority: input.desired.priority ?? 100,
    reasonCode: input.desired.reasonCode,
    subjectPayload: { ...mapped.payload, targetGeneration: generation },
    now: input.desired.now,
  });
}

function payloadFor(item: PipelineWorkItem): {
  readonly targetGeneration: number;
  readonly groupKind?: "shared_alias" | "upstream_tuple";
  readonly generationKeys: readonly {
    domain: string;
    scopeType: "listing" | "source" | "group" | "global";
    scopeId: string;
    fingerprint: string;
    derivationVersion: string;
  }[];
} {
  const payload = item.subjectPayload;
  if (payload === null || Array.isArray(payload)) {
    throw new TypeError("projection refresh payload must be an object");
  }
  const objectPayload = payload as Readonly<Record<string, unknown>>;
  const generation = targetGeneration(objectPayload.targetGeneration);
  const groupKind = objectPayload.groupKind;
  if (
    groupKind !== undefined && groupKind !== "shared_alias" &&
    groupKind !== "upstream_tuple"
  ) throw new TypeError("projection refresh group kind is invalid");
  const rawKeys = objectPayload.generationKeys;
  const generationKeys = rawKeys === undefined
    ? []
    : validateGenerationKeys(rawKeys);
  return {
    targetGeneration: generation,
    generationKeys,
    ...(groupKind ? { groupKind } : {}),
  };
}

function validateGenerationKeys(value: unknown): readonly {
  domain: string;
  scopeType: "listing" | "source" | "group" | "global";
  scopeId: string;
  fingerprint: string;
  derivationVersion: string;
}[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new TypeError("projection refresh generation keys are invalid");
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("projection refresh generation key must be an object");
    }
    const row = entry as Record<string, unknown>;
    const domain = boundedPayloadText(row.domain, "generation domain", 128);
    const scopeType = row.scopeType;
    if (
      scopeType !== "listing" && scopeType !== "source" &&
      scopeType !== "group" && scopeType !== "global"
    ) throw new TypeError("projection refresh generation scope type is invalid");
    const scopeId = boundedPayloadText(row.scopeId, "generation scope", 512);
    const fingerprint = boundedPayloadText(
      row.fingerprint,
      "generation fingerprint",
      96,
    );
    if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) {
      throw new TypeError("projection refresh generation fingerprint is invalid");
    }
    const derivationVersion = boundedPayloadText(
      row.derivationVersion,
      "generation derivation version",
      256,
    );
    const identity = `${domain}\u0000${scopeType}\u0000${scopeId}`;
    if (seen.has(identity)) {
      throw new TypeError("projection refresh generation key is duplicated");
    }
    seen.add(identity);
    return Object.freeze({
      domain,
      scopeType,
      scopeId,
      fingerprint,
      derivationVersion,
    });
  }));
}

function boundedPayloadText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError(`projection refresh ${label} is invalid`);
  return value;
}

async function generationPayloadIsCurrent(input: {
  database: D1Database;
  payload: ReturnType<typeof payloadFor>;
}): Promise<boolean> {
  if (input.payload.generationKeys.length === 0) return true;
  const row = await input.database.prepare(`
    WITH expected AS (
      SELECT
        json_extract(value, '$.domain') AS domain,
        json_extract(value, '$.scopeType') AS scope_type,
        json_extract(value, '$.scopeId') AS scope_id,
        json_extract(value, '$.fingerprint') AS fingerprint,
        json_extract(value, '$.derivationVersion') AS derivation_version,
        CAST(key AS INTEGER) AS ordinal
      FROM json_each(?)
    )
    SELECT
      count(*) AS expected_count,
      sum(CASE WHEN state.domain IS NOT NULL
        AND state.fingerprint = expected.fingerprint
        AND state.derivation_version = expected.derivation_version
        THEN 1 ELSE 0 END) AS matching_count,
      max(CASE WHEN expected.ordinal = 0 THEN state.generation END)
        AS primary_generation
    FROM expected
    LEFT JOIN pipeline_generation_state state
      ON state.domain = expected.domain
      AND state.scope_type = expected.scope_type
      AND state.scope_id = expected.scope_id
  `).bind(JSON.stringify(input.payload.generationKeys)).first<{
    expected_count: number;
    matching_count: number;
    primary_generation: number | null;
  }>();
  return Number(row?.expected_count ?? 0) === input.payload.generationKeys.length &&
    Number(row?.matching_count ?? 0) === input.payload.generationKeys.length &&
    Number(row?.primary_generation ?? 0) === input.payload.targetGeneration;
}

function scopeFor(item: PipelineWorkItem): ProjectionScope {
  const payload = payloadFor(item);
  if (item.stage === "projection_source_refresh" && item.subjectType === "source") {
    return { type: "source", id: item.subjectId };
  }
  if (
    item.stage === "projection_group_refresh" && item.subjectType === "group" &&
    payload.groupKind
  ) {
    return {
      type: "group",
      id: item.subjectId,
      groupKind: payload.groupKind,
    };
  }
  if (item.stage === "projection_global_refresh" && item.subjectType === "global") {
    return { type: "global", id: item.subjectId };
  }
  throw new TypeError("projection refresh stage and subject do not match");
}

/** Runs one bounded refresh quantum and preserves exact desired-revision rules. */
export async function runProjectionRefreshQuantum(input: {
  readonly database: D1Database;
  readonly stage: ProjectionRefreshStage;
  readonly owner: string;
  readonly contracts: OperationalProjectionContracts;
  readonly claimLimit?: number;
  readonly listingBatchSize?: number;
  readonly leaseMs?: number;
  readonly now?: Date;
  readonly telemetry?: PerformanceTelemetryBuffer;
}): Promise<ProjectionRefreshQuantumResult> {
  const now = input.now ?? new Date();
  const started = performance.now();
  const claim = await claimPipelineWorkItems({
    database: input.database,
    stage: input.stage,
    owner: input.owner,
    limit: input.claimLimit ?? 1,
    leaseMs: input.leaseMs ?? 120_000,
    now,
  });
  let completed = 0;
  let deferred = 0;
  let failed = 0;
  let stale = 0;
  let rows = 0;
  let statements = 0;
  for (const item of claim.items) {
    const identity = pipelineWorkClaimIdentity(item);
    try {
      const payload = payloadFor(item);
      if (!await generationPayloadIsCurrent({ database: input.database, payload })) {
        throw new Error("projection refresh generation changed before fan-out");
      }
      const cursor = item.progress.cursor;
      const batch = item.stage === "projection_listing_refresh"
        ? item.subjectType !== "listing" || item.listingId === null
          ? (() => { throw new TypeError("listing refresh subject is invalid"); })()
          : await refreshOperationalProjectionListing({
              database: input.database,
              listingId: item.listingId,
              contracts: { ...input.contracts, now },
            })
        : await refreshOperationalProjectionBatch({
            database: input.database,
            scope: scopeFor(item),
            contracts: { ...input.contracts, now },
            afterListingId: cursor,
            limit: input.listingBatchSize ?? 100,
          });
      rows += batch.rowsRead;
      statements += batch.statements;
      if (batch.nextCursor !== null) {
        const outcome = await deferPipelineWorkClaim({
          database: input.database,
          claim: identity,
          availableAt: now,
          progress: {
            cursor: batch.nextCursor,
            generation: payload.targetGeneration,
            rows: item.progress.rows + batch.rowsRead,
          },
          now,
        });
        if (outcome.outcome === "deferred") deferred += 1;
        else stale += 1;
      } else {
        if (!await generationPayloadIsCurrent({ database: input.database, payload })) {
          throw new Error("projection refresh generation changed during fan-out");
        }
        const outcome = await completePipelineWorkClaim({
          database: input.database,
          claim: identity,
          now,
        });
        if (outcome.outcome === "completed") completed += 1;
        else stale += 1;
      }
    } catch (error) {
      const fingerprint = await hashCanonicalJson({
        stage: item.stage,
        name: error instanceof Error ? error.name : "UnknownError",
      });
      const outcome = await failPipelineWorkClaim({
        database: input.database,
        claim: identity,
        errorCode: "projection_refresh_failed",
        errorFingerprint: fingerprint,
        retryAt: new Date(now.getTime() + 60_000),
        now,
      });
      if (outcome.outcome === "retry_scheduled") failed += 1;
      else stale += 1;
    }
  }
  const durationMs = performance.now() - started;
  input.telemetry?.record({
    details: {
      kind: "projection",
      operation: "fanout",
      scopeType: stageScopeType(input.stage),
      scopeIdentity: null,
      resultCount: rows,
      rows,
      batches: claim.items.length,
      statements,
      durationMs,
      generationVectorHash: input.contracts.generationVectorHash,
      targetGeneration: null,
      cursorRows: rows,
      mismatchCount: 0,
      fallbackActivated: false,
      reasonCode: null,
    },
  });
  input.telemetry?.record({
    details: {
      kind: "queue",
      operation: "complete",
      stage: input.stage,
      upserted: 0,
      selected: claim.selected,
      claimed: claim.items.length,
      completed,
      deferred,
      failed,
      reclaimed: 0,
      remaining: 0,
      statements,
      batches: claim.items.length,
      durationMs,
    },
  });
  return Object.freeze({
    claimed: claim.items.length,
    completed,
    deferred,
    failed,
    stale,
    rows,
    statements,
  });
}

function stageScopeType(
  stage: ProjectionRefreshStage,
): "listing" | "source" | "group" | "global" {
  if (stage === "projection_listing_refresh") return "listing";
  if (stage === "projection_source_refresh") return "source";
  if (stage === "projection_group_refresh") return "group";
  return "global";
}
