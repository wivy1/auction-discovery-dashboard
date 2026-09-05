import { hashCanonicalJson } from "../performance/generations.ts";
import {
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "../pipeline/mutation-invalidation.ts";
import type {
  ImageContentAcquisitionMethod,
  ValidatedImageMimeType,
} from "./content-addressed.ts";
import type {
  PerformanceTelemetryContext,
  PerformanceTelemetrySink,
} from "../performance/telemetry.ts";

export interface QueuedPrimaryImageWorkInput {
  readonly listingImageId: string;
  readonly listingId: string;
  readonly sourceId: string;
  readonly sourceImageIdentityHash: string;
  readonly sourcePosition: number;
  readonly representativePrimary: true;
  readonly inputHash: string;
  readonly revision: number;
}

export const SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY =
  "source-evidence:image-unavailable:v1";

export interface PrimaryImageFailureCommitInput
  extends QueuedPrimaryImageWorkInput {
  readonly database: D1Database;
  readonly representation: "canonical" | "observed_thumbnail";
  readonly acquisitionMethod: Exclude<ImageContentAcquisitionMethod, "content_reuse">;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly terminalUnavailable: boolean;
  readonly now?: Date;
}

export type PrimaryImageFailureCommitOutcome =
  | {
      readonly outcome: "recorded" | "terminal";
      readonly attemptCount: number;
      readonly terminalUnavailable: boolean;
    }
  | { readonly outcome: "stale_work" };

export interface ValidatedPrimaryImageCommitInput
  extends QueuedPrimaryImageWorkInput {
  readonly database: D1Database;
  readonly contentHash: string;
  readonly mimeType: ValidatedImageMimeType;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly validationVersion: string;
  readonly validationHash: string;
  readonly pixelWidth: number | null;
  readonly pixelHeight: number | null;
  readonly acquisitionMethod: Exclude<ImageContentAcquisitionMethod, "content_reuse">;
  readonly acquisitionProvenanceHash: string;
  readonly now?: Date;
  /** Explicit benchmark/debug capture only. */
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
  /** Caller-measured byte/storage work; required whenever telemetry is enabled. */
  readonly telemetryMeasurement?: Readonly<{
    readonly downloadedBytes: number;
    readonly contentHashBytesReused: number;
    readonly contentHashHits: number;
    readonly archiveWrites: number;
  }>;
}

export type ValidatedPrimaryImageCommitOutcome =
  | {
      readonly outcome: "completed" | "idempotent";
      readonly linkIdentity: string;
      readonly contentHash: string;
      readonly storageKey: string;
    }
  | { readonly outcome: "stale_work" }
  | { readonly outcome: "content_conflict" };

export type CanonicalPrimaryImageCompletionOutcome =
  | { readonly outcome: "completed" | "idempotent" }
  | { readonly outcome: "stale_work" };

interface WorkRow {
  listing_image_id: string;
  listing_id: string;
  source_id: string;
  source_image_identity_hash: string;
  source_position: number;
  representative_primary: number;
  input_hash: string;
  revision: number;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u;
const MIME_TYPES = new Set<ValidatedImageMimeType>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/**
 * Resolves only exact, unclaimed `primary_image` desired revisions. The source
 * identity is read from the canonical projection rather than reconstructed
 * from a possibly signed URL.
 */
export async function readQueuedPrimaryImageWorkInputs(input: {
  readonly database: D1Database;
  readonly listingImageIds: readonly string[];
}): Promise<ReadonlyMap<string, QueuedPrimaryImageWorkInput>> {
  const ids = [...new Set(input.listingImageIds.map((id) => identity(id, "image id")))];
  if (ids.length === 0) return new Map();
  if (ids.length > 25) throw new RangeError("image work lookup is limited to 25 identities");
  const result = await input.database.prepare(`
    SELECT
      image.id AS listing_image_id,
      image.listing_id,
      stub.source_id,
      state.source_image_identity_hash,
      image.position AS source_position,
      image.is_primary AS representative_primary,
      work.input_hash,
      work.revision
    FROM json_each(?) AS requested
    INNER JOIN listing_images AS image ON image.id = requested.value
    INNER JOIN listing_stubs AS stub ON stub.id = image.listing_id
    INNER JOIN listing_current_pipeline_state AS state
      ON state.listing_id = image.listing_id
      AND state.source_id = stub.source_id
    INNER JOIN pipeline_work_items AS work
      ON work.stage = 'primary_image'
      AND work.subject_type = 'listing'
      AND work.subject_id = image.listing_id
      AND work.listing_id = image.listing_id
      AND work.source_id = stub.source_id
      AND work.input_hash = state.image_work_input_hash
    WHERE image.is_primary = 1
      AND image.position = 0
      AND state.source_image_identity_hash IS NOT NULL
      AND work.lease_owner IS NULL
      AND work.lease_expires_at IS NULL
      AND work.claimed_input_hash IS NULL
      AND work.claimed_revision IS NULL
  `).bind(JSON.stringify(ids)).all<WorkRow>();
  const found = new Map<string, QueuedPrimaryImageWorkInput>();
  for (const row of result.results ?? []) {
    if (row.representative_primary !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error("stored primary image work input is invalid");
    }
    found.set(row.listing_image_id, Object.freeze({
      listingImageId: identity(row.listing_image_id, "image id"),
      listingId: identity(row.listing_id, "listing id"),
      sourceId: identity(row.source_id, "source id"),
      sourceImageIdentityHash: hash(row.source_image_identity_hash, "source image identity"),
      sourcePosition: integer(row.source_position, "source position", 0),
      representativePrimary: true,
      inputHash: hash(row.input_hash, "image work input"),
      revision: integer(row.revision, "image work revision", 1),
    }));
  }
  return found;
}

/**
 * Completes an exact unclaimed canonical image revision only after the legacy
 * image row contains locally archived bytes for the same current source
 * identity. This intentionally does not create content-addressed records or
 * performance readiness evidence.
 */
export async function completeCanonicalPrimaryImageWork(
  input: QueuedPrimaryImageWorkInput & { readonly database: D1Database },
): Promise<CanonicalPrimaryImageCompletionOutcome> {
  const checked = validateQueuedWorkInput(input);
  const downloaded = canonicalDownloadedStateSql();
  const downloadedValues = canonicalDownloadedStateBindings(checked);
  const results = await input.database.batch([
    input.database.prepare(`
      DELETE FROM pipeline_work_items
      WHERE stage = 'primary_image' AND subject_type = 'listing'
        AND subject_id = ? AND listing_id = ? AND source_id = ?
        AND input_hash = ? AND revision = ?
        AND lease_owner IS NULL AND lease_expires_at IS NULL
        AND claimed_input_hash IS NULL AND claimed_revision IS NULL
        AND ${downloaded.sql}
    `).bind(
      checked.listingId,
      checked.listingId,
      checked.sourceId,
      checked.inputHash,
      checked.revision,
      ...downloadedValues,
    ),
    input.database.prepare(`
      SELECT
        ${downloaded.sql} AS downloaded_exact,
        EXISTS (
          SELECT 1 FROM pipeline_work_items
          WHERE stage = 'primary_image' AND subject_type = 'listing'
            AND subject_id = ?
        ) AS primary_work_exists
    `).bind(
      ...downloadedValues,
      checked.listingId,
    ),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) === 1) {
    return { outcome: "completed" };
  }
  const state = (results[1]?.results?.[0] ?? null) as {
    downloaded_exact?: unknown;
    primary_work_exists?: unknown;
  } | null;
  if (
    Number(state?.downloaded_exact ?? 0) === 1 &&
    Number(state?.primary_work_exists ?? 0) === 0
  ) {
    return { outcome: "idempotent" };
  }
  return { outcome: "stale_work" };
}

/**
 * Persists one exact queue-bound acquisition failure. Permanent exhaustion of
 * the canonical representation and its one allowed observed-thumbnail
 * fallback atomically records terminal source evidence and completes only the
 * exact desired work revision. A diagnostic-only failure deliberately leaves
 * the work revision in place and creates no projection generation: retry
 * counters and timestamps are not canonical preparation progress.
 */
export async function commitPrimaryImageFailure(
  input: PrimaryImageFailureCommitInput,
): Promise<PrimaryImageFailureCommitOutcome> {
  const checked = validatePrimaryImageFailureInput(input);
  const nowIso = (input.now ?? new Date()).toISOString();
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new RangeError("image failure time is invalid");
  }
  const exact = exactPrimaryImageFailureTargetSql();
  const exactValues = exactPrimaryImageFailureTargetBindings(checked);
  const preflight = await input.database.prepare(`
    SELECT ${exact.sql} AS exact_work_matches
  `).bind(...exactValues).first<{ exact_work_matches: number }>();
  if (Number(preflight?.exact_work_matches ?? 0) !== 1) {
    return { outcome: "stale_work" };
  }

  const invalidation = checked.terminalUnavailable
    ? await prepareCanonicalMutationPayloadInvalidationStatements({
        database: input.database,
        generations: [{
          domain: "image_local_primary",
          scopeType: "listing",
          scopeId: checked.listingId,
          input: {
            originCacheKey: SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY,
            state: "terminal",
            stage: "image",
            errorCode: "source_image_unavailable",
            sourceImageIdentityHash: checked.sourceImageIdentityHash,
            sourceInputHash: checked.inputHash,
          },
          derivationVersion: "image-local-primary-mutation-v1",
        }],
        refresh: {
          target: {
            type: "listing",
            listingId: checked.listingId,
            sourceId: checked.sourceId,
          },
          reasonCode: "image_recovery_changed",
          priority: 500,
        },
        now: input.now,
      })
    : [];

  const statements: D1PreparedStatement[] = [input.database.prepare(`
    UPDATE listing_images
    SET download_status = 'failed', local_path = NULL, content_hash = NULL,
        width = NULL, height = NULL, downloaded_at = NULL,
        download_error = ?, download_error_code = ?, acquisition_method = ?,
        attempt_count = attempt_count + 1, last_attempted_at = ?
    WHERE id = ? AND listing_id = ? AND position = ? AND is_primary = 1
      AND ${exact.sql}
  `).bind(
    checked.errorMessage,
    checked.errorCode,
    checked.acquisitionMethod,
    nowIso,
    checked.listingImageId,
    checked.listingId,
    checked.sourcePosition,
    ...exactValues,
  )];

  let completionIndex: number | null = null;
  if (checked.terminalUnavailable) {
    statements.push(input.database.prepare(`
      INSERT INTO listing_recovery_status (
        listing_id, origin_cache_key, state, stage, attempt_count,
        last_attempted_at, last_error_code
      )
      SELECT ?, ?, 'terminal', 'image', 1, ?, 'source_image_unavailable'
      WHERE ${exact.sql}
      ON CONFLICT(listing_id, origin_cache_key) DO UPDATE SET
        state = 'terminal', stage = 'image',
        attempt_count = listing_recovery_status.attempt_count + 1,
        last_attempted_at = excluded.last_attempted_at,
        last_error_code = excluded.last_error_code
    `).bind(
      checked.listingId,
      SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY,
      nowIso,
      ...exactValues,
    ));
    statements.push(...invalidation);
    completionIndex = statements.length;
    statements.push(input.database.prepare(`
      DELETE FROM pipeline_work_items
      WHERE stage = 'primary_image' AND subject_type = 'listing'
        AND subject_id = ? AND listing_id = ? AND source_id = ?
        AND input_hash = ? AND revision = ?
        AND lease_owner IS NULL AND lease_expires_at IS NULL
        AND claimed_input_hash IS NULL AND claimed_revision IS NULL
        AND EXISTS (
          SELECT 1 FROM listing_recovery_status
          WHERE listing_id = ? AND origin_cache_key = ?
            AND state = 'terminal' AND stage = 'image'
            AND last_error_code = 'source_image_unavailable'
        )
    `).bind(
      checked.listingId,
      checked.listingId,
      checked.sourceId,
      checked.inputHash,
      checked.revision,
      checked.listingId,
      SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY,
    ));
  }
  const stateIndex = statements.length;
  statements.push(input.database.prepare(`
    SELECT
      COALESCE((
        SELECT attempt_count FROM listing_images
        WHERE id = ? AND listing_id = ? AND position = ? AND is_primary = 1
      ), -1) AS attempt_count,
      EXISTS (
        SELECT 1 FROM pipeline_work_items
        WHERE stage = 'primary_image' AND subject_type = 'listing'
          AND subject_id = ? AND listing_id = ? AND source_id = ?
          AND input_hash = ? AND revision = ?
      ) AS primary_work_exists,
      EXISTS (
        SELECT 1 FROM listing_recovery_status
        WHERE listing_id = ? AND origin_cache_key = ?
          AND state = 'terminal' AND stage = 'image'
          AND last_error_code = 'source_image_unavailable'
      ) AS terminal_unavailable
  `).bind(
    checked.listingImageId,
    checked.listingId,
    checked.sourcePosition,
    checked.listingId,
    checked.listingId,
    checked.sourceId,
    checked.inputHash,
    checked.revision,
    checked.listingId,
    SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY,
  ));

  const results = await input.database.batch(statements);
  const state = (results[stateIndex]?.results?.[0] ?? null) as {
    attempt_count?: unknown;
    primary_work_exists?: unknown;
    terminal_unavailable?: unknown;
  } | null;
  const attemptCount = Number(state?.attempt_count ?? -1);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    return { outcome: "stale_work" };
  }
  if (checked.terminalUnavailable) {
    if (
      Number(state?.terminal_unavailable ?? 0) !== 1 ||
      Number(state?.primary_work_exists ?? 0) !== 0 ||
      completionIndex === null ||
      Number(results[completionIndex]?.meta.changes ?? 0) !== 1
    ) {
      return { outcome: "stale_work" };
    }
    return {
      outcome: "terminal",
      attemptCount,
      terminalUnavailable: true,
    };
  }
  if (
    Number(results[0]?.meta.changes ?? 0) !== 1 ||
    Number(state?.primary_work_exists ?? 0) !== 1
  ) {
    return { outcome: "stale_work" };
  }
  return {
    outcome: "recorded",
    attemptCount,
    terminalUnavailable: false,
  };
}

