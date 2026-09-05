import {
  hashCanonicalJson,
  serializeCanonicalJson,
} from "../performance/generations";

export type SourceAcquisitionReservationState =
  | "reserved"
  | "acquired"
  | "committed"
  | "stale"
  | "failed"
  | "expired";

export type SourceAcquiredBundleState =
  | "acquired"
  | "validated"
  | "committed"
  | "discarded";

export interface SourceAcquisitionReservation {
  readonly reservationId: string;
  readonly sourceId: string;
  readonly requestRole: string;
  readonly requestIdentity: string;
  readonly pageOrPartitionIdentity: string | null;
  readonly priorCheckpointIdentity: string | null;
  readonly adapterVersion: string;
  readonly proofVersion: string;
  readonly laneKey: string;
  readonly expectedGeneration: number;
  readonly inputHash: string;
  readonly inputRevision: number;
  readonly requestBudget: number;
  readonly requestsConsumed: number;
  readonly leaseOwner: string;
  readonly expiresAt: string;
  readonly state: SourceAcquisitionReservationState;
  readonly failureCode: string | null;
  readonly failureFingerprint: string | null;
  readonly createdAt: string;
  readonly acquiredAt: string | null;
  readonly committedAt: string | null;
  readonly updatedAt: string;
}

export interface SourceAcquisitionClaimIdentity {
  readonly reservationId: string;
  readonly sourceId: string;
  readonly laneKey: string;
  readonly leaseOwner: string;
  readonly expectedGeneration: number;
  readonly inputHash: string;
  readonly inputRevision: number;
}

export interface SourceAcquiredBundle {
  readonly bundleIdentity: string;
  readonly reservationId: string;
  readonly sourceId: string;
  readonly requestIdentity: string;
  readonly responseHash: string;
  readonly contentHash: string;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly byteLength: number;
  readonly bodyStorageKey: string | null;
  readonly parserVersion: string;
  readonly validationVersion: string;
  readonly validatedMetadata: Readonly<Record<string, unknown>>;
  readonly state: SourceAcquiredBundleState;
  readonly acquiredAt: string;
  readonly validatedAt: string | null;
  readonly committedAt: string | null;
  readonly discardedAt: string | null;
}

export type ReserveSourceAcquisitionOutcome =
  | {
      readonly outcome: "reserved" | "already_reserved";
      readonly reservation: SourceAcquisitionReservation;
    }
  | {
      readonly outcome: "lane_contended";
      readonly activeReservation: SourceAcquisitionReservation;
    }
  | {
      readonly outcome: "generation_changed";
      readonly currentGeneration: number | null;
    };

export type SourceAcquisitionRenewOutcome =
  | { readonly outcome: "renewed"; readonly expiresAt: string }
  | { readonly outcome: "claim_missed" };

export type SourceAcquisitionReleaseOutcome =
  | { readonly outcome: "released"; readonly state: "stale" | "failed" }
  | { readonly outcome: "claim_missed" };

export type PutSourceAcquiredBundleOutcome =
  | {
      readonly outcome: "inserted" | "idempotent";
      readonly bundle: SourceAcquiredBundle;
    }
  | { readonly outcome: "claim_missed" };

export type CommitSourceAcquisitionOutcome =
  | { readonly outcome: "committed"; readonly bundleIdentity: string }
  | { readonly outcome: "claim_missed" | "bundle_missed" };

interface ReservationRow {
  reservation_id: string;
  source_id: string;
  request_role: string;
  request_identity: string;
  page_or_partition_identity: string | null;
  prior_checkpoint_identity: string | null;
  adapter_version: string;
  proof_version: string;
  lane_key: string;
  expected_generation: number;
  input_hash: string;
  input_revision: number;
  request_budget: number;
  requests_consumed: number;
  lease_owner: string;
  expires_at: string;
  state: string;
  failure_code: string | null;
  failure_fingerprint: string | null;
  created_at: string;
  acquired_at: string | null;
  committed_at: string | null;
  updated_at: string;
}

interface BundleRow {
  bundle_identity: string;
  reservation_id: string;
  source_id: string;
  request_identity: string;
  response_hash: string;
  content_hash: string;
  content_type: string;
  content_encoding: string | null;
  byte_length: number;
  body_storage_key: string | null;
  parser_version: string;
  validation_version: string;
  validated_metadata_json: string;
  state: string;
  acquired_at: string;
  validated_at: string | null;
  committed_at: string | null;
  discarded_at: string | null;
}

const reservationColumns = `
  reservation_id, source_id, request_role, request_identity,
  page_or_partition_identity, prior_checkpoint_identity,
  adapter_version, proof_version, lane_key, expected_generation,
  input_hash, input_revision, request_budget, requests_consumed,
  lease_owner, expires_at, state, failure_code, failure_fingerprint,
  created_at, acquired_at, committed_at, updated_at
`;

const bundleColumns = `
  bundle_identity, reservation_id, source_id, request_identity,
  response_hash, content_hash, content_type, content_encoding, byte_length,
  body_storage_key, parser_version, validation_version,
  validated_metadata_json, state, acquired_at, validated_at, committed_at,
  discarded_at
`;

const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const SENSITIVE_KEY_PATTERN = /^(?:authorization|cookie|credentials?|password|secret|signature|signed[_-]?url|token)$/iu;

/**
 * Claims one exact source/lane under a short D1 writer boundary. Expired
 * reservations are terminalized before the conditional insert, so a later
 * worker receives a new reservation token rather than reviving an old lease.
 */
export async function reserveSourceAcquisition(input: {
  readonly database: D1Database;
  readonly reservationId: string;
  readonly sourceId: string;
  readonly requestRole: string;
  readonly requestIdentity: string;
  readonly pageOrPartitionIdentity?: string | null;
  readonly priorCheckpointIdentity?: string | null;
  readonly adapterVersion: string;
  readonly proofVersion: string;
  readonly laneKey: string;
  readonly expectedGeneration: number;
  readonly inputHash: string;
  readonly inputRevision: number;
  readonly requestBudget: number;
  readonly leaseOwner: string;
  readonly leaseMs: number;
  readonly now?: Date;
}): Promise<ReserveSourceAcquisitionOutcome> {
  const reservationId = code(input.reservationId, "reservation id", 256);
  const sourceId = text(input.sourceId, "source id", 512);
  const requestRole = code(input.requestRole, "request role", 128);
  const requestIdentity = safeIdentity(input.requestIdentity, "request identity", 512);
  const pageIdentity = optionalIdentity(
    input.pageOrPartitionIdentity,
    "page or partition identity",
  );
  const priorCheckpoint = optionalIdentity(
    input.priorCheckpointIdentity,
    "prior checkpoint identity",
  );
  const adapterVersion = code(input.adapterVersion, "adapter version", 256);
  const proofVersion = code(input.proofVersion, "proof version", 256);
  const laneKey = code(input.laneKey, "lane key", 256);
  const expectedGeneration = integer(input.expectedGeneration, "expected generation", 1);
  const inputHash = hash(input.inputHash, "input hash");
  const inputRevision = integer(input.inputRevision, "input revision", 1);
  const requestBudget = integer(input.requestBudget, "request budget", 1, 10_000);
  const leaseOwner = code(input.leaseOwner, "lease owner", 256);
  const leaseMs = integer(input.leaseMs, "lease duration", 1, MAX_LEASE_MS);
  const now = date(input.now ?? new Date(), "reservation time");
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();

  const results = await input.database.batch([
    input.database.prepare(`
      INSERT INTO source_acquisition_state (source_id, generation, updated_at)
      VALUES (?, 1, ?) ON CONFLICT(source_id) DO NOTHING
    `).bind(sourceId, nowIso),
    input.database.prepare(`
      UPDATE source_acquisition_reservations
      SET state = 'expired', updated_at = ?
      WHERE source_id = ? AND lane_key = ?
        AND state IN ('reserved', 'acquired') AND expires_at <= ?
    `).bind(nowIso, sourceId, laneKey, nowIso),
    input.database.prepare(`
      UPDATE source_acquired_bundles
      SET state = 'discarded', discarded_at = ?
      WHERE state IN ('acquired', 'validated')
        AND reservation_id IN (
          SELECT reservation_id FROM source_acquisition_reservations
          WHERE source_id = ? AND lane_key = ? AND state = 'expired'
        )
    `).bind(nowIso, sourceId, laneKey),
    input.database.prepare(`
      INSERT INTO source_acquisition_reservations (
        reservation_id, source_id, request_role, request_identity,
        page_or_partition_identity, prior_checkpoint_identity,
        adapter_version, proof_version, lane_key, expected_generation,
        input_hash, input_revision, request_budget, lease_owner, expires_at,
        created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM source_acquisition_reservations
        WHERE source_id = ? AND lane_key = ?
          AND state IN ('reserved', 'acquired') AND expires_at > ?
      )
        AND EXISTS (
          SELECT 1 FROM source_acquisition_state
          WHERE source_id = ? AND generation = ?
        )
      ON CONFLICT(reservation_id) DO NOTHING
    `).bind(
      reservationId, sourceId, requestRole, requestIdentity, pageIdentity,
      priorCheckpoint, adapterVersion, proofVersion, laneKey,
      expectedGeneration, inputHash, inputRevision, requestBudget, leaseOwner,
      expiresAt, nowIso, nowIso, sourceId, laneKey, nowIso,
      sourceId, expectedGeneration,
    ),
    selectReservation(input.database, reservationId),
    input.database.prepare(`
      SELECT ${reservationColumns}
      FROM source_acquisition_reservations
      WHERE source_id = ? AND lane_key = ?
        AND state IN ('reserved', 'acquired') AND expires_at > ?
      ORDER BY created_at, reservation_id LIMIT 1
    `).bind(sourceId, laneKey, nowIso),
    input.database.prepare(`
      SELECT generation FROM source_acquisition_state WHERE source_id = ?
    `).bind(sourceId),
  ]);
  const own = optionalReservation(results[4]);
  if (own !== null && (own.state === "reserved" || own.state === "acquired")) {
    assertReservationMatches(own, {
      reservationId, sourceId, requestRole, requestIdentity, pageIdentity,
      priorCheckpoint, adapterVersion, proofVersion, laneKey,
      expectedGeneration, inputHash, inputRevision, requestBudget, leaseOwner,
    });
    return {
      outcome: changes(results[3]) === 1 ? "reserved" : "already_reserved",
      reservation: own,
    };
  }
  const active = optionalReservation(results[5]);
  if (active !== null) return { outcome: "lane_contended", activeReservation: active };
  const generationRows = (results[6]?.results ?? []) as unknown as Array<{
    generation: number;
  }>;
  return {
    outcome: "generation_changed",
    currentGeneration: generationRows[0] === undefined
      ? null
      : Number(generationRows[0].generation),
  };
}