/**
 * Atomically registers exact validated bytes, appends their immutable source
 * observation, advances the image head, marks the legacy primary ready, and
 * completes only the exact desired queue revision. A batch failure rolls all
 * D1 effects back; an already stored R2 object remains an unreferenced safe
 * content-addressed object until a later exact retry.
 */
export async function commitValidatedPrimaryImageWork(
  input: ValidatedPrimaryImageCommitInput,
): Promise<ValidatedPrimaryImageCommitOutcome> {
  const checked = validateCommitInput(input);
  const telemetryMeasurement = validatedTelemetryMeasurement(input);
  const nowIso = (input.now ?? new Date()).toISOString();
  if (!Number.isFinite(new Date(nowIso).getTime())) throw new RangeError("image commit time is invalid");
  const linkIdentity = await hashCanonicalJson({
    sourceId: checked.sourceId,
    listingId: checked.listingId,
    listingImageId: checked.listingImageId,
    contentHash: checked.contentHash,
    sourceImageIdentityHash: checked.sourceImageIdentityHash,
    sourcePosition: checked.sourcePosition,
    representativePrimary: true,
    acquisitionMethod: checked.acquisitionMethod,
    acquisitionProvenanceHash: checked.acquisitionProvenanceHash,
    sourceInputHash: checked.inputHash,
    contract: "listing-image-content-link-v1",
  });
  const target = exactTargetSql();
  const targetValues = exactTargetBindings(checked);
  const completed = exactCompletedSql();
  const completedValues = exactCompletedBindings(checked, linkIdentity);
  const allowed = `((${target.sql}) OR (${completed.sql}))`;
  const allowedValues = [...targetValues, ...completedValues];
  const preflight = await input.database.prepare(`
    SELECT ${target.sql} AS exact_work_matches,
      ${completed.sql} AS completed_exact,
      EXISTS (
        SELECT 1 FROM image_content_blobs WHERE content_hash = ?
      ) AS blob_exists,
      EXISTS (
        SELECT 1 FROM image_content_blobs
        WHERE content_hash = ? AND hash_algorithm = 'sha256'
          AND mime_type = ? AND byte_length = ? AND storage_key = ?
          AND validation_version = ? AND validation_hash = ?
          AND pixel_width IS ? AND pixel_height IS ?
          AND lifecycle_state = 'active' AND deleted_at IS NULL
      ) AS blob_matches
  `).bind(
    ...targetValues,
    ...completedValues,
    checked.contentHash,
    checked.contentHash,
    checked.mimeType,
    checked.byteLength,
    checked.storageKey,
    checked.validationVersion,
    checked.validationHash,
    checked.pixelWidth,
    checked.pixelHeight,
  ).first<{
    exact_work_matches: number;
    completed_exact: number;
    blob_exists: number;
    blob_matches: number;
  }>();
  if (Number(preflight?.exact_work_matches ?? 0) !== 1) {
    if (Number(preflight?.completed_exact ?? 0) === 1) {
      const outcome = {
        outcome: "idempotent",
        linkIdentity,
        contentHash: checked.contentHash,
        storageKey: checked.storageKey,
      } as const;
      recordImageTelemetry(input, telemetryMeasurement, outcome.outcome);
      return outcome;
    }
    recordImageTelemetry(input, telemetryMeasurement, "stale_work");
    return { outcome: "stale_work" };
  }
  if (
    Number(preflight?.blob_exists ?? 0) === 1 &&
    Number(preflight?.blob_matches ?? 0) !== 1
  ) {
    recordImageTelemetry(input, telemetryMeasurement, "content_conflict");
    return { outcome: "content_conflict" };
  }
  const invalidation =
    await prepareCanonicalMutationPayloadInvalidationStatements({
      database: input.database,
      generations: [{
        domain: "image_local_primary",
        scopeType: "listing",
        scopeId: checked.listingId,
        input: {
          listingId: checked.listingId,
          listingImageId: checked.listingImageId,
          sourceImageIdentityHash: checked.sourceImageIdentityHash,
          sourcePosition: checked.sourcePosition,
          linkIdentity,
          contentHash: checked.contentHash,
          storageKey: checked.storageKey,
          validationHash: checked.validationHash,
          pixelWidth: checked.pixelWidth,
          pixelHeight: checked.pixelHeight,
          sourceInputHash: checked.inputHash,
        },
        derivationVersion: "image-local-primary-mutation-v1",
      }],
      refresh: {
        target: {
          type: "listing",
          listingId: checked.listingId,
          sourceId: checked.sourceId,
        },
        reasonCode: "primary_image_state_changed",
        priority: 600,
      },
      now: input.now,
    });
  const completionResultIndex = 6 + invalidation.length;
  const stateResultIndex = completionResultIndex + 1;

  const results = await input.database.batch([
    input.database.prepare(`
      INSERT INTO image_content_blobs (
        content_hash, hash_algorithm, mime_type, byte_length, storage_key,
        validation_version, validation_hash, pixel_width, pixel_height,
        lifecycle_state, first_acquired_at, last_verified_at, deleted_at
      )
      SELECT ?, 'sha256', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL
      WHERE ${allowed}
      ON CONFLICT DO NOTHING
    `).bind(
      checked.contentHash,
      checked.mimeType,
      checked.byteLength,
      checked.storageKey,
      checked.validationVersion,
      checked.validationHash,
      checked.pixelWidth,
      checked.pixelHeight,
      nowIso,
      nowIso,
      ...allowedValues,
    ),
    input.database.prepare(`
      UPDATE image_content_blobs
      SET last_verified_at = CASE WHEN last_verified_at < ? THEN ? ELSE last_verified_at END
      WHERE content_hash = ? AND hash_algorithm = 'sha256'
        AND mime_type = ? AND byte_length = ? AND storage_key = ?
        AND validation_version = ? AND validation_hash = ?
        AND pixel_width IS ? AND pixel_height IS ?
        AND lifecycle_state = 'active' AND deleted_at IS NULL
        AND ${allowed}
    `).bind(
      nowIso,
      nowIso,
      checked.contentHash,
      checked.mimeType,
      checked.byteLength,
      checked.storageKey,
      checked.validationVersion,
      checked.validationHash,
      checked.pixelWidth,
      checked.pixelHeight,
      ...allowedValues,
    ),
    input.database.prepare(`
      INSERT INTO listing_image_content_links (
        link_identity, listing_id, listing_image_id, content_hash,
        source_image_identity_hash, source_position, representative_primary,
        acquisition_method, acquisition_provenance_hash, source_input_hash,
        linked_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
      WHERE ${allowed}
        AND EXISTS (
          SELECT 1 FROM image_content_blobs
          WHERE content_hash = ? AND mime_type = ? AND byte_length = ?
            AND storage_key = ? AND validation_version = ? AND validation_hash = ?
            AND pixel_width IS ? AND pixel_height IS ?
            AND lifecycle_state = 'active' AND deleted_at IS NULL
        )
      ON CONFLICT DO NOTHING
    `).bind(
      linkIdentity,
      checked.listingId,
      checked.listingImageId,
      checked.contentHash,
      checked.sourceImageIdentityHash,
      checked.sourcePosition,
      checked.acquisitionMethod,
      checked.acquisitionProvenanceHash,
      checked.inputHash,
      nowIso,
      ...allowedValues,
      checked.contentHash,
      checked.mimeType,
      checked.byteLength,
      checked.storageKey,
      checked.validationVersion,
      checked.validationHash,
      checked.pixelWidth,
      checked.pixelHeight,
    ),
    input.database.prepare(`
      INSERT INTO listing_image_content_heads (
        listing_image_id, listing_id, link_identity, content_hash,
        source_input_hash, representative_primary, generation, updated_at
      )
      SELECT ?, ?, ?, ?, ?, 1, 1, ?
      WHERE ${allowed}
        AND EXISTS (SELECT 1 FROM listing_image_content_links WHERE link_identity = ?)
      ON CONFLICT(listing_image_id) DO NOTHING
    `).bind(
      checked.listingImageId,
      checked.listingId,
      linkIdentity,
      checked.contentHash,
      checked.inputHash,
      nowIso,
      ...allowedValues,
      linkIdentity,
    ),
    input.database.prepare(`
      UPDATE listing_image_content_heads
      SET listing_id = ?, link_identity = ?, content_hash = ?,
          source_input_hash = ?, representative_primary = 1,
          generation = generation + 1, updated_at = ?
      WHERE listing_image_id = ? AND link_identity <> ?
        AND ${target.sql}
        AND EXISTS (SELECT 1 FROM listing_image_content_links WHERE link_identity = ?)
    `).bind(
      checked.listingId,
      linkIdentity,
      checked.contentHash,
      checked.inputHash,
      nowIso,
      checked.listingImageId,
      linkIdentity,
      ...targetValues,
      linkIdentity,
    ),
    input.database.prepare(`
      UPDATE listing_images
      SET download_status = 'downloaded', local_path = ?, content_hash = ?,
          width = ?, height = ?, downloaded_at = ?,
          download_error = NULL, download_error_code = NULL,
          acquisition_method = ?, attempt_count = attempt_count + 1,
          last_attempted_at = ?
      WHERE id = ? AND listing_id = ? AND position = ? AND is_primary = 1
        AND ${target.sql}
        AND EXISTS (
          SELECT 1 FROM listing_image_content_heads
          WHERE listing_image_id = ? AND link_identity = ?
            AND content_hash = ? AND source_input_hash = ?
        )
    `).bind(
      checked.storageKey,
      checked.contentHash.slice(7),
      checked.pixelWidth,
      checked.pixelHeight,
      nowIso,
      checked.acquisitionMethod,
      nowIso,
      checked.listingImageId,
      checked.listingId,
      checked.sourcePosition,
      ...targetValues,
      checked.listingImageId,
      linkIdentity,
      checked.contentHash,
      checked.inputHash,
    ),
    ...invalidation,
    input.database.prepare(`
      DELETE FROM pipeline_work_items
      WHERE stage = 'primary_image' AND subject_type = 'listing'
        AND subject_id = ? AND listing_id = ? AND source_id = ?
        AND input_hash = ? AND revision = ?
        AND lease_owner IS NULL AND lease_expires_at IS NULL
        AND claimed_input_hash IS NULL AND claimed_revision IS NULL
        AND EXISTS (
          SELECT 1 FROM listing_images AS image
          INNER JOIN listing_image_content_heads AS head
            ON head.listing_image_id = image.id
          WHERE image.id = ? AND image.listing_id = ?
            AND image.download_status = 'downloaded'
            AND image.local_path = ? AND image.content_hash = ?
            AND head.link_identity = ? AND head.content_hash = ?
            AND head.source_input_hash = ?
        )
    `).bind(
      checked.listingId,
      checked.listingId,
      checked.sourceId,
      checked.inputHash,
      checked.revision,
      checked.listingImageId,
      checked.listingId,
      checked.storageKey,
      checked.contentHash.slice(7),
      linkIdentity,
      checked.contentHash,
      checked.inputHash,
    ),
    input.database.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM image_content_blobs
          WHERE content_hash = ? AND mime_type = ? AND byte_length = ?
            AND storage_key = ? AND validation_version = ? AND validation_hash = ?
            AND pixel_width IS ? AND pixel_height IS ?
            AND lifecycle_state = 'active' AND deleted_at IS NULL
        ) AS blob_matches,
        EXISTS (
          SELECT 1 FROM listing_images AS image
          INNER JOIN listing_image_content_heads AS head
            ON head.listing_image_id = image.id
          WHERE image.id = ? AND image.listing_id = ?
            AND image.download_status = 'downloaded'
            AND image.local_path = ? AND image.content_hash = ?
            AND head.link_identity = ? AND head.content_hash = ?
            AND head.source_input_hash = ?
        ) AS completed_exact,
        ${target.sql} AS exact_work_matches
    `).bind(
      checked.contentHash,
      checked.mimeType,
      checked.byteLength,
      checked.storageKey,
      checked.validationVersion,
      checked.validationHash,
      checked.pixelWidth,
      checked.pixelHeight,
      checked.listingImageId,
      checked.listingId,
      checked.storageKey,
      checked.contentHash.slice(7),
      linkIdentity,
      checked.contentHash,
      checked.inputHash,
      ...targetValues,
    ),
  ]);

  const state = (results[stateResultIndex]?.results?.[0] ?? null) as {
    blob_matches?: unknown;
    completed_exact?: unknown;
    exact_work_matches?: unknown;
  } | null;
  if (Number(state?.completed_exact ?? 0) === 1) {
    const outcome = {
      outcome: Number(results[completionResultIndex]?.meta.changes ?? 0) === 1
        ? "completed" as const
        : "idempotent" as const,
      linkIdentity,
      contentHash: checked.contentHash,
      storageKey: checked.storageKey,
    };
    recordImageTelemetry(input, telemetryMeasurement, outcome.outcome);
    return outcome;
  }
  if (
    Number(state?.blob_matches ?? 0) !== 1 &&
    Number(state?.exact_work_matches ?? 0) === 1
  ) {
    recordImageTelemetry(input, telemetryMeasurement, "content_conflict");
    return { outcome: "content_conflict" };
  }
  recordImageTelemetry(input, telemetryMeasurement, "stale_work");
  return { outcome: "stale_work" };
}

function validatedTelemetryMeasurement(
  input: ValidatedPrimaryImageCommitInput,
): ValidatedPrimaryImageCommitInput["telemetryMeasurement"] {
  if (input.telemetry === undefined) return undefined;
  const measurement = input.telemetryMeasurement;
  if (measurement === undefined) {
    throw new Error("image telemetry requires caller-measured byte and archive evidence");
  }
  for (const [label, value] of Object.entries(measurement)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`image telemetry ${label} is invalid`);
    }
  }
  return measurement;
}

function recordImageTelemetry(
  input: ValidatedPrimaryImageCommitInput,
  measurement: ValidatedPrimaryImageCommitInput["telemetryMeasurement"],
  outcome: ValidatedPrimaryImageCommitOutcome["outcome"],
): void {
  if (input.telemetry === undefined || measurement === undefined) return;
  input.telemetry.record({
    context: {
      ...input.telemetryContext,
      sourceId: input.sourceId,
    },
    details: {
      kind: "image",
      downloadedBytes: measurement.downloadedBytes,
      contentHashBytesReused: measurement.contentHashBytesReused,
      contentHashHits: measurement.contentHashHits,
      archiveWrites: measurement.archiveWrites,
      attempted: 1,
      failed: outcome === "stale_work" || outcome === "content_conflict" ? 1 : 0,
    },
  });
}

function exactTargetSql(): { readonly sql: string } {
  return { sql: `EXISTS (
    SELECT 1
    FROM pipeline_work_items AS work
    INNER JOIN listing_images AS image ON image.listing_id = work.listing_id
    INNER JOIN listing_stubs AS stub ON stub.id = image.listing_id
    WHERE work.stage = 'primary_image' AND work.subject_type = 'listing'
      AND work.subject_id = ? AND work.listing_id = ? AND work.source_id = ?
      AND work.input_hash = ? AND work.revision = ?
      AND work.lease_owner IS NULL AND work.lease_expires_at IS NULL
      AND work.claimed_input_hash IS NULL AND work.claimed_revision IS NULL
      AND image.id = ? AND image.position = ? AND image.is_primary = 1
      AND stub.source_id = ?
  )` };
}

function exactPrimaryImageFailureTargetSql(): { readonly sql: string } {
  return { sql: `EXISTS (
    SELECT 1
    FROM pipeline_work_items AS work
    INNER JOIN listing_images AS image ON image.listing_id = work.listing_id
    INNER JOIN listing_stubs AS stub ON stub.id = image.listing_id
    INNER JOIN listing_current_pipeline_state AS state
      ON state.listing_id = image.listing_id AND state.source_id = stub.source_id
    WHERE work.stage = 'primary_image' AND work.subject_type = 'listing'
      AND work.subject_id = ? AND work.listing_id = ? AND work.source_id = ?
      AND work.input_hash = ? AND work.revision = ?
      AND work.lease_owner IS NULL AND work.lease_expires_at IS NULL
      AND work.claimed_input_hash IS NULL AND work.claimed_revision IS NULL
      AND image.id = ? AND image.position = ? AND image.is_primary = 1
      AND image.download_status <> 'downloaded' AND image.local_path IS NULL
      AND stub.source_id = ?
      AND state.source_image_identity_hash = ?
      AND state.image_work_input_hash = ?
  )` };
}

function exactPrimaryImageFailureTargetBindings(
  input: ReturnType<typeof validatePrimaryImageFailureInput>,
): unknown[] {
  return [
    input.listingId,
    input.listingId,
    input.sourceId,
    input.inputHash,
    input.revision,
    input.listingImageId,
    input.sourcePosition,
    input.sourceId,
    input.sourceImageIdentityHash,
    input.inputHash,
  ];
}

function canonicalDownloadedStateSql(): { readonly sql: string } {
  return { sql: `EXISTS (
    SELECT 1
    FROM listing_images AS image
    INNER JOIN listing_stubs AS stub ON stub.id = image.listing_id
    INNER JOIN listing_current_pipeline_state AS state
      ON state.listing_id = image.listing_id
      AND state.source_id = stub.source_id
    WHERE image.id = ? AND image.listing_id = ?
      AND image.position = ? AND image.is_primary = 1
      AND image.download_status = 'downloaded'
      AND image.local_path IS NOT NULL AND trim(image.local_path) <> ''
      AND image.content_hash IS NOT NULL AND trim(image.content_hash) <> ''
      AND stub.source_id = ?
      AND state.source_id = ?
      AND state.source_image_identity_hash = ?
      AND state.image_work_input_hash = ?
  )` };
}

function canonicalDownloadedStateBindings(
  input: ReturnType<typeof validateQueuedWorkInput>,
): unknown[] {
  return [
    input.listingImageId,
    input.listingId,
    input.sourcePosition,
    input.sourceId,
    input.sourceId,
    input.sourceImageIdentityHash,
    input.inputHash,
  ];
}

function exactTargetBindings(input: ReturnType<typeof validateCommitInput>): unknown[] {
  return [
    input.listingId,
    input.listingId,
    input.sourceId,
    input.inputHash,
    input.revision,
    input.listingImageId,
    input.sourcePosition,
    input.sourceId,
  ];
}

function exactCompletedSql(): { readonly sql: string } {
  return { sql: `EXISTS (
    SELECT 1
    FROM listing_images AS image
    INNER JOIN listing_stubs AS stub ON stub.id = image.listing_id
    INNER JOIN listing_image_content_heads AS head
      ON head.listing_image_id = image.id
    WHERE image.id = ? AND image.listing_id = ?
      AND image.position = ? AND image.is_primary = 1
      AND image.download_status = 'downloaded'
      AND image.local_path = ? AND image.content_hash = ?
      AND stub.source_id = ?
      AND head.link_identity = ? AND head.content_hash = ?
      AND head.source_input_hash = ?
  )` };
}

function exactCompletedBindings(
  input: ReturnType<typeof validateCommitInput>,
  linkIdentity: string,
): unknown[] {
  return [
    input.listingImageId,
    input.listingId,
    input.sourcePosition,
    input.storageKey,
    input.contentHash.slice(7),
    input.sourceId,
    linkIdentity,
    input.contentHash,
    input.inputHash,
  ];
}

function validateCommitInput(input: ValidatedPrimaryImageCommitInput) {
  if (!MIME_TYPES.has(input.mimeType)) throw new RangeError("image MIME type is unsupported");
  if (!SAFE_KEY.test(input.storageKey) || input.storageKey.includes("..") || /[?#%\\]/u.test(input.storageKey)) {
    throw new RangeError("image storage key is unsafe");
  }
  const pixelWidth = nullableInteger(input.pixelWidth, "pixel width", 1);
  const pixelHeight = nullableInteger(input.pixelHeight, "pixel height", 1);
  if ((pixelWidth === null) !== (pixelHeight === null)) {
    throw new RangeError("image dimensions must both be present or absent");
  }
  if (!(["browser", "direct"] as const).includes(input.acquisitionMethod)) {
    throw new RangeError("image acquisition method is unsupported");
  }
  return Object.freeze({
    listingImageId: identity(input.listingImageId, "image id"),
    listingId: identity(input.listingId, "listing id"),
    sourceId: identity(input.sourceId, "source id"),
    sourceImageIdentityHash: hash(input.sourceImageIdentityHash, "source image identity"),
    sourcePosition: integer(input.sourcePosition, "source position", 0),
    inputHash: hash(input.inputHash, "image work input"),
    revision: integer(input.revision, "image work revision", 1),
    contentHash: hash(input.contentHash, "content hash"),
    mimeType: input.mimeType,
    byteLength: integer(input.byteLength, "image byte length", 1, 50 * 1024 * 1024),
    storageKey: input.storageKey,
    validationVersion: identity(input.validationVersion, "validation version"),
    validationHash: hash(input.validationHash, "validation hash"),
    pixelWidth,
    pixelHeight,
    acquisitionMethod: input.acquisitionMethod,
    acquisitionProvenanceHash: hash(input.acquisitionProvenanceHash, "acquisition provenance"),
  });
}

function validateQueuedWorkInput(input: QueuedPrimaryImageWorkInput) {
  if (input.representativePrimary !== true) {
    throw new RangeError("image work must identify the representative primary");
  }
  return Object.freeze({
    listingImageId: identity(input.listingImageId, "image id"),
    listingId: identity(input.listingId, "listing id"),
    sourceId: identity(input.sourceId, "source id"),
    sourceImageIdentityHash: hash(input.sourceImageIdentityHash, "source image identity"),
    sourcePosition: integer(input.sourcePosition, "source position", 0),
    representativePrimary: true as const,
    inputHash: hash(input.inputHash, "image work input"),
    revision: integer(input.revision, "image work revision", 1),
  });
}

function validatePrimaryImageFailureInput(input: PrimaryImageFailureCommitInput) {
  const queued = validateQueuedWorkInput(input);
  if (input.representation !== "canonical" && input.representation !== "observed_thumbnail") {
    throw new RangeError("image failure representation is invalid");
  }
  if (!( ["browser", "direct"] as const).includes(input.acquisitionMethod)) {
    throw new RangeError("image failure acquisition method is unsupported");
  }
  const errorCode = boundedDiagnostic(input.errorCode, "image failure code", 128);
  const errorMessage = boundedDiagnostic(input.errorMessage, "image failure message", 500);
  return Object.freeze({
    ...queued,
    representation: input.representation,
    acquisitionMethod: input.acquisitionMethod,
    errorCode,
    errorMessage,
    terminalUnavailable: input.terminalUnavailable === true,
  });
}

function boundedDiagnostic(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 identity`);
  }
  return value;
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 512 ||
    value !== value.trim() || /[\u0000-\u001f\u007f?#]/u.test(value) ||
    /^https?:\/\//iu.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as number;
}

function nullableInteger(value: unknown, label: string, minimum: number): number | null {
  return value === null ? null : integer(value, label, minimum);
}