/** Extends only the exact, live reservation token. */
export async function renewSourceAcquisitionReservation(input: {
  readonly database: D1Database;
  readonly claim: SourceAcquisitionClaimIdentity;
  readonly leaseMs: number;
  readonly now?: Date;
}): Promise<SourceAcquisitionRenewOutcome> {
  const claim = validateClaim(input.claim);
  const leaseMs = integer(input.leaseMs, "lease duration", 1, MAX_LEASE_MS);
  const now = date(input.now ?? new Date(), "renewal time");
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = await input.database.prepare(`
    UPDATE source_acquisition_reservations
    SET expires_at = ?, updated_at = ?
    WHERE reservation_id = ? AND source_id = ? AND lane_key = ?
      AND lease_owner = ? AND expected_generation = ?
      AND input_hash = ? AND input_revision = ?
      AND state IN ('reserved', 'acquired') AND expires_at > ?
  `).bind(
    expiresAt, now.toISOString(), claim.reservationId, claim.sourceId,
    claim.laneKey, claim.leaseOwner, claim.expectedGeneration,
    claim.inputHash, claim.inputRevision, now.toISOString(),
  ).run();
  return changes(result) === 1
    ? { outcome: "renewed", expiresAt }
    : { outcome: "claim_missed" };
}

/** Releases an exact live claim as sanitized stale or failed evidence. */
export async function releaseSourceAcquisitionReservation(input: {
  readonly database: D1Database;
  readonly claim: SourceAcquisitionClaimIdentity;
  readonly state: "stale" | "failed";
  readonly failureCode: string;
  readonly failureFingerprint: string;
  readonly now?: Date;
}): Promise<SourceAcquisitionReleaseOutcome> {
  const claim = validateClaim(input.claim);
  const failureCode = code(input.failureCode, "failure code", 128);
  const failureFingerprint = hash(input.failureFingerprint, "failure fingerprint");
  const nowIso = date(input.now ?? new Date(), "release time").toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE source_acquisition_reservations
      SET state = ?, failure_code = ?, failure_fingerprint = ?, updated_at = ?
      WHERE reservation_id = ? AND source_id = ? AND lane_key = ?
        AND lease_owner = ? AND expected_generation = ?
        AND input_hash = ? AND input_revision = ?
        AND state IN ('reserved', 'acquired') AND expires_at > ?
    `).bind(
      input.state, failureCode, failureFingerprint, nowIso,
      claim.reservationId, claim.sourceId, claim.laneKey, claim.leaseOwner,
      claim.expectedGeneration, claim.inputHash, claim.inputRevision, nowIso,
    ),
    input.database.prepare(`
      UPDATE source_acquired_bundles
      SET state = 'discarded', discarded_at = ?
      WHERE reservation_id = ? AND state IN ('acquired', 'validated')
        AND EXISTS (
          SELECT 1 FROM source_acquisition_reservations
          WHERE reservation_id = ? AND state = ?
        )
    `).bind(nowIso, claim.reservationId, claim.reservationId, input.state),
  ]);
  return changes(results[0]) === 1
    ? { outcome: "released", state: input.state }
    : { outcome: "claim_missed" };
}

/**
 * Persists one validated, content-addressed bundle and moves its exact live
 * reservation to acquired. Canonical metadata is bounded and rejects secret
 * fields and signed/full query URLs before it reaches durable storage.
 */
export async function putSourceAcquiredBundle(input: {
  readonly database: D1Database;
  readonly claim: SourceAcquisitionClaimIdentity;
  readonly responseHash: string;
  readonly contentHash: string;
  readonly contentType: string;
  readonly contentEncoding?: string | null;
  readonly byteLength: number;
  readonly bodyStorageKey?: string | null;
  readonly parserVersion: string;
  readonly validationVersion: string;
  readonly validatedMetadata: Readonly<Record<string, unknown>>;
  readonly requestsConsumed: number;
  readonly now?: Date;
}): Promise<PutSourceAcquiredBundleOutcome> {
  const claim = validateClaim(input.claim);
  const reservation = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  const now = date(input.now ?? new Date(), "bundle acquisition time");
  if (!isLiveClaim(reservation, claim, now)) return { outcome: "claim_missed" };
  const responseHash = hash(input.responseHash, "response hash");
  const contentHash = hash(input.contentHash, "content hash");
  const contentType = text(input.contentType, "content type", 256);
  const contentEncoding = optionalCode(input.contentEncoding, "content encoding", 64);
  const byteLength = integer(input.byteLength, "bundle byte length", 0, MAX_BODY_BYTES);
  const bodyStorageKey = optionalStorageKey(input.bodyStorageKey);
  const parserVersion = code(input.parserVersion, "parser version", 256);
  const validationVersion = code(input.validationVersion, "validation version", 256);
  const metadataJson = validatedMetadataJson(input.validatedMetadata);
  const requestsConsumed = integer(
    input.requestsConsumed,
    "requests consumed",
    0,
    reservation.requestBudget,
  );
  const bundleIdentity = await hashCanonicalJson({
    reservationId: claim.reservationId,
    sourceId: claim.sourceId,
    requestIdentity: reservation.requestIdentity,
    responseHash,
    contentHash,
    contentType,
    contentEncoding,
    byteLength,
    parserVersion,
    validationVersion,
    validatedMetadata: JSON.parse(metadataJson) as unknown,
  });
  const nowIso = now.toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      INSERT INTO source_acquired_bundles (
        bundle_identity, reservation_id, source_id, request_identity,
        response_hash, content_hash, content_type, content_encoding,
        byte_length, body_storage_key, parser_version, validation_version,
        validated_metadata_json, state, acquired_at, validated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM source_acquisition_reservations
        WHERE reservation_id = ? AND source_id = ? AND lane_key = ?
          AND lease_owner = ? AND expected_generation = ?
          AND input_hash = ? AND input_revision = ?
          AND state IN ('reserved', 'acquired') AND expires_at > ?
      )
      ON CONFLICT(bundle_identity) DO NOTHING
    `).bind(
      bundleIdentity, claim.reservationId, claim.sourceId,
      reservation.requestIdentity, responseHash, contentHash, contentType,
      contentEncoding, byteLength, bodyStorageKey, parserVersion,
      validationVersion, metadataJson, nowIso, nowIso,
      claim.reservationId, claim.sourceId, claim.laneKey, claim.leaseOwner,
      claim.expectedGeneration, claim.inputHash, claim.inputRevision, nowIso,
    ),
    input.database.prepare(`
      UPDATE source_acquisition_reservations
      SET state = 'acquired', requests_consumed = ?, acquired_at = COALESCE(acquired_at, ?),
          updated_at = ?
      WHERE reservation_id = ? AND source_id = ? AND lane_key = ?
        AND lease_owner = ? AND expected_generation = ?
        AND input_hash = ? AND input_revision = ?
        AND state IN ('reserved', 'acquired') AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM source_acquired_bundles
          WHERE reservation_id = ? AND bundle_identity = ?
        )
    `).bind(
      requestsConsumed, nowIso, nowIso, claim.reservationId, claim.sourceId,
      claim.laneKey, claim.leaseOwner, claim.expectedGeneration,
      claim.inputHash, claim.inputRevision, nowIso, claim.reservationId,
      bundleIdentity,
    ),
    selectBundle(input.database, bundleIdentity),
  ]);
  const bundle = optionalBundle(results[2]);
  if (bundle === null || changes(results[1]) !== 1) return { outcome: "claim_missed" };
  assertBundleMatches(bundle, {
    bundleIdentity, reservationId: claim.reservationId, sourceId: claim.sourceId,
    requestIdentity: reservation.requestIdentity, responseHash, contentHash,
    contentType, contentEncoding, byteLength, bodyStorageKey, parserVersion,
    validationVersion, metadataJson,
  });
  return {
    outcome: changes(results[0]) === 1 ? "inserted" : "idempotent",
    bundle,
  };
}

/**
 * Atomically hands one validated bundle to the canonical writer. Both the
 * reservation and bundle compare-and-set, so an expired/reclaimed token or a
 * different bundle can never advance commit state.
 */
export async function commitSourceAcquisitionReservation(input: {
  readonly database: D1Database;
  readonly claim: SourceAcquisitionClaimIdentity;
  readonly bundleIdentity: string;
  readonly currentGeneration: number;
  readonly now?: Date;
}): Promise<CommitSourceAcquisitionOutcome> {
  const claim = validateClaim(input.claim);
  const bundleIdentity = hash(input.bundleIdentity, "bundle identity");
  const currentGeneration = integer(input.currentGeneration, "current generation", 1);
  if (currentGeneration !== claim.expectedGeneration) {
    return await committedAcquisitionMatches(input.database, claim, bundleIdentity)
      ? { outcome: "committed", bundleIdentity }
      : { outcome: "claim_missed" };
  }
  const nowIso = date(input.now ?? new Date(), "commit time").toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE source_acquired_bundles
      SET state = 'committed', committed_at = ?
      WHERE bundle_identity = ? AND reservation_id = ? AND source_id = ?
        AND state = 'validated'
        AND EXISTS (
          SELECT 1 FROM source_acquisition_reservations
          WHERE reservation_id = ? AND source_id = ? AND lane_key = ?
            AND lease_owner = ? AND expected_generation = ?
            AND input_hash = ? AND input_revision = ?
            AND state = 'acquired' AND expires_at > ?
            AND EXISTS (
              SELECT 1 FROM source_acquisition_state
              WHERE source_id = ? AND generation = ?
            )
        )
    `).bind(
      nowIso, bundleIdentity, claim.reservationId, claim.sourceId,
      claim.reservationId, claim.sourceId, claim.laneKey, claim.leaseOwner,
      claim.expectedGeneration, claim.inputHash, claim.inputRevision, nowIso,
      claim.sourceId, claim.expectedGeneration,
    ),
    input.database.prepare(`
      UPDATE source_acquisition_reservations
      SET state = 'committed', committed_at = ?, updated_at = ?
      WHERE reservation_id = ? AND source_id = ? AND lane_key = ?
        AND lease_owner = ? AND expected_generation = ?
        AND input_hash = ? AND input_revision = ?
        AND state = 'acquired' AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM source_acquired_bundles
          WHERE bundle_identity = ? AND reservation_id = ? AND state = 'committed'
        )
    `).bind(
      nowIso, nowIso, claim.reservationId, claim.sourceId, claim.laneKey,
      claim.leaseOwner, claim.expectedGeneration, claim.inputHash,
      claim.inputRevision, nowIso, bundleIdentity, claim.reservationId,
    ),
    input.database.prepare(`
      UPDATE source_acquisition_state
      SET generation = generation + 1, updated_at = ?
      WHERE source_id = ? AND generation = ?
        AND EXISTS (
          SELECT 1 FROM source_acquisition_reservations r
          JOIN source_acquired_bundles b ON b.reservation_id = r.reservation_id
          WHERE r.reservation_id = ? AND r.source_id = ? AND r.lane_key = ?
            AND r.lease_owner = ? AND r.expected_generation = ?
            AND r.input_hash = ? AND r.input_revision = ?
            AND r.state = 'committed' AND r.committed_at = ?
            AND b.bundle_identity = ? AND b.source_id = r.source_id
            AND b.state = 'committed' AND b.committed_at = r.committed_at
        )
    `).bind(
      nowIso, claim.sourceId, claim.expectedGeneration,
      claim.reservationId, claim.sourceId, claim.laneKey, claim.leaseOwner,
      claim.expectedGeneration, claim.inputHash, claim.inputRevision, nowIso,
      bundleIdentity,
    ),
  ]);
  if (changes(results[0]) === 0) {
    if (await committedAcquisitionMatches(input.database, claim, bundleIdentity)) {
      return { outcome: "committed", bundleIdentity };
    }
    const bundle = await readSourceAcquiredBundle(input.database, bundleIdentity);
    return bundle === null ? { outcome: "bundle_missed" } : { outcome: "claim_missed" };
  }
  if (changes(results[1]) !== 1 || changes(results[2]) !== 1) {
    throw new Error("bundle commit did not commit its matching reservation and generation");
  }
  return { outcome: "committed", bundleIdentity };
}

async function committedAcquisitionMatches(
  database: D1Database,
  claim: SourceAcquisitionClaimIdentity,
  bundleIdentity: string,
): Promise<boolean> {
  const result = await database.prepare(`
    SELECT 1 AS committed
    FROM source_acquisition_reservations r
    JOIN source_acquired_bundles b ON b.reservation_id = r.reservation_id
    JOIN source_acquisition_state s ON s.source_id = r.source_id
    WHERE r.reservation_id = ? AND r.source_id = ? AND r.lane_key = ?
      AND r.lease_owner = ? AND r.expected_generation = ?
      AND r.input_hash = ? AND r.input_revision = ?
      AND r.state = 'committed' AND b.state = 'committed'
      AND b.bundle_identity = ? AND b.source_id = r.source_id
      AND b.committed_at = r.committed_at AND s.generation > r.expected_generation
  `).bind(
    claim.reservationId, claim.sourceId, claim.laneKey, claim.leaseOwner,
    claim.expectedGeneration, claim.inputHash, claim.inputRevision, bundleIdentity,
  ).first<{ committed: number }>();
  return result?.committed === 1;
}

/** The initial acquisition generation exists logically before its first claim. */
export async function readSourceAcquisitionGeneration(
  database: D1Database,
  sourceId: string,
): Promise<number> {
  const result = await database.prepare(`
    SELECT generation FROM source_acquisition_state WHERE source_id = ?
  `).bind(text(sourceId, "source id", 512)).first<{ generation: number }>();
  return result === null ? 1 : integer(Number(result.generation), "stored acquisition generation", 1);
}

export async function expireSourceAcquisitionReservations(input: {
  readonly database: D1Database;
  readonly sourceId?: string;
  readonly laneKey?: string;
  readonly now?: Date;
}): Promise<number> {
  const nowIso = date(input.now ?? new Date(), "expiry time").toISOString();
  const filters: string[] = [];
  const bindings: string[] = [nowIso];
  if (input.sourceId !== undefined) {
    filters.push("source_id = ?");
    bindings.push(text(input.sourceId, "source id", 512));
  }
  if (input.laneKey !== undefined) {
    filters.push("lane_key = ?");
    bindings.push(code(input.laneKey, "lane key", 256));
  }
  bindings.push(nowIso);
  const [expired, discarded] = await input.database.batch([
    input.database.prepare(`
      UPDATE source_acquisition_reservations
      SET state = 'expired', updated_at = ?
      WHERE state IN ('reserved', 'acquired')
        ${filters.length === 0 ? "" : `AND ${filters.join(" AND ")}`}
        AND expires_at <= ?
    `).bind(...bindings),
    input.database.prepare(`
      UPDATE source_acquired_bundles
      SET state = 'discarded', discarded_at = ?
      WHERE state IN ('acquired', 'validated')
        AND reservation_id IN (
          SELECT reservation_id FROM source_acquisition_reservations
          WHERE state = 'expired' AND expires_at <= ?
        )
    `).bind(nowIso, nowIso),
  ]);
  void discarded;
  return changes(expired);
}

export async function readSourceAcquisitionReservation(
  database: D1Database,
  reservationId: string,
): Promise<SourceAcquisitionReservation | null> {
  const result = await selectReservation(
    database,
    code(reservationId, "reservation id", 256),
  ).first<ReservationRow>();
  return result === null ? null : mapReservation(result);
}

export async function readSourceAcquiredBundle(
  database: D1Database,
  bundleIdentity: string,
): Promise<SourceAcquiredBundle | null> {
  const result = await selectBundle(
    database,
    hash(bundleIdentity, "bundle identity"),
  ).first<BundleRow>();
  return result === null ? null : mapBundle(result);
}

export function sourceAcquisitionClaimIdentity(
  reservation: SourceAcquisitionReservation,
): SourceAcquisitionClaimIdentity {
  if (reservation.state !== "reserved" && reservation.state !== "acquired") {
    throw new Error("source acquisition reservation is not claimable");
  }
  return Object.freeze({
    reservationId: reservation.reservationId,
    sourceId: reservation.sourceId,
    laneKey: reservation.laneKey,
    leaseOwner: reservation.leaseOwner,
    expectedGeneration: reservation.expectedGeneration,
    inputHash: reservation.inputHash,
    inputRevision: reservation.inputRevision,
  });
}

function selectReservation(database: D1Database, id: string): D1PreparedStatement {
  return database.prepare(`
    SELECT ${reservationColumns}
    FROM source_acquisition_reservations WHERE reservation_id = ?
  `).bind(id);
}

function selectBundle(database: D1Database, id: string): D1PreparedStatement {
  return database.prepare(`
    SELECT ${bundleColumns}
    FROM source_acquired_bundles WHERE bundle_identity = ?
  `).bind(id);
}

function optionalReservation(result: D1Result | undefined): SourceAcquisitionReservation | null {
  const rows = (result?.results ?? []) as unknown as ReservationRow[];
  if (rows.length > 1) throw new Error("reservation identity returned multiple rows");
  return rows[0] === undefined ? null : mapReservation(rows[0]);
}

function optionalBundle(result: D1Result | undefined): SourceAcquiredBundle | null {
  const rows = (result?.results ?? []) as unknown as BundleRow[];
  if (rows.length > 1) throw new Error("bundle identity returned multiple rows");
  return rows[0] === undefined ? null : mapBundle(rows[0]);
}

function mapReservation(row: ReservationRow): SourceAcquisitionReservation {
  if (!(["reserved", "acquired", "committed", "stale", "failed", "expired"] as const)
    .includes(row.state as SourceAcquisitionReservationState)) {
    throw new Error("stored source acquisition reservation state is invalid");
  }
  return Object.freeze({
    reservationId: row.reservation_id,
    sourceId: row.source_id,
    requestRole: row.request_role,
    requestIdentity: row.request_identity,
    pageOrPartitionIdentity: row.page_or_partition_identity,
    priorCheckpointIdentity: row.prior_checkpoint_identity,
    adapterVersion: row.adapter_version,
    proofVersion: row.proof_version,
    laneKey: row.lane_key,
    expectedGeneration: Number(row.expected_generation),
    inputHash: row.input_hash,
    inputRevision: Number(row.input_revision),
    requestBudget: Number(row.request_budget),
    requestsConsumed: Number(row.requests_consumed),
    leaseOwner: row.lease_owner,
    expiresAt: row.expires_at,
    state: row.state as SourceAcquisitionReservationState,
    failureCode: row.failure_code,
    failureFingerprint: row.failure_fingerprint,
    createdAt: row.created_at,
    acquiredAt: row.acquired_at,
    committedAt: row.committed_at,
    updatedAt: row.updated_at,
  });
}

function mapBundle(row: BundleRow): SourceAcquiredBundle {
  if (!(["acquired", "validated", "committed", "discarded"] as const)
    .includes(row.state as SourceAcquiredBundleState)) {
    throw new Error("stored source acquired bundle state is invalid");
  }
  return Object.freeze({
    bundleIdentity: row.bundle_identity,
    reservationId: row.reservation_id,
    sourceId: row.source_id,
    requestIdentity: row.request_identity,
    responseHash: row.response_hash,
    contentHash: row.content_hash,
    contentType: row.content_type,
    contentEncoding: row.content_encoding,
    byteLength: Number(row.byte_length),
    bodyStorageKey: row.body_storage_key,
    parserVersion: row.parser_version,
    validationVersion: row.validation_version,
    validatedMetadata: Object.freeze(
      JSON.parse(row.validated_metadata_json) as Record<string, unknown>,
    ),
    state: row.state as SourceAcquiredBundleState,
    acquiredAt: row.acquired_at,
    validatedAt: row.validated_at,
    committedAt: row.committed_at,
    discardedAt: row.discarded_at,
  });
}

function validateClaim(claim: SourceAcquisitionClaimIdentity): SourceAcquisitionClaimIdentity {
  return Object.freeze({
    reservationId: code(claim.reservationId, "reservation id", 256),
    sourceId: text(claim.sourceId, "source id", 512),
    laneKey: code(claim.laneKey, "lane key", 256),
    leaseOwner: code(claim.leaseOwner, "lease owner", 256),
    expectedGeneration: integer(claim.expectedGeneration, "expected generation", 1),
    inputHash: hash(claim.inputHash, "input hash"),
    inputRevision: integer(claim.inputRevision, "input revision", 1),
  });
}

function isLiveClaim(
  reservation: SourceAcquisitionReservation | null,
  claim: SourceAcquisitionClaimIdentity,
  now: Date,
): reservation is SourceAcquisitionReservation {
  return reservation !== null &&
    (reservation.state === "reserved" || reservation.state === "acquired") &&
    Date.parse(reservation.expiresAt) > now.getTime() &&
    reservation.sourceId === claim.sourceId &&
    reservation.laneKey === claim.laneKey &&
    reservation.leaseOwner === claim.leaseOwner &&
    reservation.expectedGeneration === claim.expectedGeneration &&
    reservation.inputHash === claim.inputHash &&
    reservation.inputRevision === claim.inputRevision;
}

function assertReservationMatches(
  actual: SourceAcquisitionReservation,
  expected: {
    reservationId: string;
    sourceId: string;
    requestRole: string;
    requestIdentity: string;
    pageIdentity: string | null;
    priorCheckpoint: string | null;
    adapterVersion: string;
    proofVersion: string;
    laneKey: string;
    expectedGeneration: number;
    inputHash: string;
    inputRevision: number;
    requestBudget: number;
    leaseOwner: string;
  },
): void {
  const matches = actual.reservationId === expected.reservationId &&
    actual.sourceId === expected.sourceId &&
    actual.requestRole === expected.requestRole &&
    actual.requestIdentity === expected.requestIdentity &&
    actual.pageOrPartitionIdentity === expected.pageIdentity &&
    actual.priorCheckpointIdentity === expected.priorCheckpoint &&
    actual.adapterVersion === expected.adapterVersion &&
    actual.proofVersion === expected.proofVersion &&
    actual.laneKey === expected.laneKey &&
    actual.expectedGeneration === expected.expectedGeneration &&
    actual.inputHash === expected.inputHash &&
    actual.inputRevision === expected.inputRevision &&
    actual.requestBudget === expected.requestBudget &&
    actual.leaseOwner === expected.leaseOwner;
  if (!matches) throw new Error("reservation id is already bound to different input");
}

function assertBundleMatches(
  actual: SourceAcquiredBundle,
  expected: {
    bundleIdentity: string;
    reservationId: string;
    sourceId: string;
    requestIdentity: string;
    responseHash: string;
    contentHash: string;
    contentType: string;
    contentEncoding: string | null;
    byteLength: number;
    bodyStorageKey: string | null;
    parserVersion: string;
    validationVersion: string;
    metadataJson: string;
  },
): void {
  const matches = actual.bundleIdentity === expected.bundleIdentity &&
    actual.reservationId === expected.reservationId &&
    actual.sourceId === expected.sourceId &&
    actual.requestIdentity === expected.requestIdentity &&
    actual.responseHash === expected.responseHash &&
    actual.contentHash === expected.contentHash &&
    actual.contentType === expected.contentType &&
    actual.contentEncoding === expected.contentEncoding &&
    actual.byteLength === expected.byteLength &&
    actual.bodyStorageKey === expected.bodyStorageKey &&
    actual.parserVersion === expected.parserVersion &&
    actual.validationVersion === expected.validationVersion &&
    serializeCanonicalJson(actual.validatedMetadata) === expected.metadataJson;
  if (!matches) throw new Error("bundle identity is already bound to different content");
}

function validatedMetadataJson(value: Readonly<Record<string, unknown>>): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("validated metadata must be an object");
  }
  rejectSensitiveMetadata(value);
  const serialized = serializeCanonicalJson(value);
  if (new TextEncoder().encode(serialized).byteLength > 65_536) {
    throw new RangeError("validated metadata exceeds 65536 UTF-8 bytes");
  }
  return serialized;
}

function rejectSensitiveMetadata(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && containsQueryUrl(value)) {
      throw new RangeError("validated metadata cannot contain a full query URL");
    }
    return;
  }
  if (seen.has(value)) throw new RangeError("validated metadata cannot contain cycles");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new RangeError("validated metadata cannot contain secret-bearing fields");
    }
    rejectSensitiveMetadata(child, seen);
  }
  seen.delete(value);
}

function containsQueryUrl(value: string): boolean {
  return /https?:\/\/[^\s?#]+\?[^\s#]*/iu.test(value);
}

function optionalStorageKey(value?: string | null): string | null {
  if (value == null) return null;
  const checked = text(value, "body storage key", 1_024);
  if (/^https?:\/\//iu.test(checked) || /[?#]/u.test(checked)) {
    throw new RangeError("body storage key cannot be a URL or contain a query");
  }
  return checked;
}

function safeIdentity(value: string, label: string, maximum: number): string {
  const checked = text(value, label, maximum);
  if (/^https?:\/\//iu.test(checked) || /\?/u.test(checked)) {
    throw new RangeError(`${label} cannot be a full URL or contain a query`);
  }
  return checked;
}

function optionalIdentity(value: string | null | undefined, label: string): string | null {
  return value == null ? null : safeIdentity(value, label, 512);
}

function optionalCode(value: string | null | undefined, label: string, maximum: number): string | null {
  return value == null ? null : code(value, label, maximum);
}

function hash(value: string, label: string): string {
  const checked = text(value, label, 71);
  if (!SHA256_PATTERN.test(checked)) throw new RangeError(`${label} must be a SHA-256 identity`);
  return checked;
}

function code(value: string, label: string, maximum: number): string {
  const checked = text(value, label, maximum);
  if (!CODE_PATTERN.test(checked)) throw new RangeError(`${label} contains unsupported characters`);
  return checked;
}

function text(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${label} must be a trimmed 1-${maximum} character string`);
  }
  return value;
}

function integer(value: number, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function date(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function changes(result: D1Result | undefined): number {
  return Math.max(0, Number(result?.meta.changes ?? 0));
}
