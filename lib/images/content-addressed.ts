import { hashCanonicalJson } from "../performance/generations.ts";

/** Readiness identity shared by the queue producer and exact image commit. */
export const CONTENT_ADDRESSED_IMAGE_REUSE_DERIVATION_VERSION =
  "content-addressed-image-reuse-v1" as const;

export const VALIDATED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

export type ValidatedImageMimeType =
  (typeof VALIDATED_IMAGE_MIME_TYPES)[number];

export type ImageContentAcquisitionMethod =
  | "browser"
  | "direct"
  | "content_reuse";

export interface ValidatedImageContentBlob {
  readonly contentHash: string;
  readonly mimeType: ValidatedImageMimeType;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly validationVersion: string;
  readonly validationHash: string;
  readonly pixelWidth: number | null;
  readonly pixelHeight: number | null;
  readonly lifecycleState: "active" | "missing" | "deleted";
  readonly firstAcquiredAt: string;
  readonly lastVerifiedAt: string;
  readonly deletedAt: string | null;
}

export interface ListingImageContentLink {
  readonly linkIdentity: string;
  readonly listingId: string;
  readonly listingImageId: string;
  readonly contentHash: string;
  readonly sourceImageIdentityHash: string;
  readonly sourcePosition: number;
  readonly representativePrimary: boolean;
  readonly acquisitionMethod: ImageContentAcquisitionMethod;
  readonly acquisitionProvenanceHash: string;
  readonly sourceInputHash: string;
  readonly linkedAt: string;
}

export interface ListingImageContentHead {
  readonly listingImageId: string;
  readonly listingId: string;
  readonly linkIdentity: string;
  readonly contentHash: string;
  readonly sourceInputHash: string;
  readonly representativePrimary: boolean;
  readonly generation: number;
  readonly updatedAt: string;
}

export interface ExpectedListingImageContentHead {
  readonly linkIdentity: string;
  readonly generation: number;
}

export type RegisterValidatedImageContentOutcome = {
  readonly outcome: "inserted" | "idempotent";
  readonly blob: ValidatedImageContentBlob;
};

export type ImageContentAcquisitionDecision =
  | {
      readonly decision: "reuse";
      readonly matchBasis:
        | "source_image_identity"
        | "source_image_identity_and_content_hash";
      readonly blob: ValidatedImageContentBlob;
    }
  | {
      readonly decision: "download";
      readonly reason:
        | "no_active_validated_source_match"
        | "ambiguous_source_identity"
        | "content_hash_not_yet_validated";
    };

export type LinkListingImageContentOutcome =
  | {
      readonly outcome: "linked" | "advanced" | "idempotent";
      readonly link: ListingImageContentLink;
      readonly head: ListingImageContentHead;
    }
  | {
      readonly outcome: "stale_head";
      readonly currentHead: ListingImageContentHead | null;
    }
  | { readonly outcome: "target_missed" };

interface BlobRow {
  content_hash: unknown;
  mime_type: unknown;
  byte_length: unknown;
  storage_key: unknown;
  validation_version: unknown;
  validation_hash: unknown;
  pixel_width: unknown;
  pixel_height: unknown;
  lifecycle_state: unknown;
  first_acquired_at: unknown;
  last_verified_at: unknown;
  deleted_at: unknown;
}

interface LinkRow {
  link_identity: unknown;
  listing_id: unknown;
  listing_image_id: unknown;
  content_hash: unknown;
  source_image_identity_hash: unknown;
  source_position: unknown;
  representative_primary: unknown;
  acquisition_method: unknown;
  acquisition_provenance_hash: unknown;
  source_input_hash: unknown;
  linked_at: unknown;
}

interface HeadRow {
  listing_image_id: unknown;
  listing_id: unknown;
  link_identity: unknown;
  content_hash: unknown;
  source_input_hash: unknown;
  representative_primary: unknown;
  generation: unknown;
  updated_at: unknown;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const blobColumns = `
  content_hash, mime_type, byte_length, storage_key, validation_version,
  validation_hash, pixel_width, pixel_height, lifecycle_state,
  first_acquired_at, last_verified_at, deleted_at
`;

const linkColumns = `
  link_identity, listing_id, listing_image_id, content_hash,
  source_image_identity_hash, source_position, representative_primary,
  acquisition_method, acquisition_provenance_hash, source_input_hash,
  linked_at
`;

const headColumns = `
  listing_image_id, listing_id, link_identity, content_hash,
  source_input_hash, representative_primary, generation, updated_at
`;

/**
 * Registers bytes only after the caller has validated their type, length, and
 * dimensions. A content hash and storage key are both single-assignment: a
 * retry may refresh verification time, but cannot silently rebind bytes or
 * validation evidence.
 */
export async function registerValidatedImageContent(input: {
  readonly database: D1Database;
  readonly contentHash: string;
  readonly mimeType: ValidatedImageMimeType;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly validationVersion: string;
  readonly validationHash: string;
  readonly pixelWidth: number | null;
  readonly pixelHeight: number | null;
  readonly now?: Date;
}): Promise<RegisterValidatedImageContentOutcome> {
  const contentHash = hash(input.contentHash, "content hash");
  const mimeType = imageMimeType(input.mimeType);
  const byteLength = integer(
    input.byteLength,
    "image byte length",
    1,
    MAX_IMAGE_BYTES,
  );
  const storageKey = safeStorageKey(input.storageKey);
  const validationVersion = code(
    input.validationVersion,
    "validation version",
    256,
  );
  const validationHash = hash(input.validationHash, "validation hash");
  const { width, height } = dimensions(input.pixelWidth, input.pixelHeight);
  const nowIso = validDate(input.now ?? new Date(), "verification time")
    .toISOString();

  const results = await input.database.batch([
    input.database.prepare(`
      INSERT INTO image_content_blobs (
        content_hash, hash_algorithm, mime_type, byte_length, storage_key,
        validation_version, validation_hash, pixel_width, pixel_height,
        lifecycle_state, first_acquired_at, last_verified_at
      ) VALUES (?, 'sha256', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(
      contentHash,
      mimeType,
      byteLength,
      storageKey,
      validationVersion,
      validationHash,
      width,
      height,
      nowIso,
      nowIso,
    ),
    input.database.prepare(`
      UPDATE image_content_blobs
      SET last_verified_at = CASE
        WHEN last_verified_at < ? THEN ? ELSE last_verified_at END
      WHERE content_hash = ? AND hash_algorithm = 'sha256'
        AND mime_type = ? AND byte_length = ? AND storage_key = ?
        AND validation_version = ? AND validation_hash = ?
        AND pixel_width IS ? AND pixel_height IS ?
        AND lifecycle_state = 'active' AND deleted_at IS NULL
    `).bind(
      nowIso,
      nowIso,
      contentHash,
      mimeType,
      byteLength,
      storageKey,
      validationVersion,
      validationHash,
      width,
      height,
    ),
    selectBlob(input.database, contentHash),
    input.database.prepare(`
      SELECT ${blobColumns}
      FROM image_content_blobs WHERE storage_key = ?
    `).bind(storageKey),
  ]);

  const blob = oneBlob(results[2]);
  const storageBlob = oneBlob(results[3]);
  if (blob === null) {
    if (storageBlob !== null) {
      throw new Error("image storage key is already bound to different content");
    }
    throw new Error("validated image content registration did not persist");
  }
  assertBlobMatches(blob, {
    contentHash,
    mimeType,
    byteLength,
    storageKey,
    validationVersion,
    validationHash,
    pixelWidth: width,
    pixelHeight: height,
  });
  if (changes(results[1]) !== 1) {
    throw new Error("content hash is already bound to different image evidence");
  }
  return {
    outcome: changes(results[0]) === 1 ? "inserted" : "idempotent",
    blob,
  };
}

/** Reads one globally content-addressed, currently reusable blob. */
export async function readValidatedImageContentByHash(
  database: D1Database,
  contentHashInput: string,
): Promise<ValidatedImageContentBlob | null> {
  const contentHash = hash(contentHashInput, "content hash");
  const row = await database.prepare(`
    SELECT ${blobColumns}
    FROM image_content_blobs
    WHERE content_hash = ? AND lifecycle_state = 'active'
      AND deleted_at IS NULL
  `).bind(contentHash).first<BlobRow>();
  return row === null ? null : blobFromRow(row);
}

/**
 * Decides reuse only from an active accepted head in the same source. Exact
 * content-hash lookup remains separately available when the caller already
 * possesses validated bytes; an identity from one source never authorizes a
 * reuse decision for another source.
 */
export async function decideImageContentAcquisition(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly sourceImageIdentityHash: string;
  readonly expectedContentHash?: string | null;
}): Promise<ImageContentAcquisitionDecision> {
  const sourceId = safeIdentity(input.sourceId, "source id", 512);
  const sourceImageIdentityHash = hash(
    input.sourceImageIdentityHash,
    "source image identity hash",
  );
  const expectedContentHash = input.expectedContentHash == null
    ? null
    : hash(input.expectedContentHash, "expected content hash");
  if (expectedContentHash === null) {
    return {
      decision: "download",
      reason: "content_hash_not_yet_validated",
    };
  }
  const result = await input.database.prepare(`
    SELECT DISTINCT ${blobColumns.split(",").map((column) =>
      `blob.${column.trim()}`
    ).join(", ")}
    FROM listing_image_content_heads AS head
    INNER JOIN listing_image_content_links AS link
      ON link.link_identity = head.link_identity
      AND link.listing_image_id = head.listing_image_id
      AND link.listing_id = head.listing_id
      AND link.content_hash = head.content_hash
      AND link.source_input_hash = head.source_input_hash
    INNER JOIN listing_stubs AS listing ON listing.id = head.listing_id
    INNER JOIN image_content_blobs AS blob
      ON blob.content_hash = head.content_hash
    WHERE listing.source_id = ?
      AND link.source_image_identity_hash = ?
      AND (? IS NULL OR blob.content_hash = ?)
      AND blob.lifecycle_state = 'active' AND blob.deleted_at IS NULL
    LIMIT 2
  `).bind(
    sourceId,
    sourceImageIdentityHash,
    expectedContentHash,
    expectedContentHash,
  ).all<BlobRow>();
  const blobs = (result.results ?? []).map(blobFromRow);
  if (blobs.length === 0) {
    return {
      decision: "download",
      reason: "no_active_validated_source_match",
    };
  }
  if (blobs.length > 1) {
    return { decision: "download", reason: "ambiguous_source_identity" };
  }
  return {
    decision: "reuse",
    matchBasis: expectedContentHash === null
      ? "source_image_identity"
      : "source_image_identity_and_content_hash",
    blob: blobs[0]!,
  };
}

/**
 * Appends one immutable source-image/content binding and compare-and-sets its
 * active per-listing-image head. Retrying the exact link is idempotent even if
 * the caller still supplies the pre-advance head; any different stale write is
 * refused without appending an orphan provenance link.
 */
export async function linkValidatedImageContent(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly listingId: string;
  readonly listingImageId: string;
  readonly contentHash: string;
  readonly sourceImageIdentityHash: string;
  readonly sourcePosition: number;
  readonly representativePrimary: boolean;
  readonly acquisitionMethod: ImageContentAcquisitionMethod;
  readonly acquisitionProvenanceHash: string;
  readonly sourceInputHash: string;
  readonly expectedHead: ExpectedListingImageContentHead | null;
  readonly now?: Date;
}): Promise<LinkListingImageContentOutcome> {
  const sourceId = safeIdentity(input.sourceId, "source id", 512);
  const listingId = safeIdentity(input.listingId, "listing id", 512);
  const listingImageId = safeIdentity(
    input.listingImageId,
    "listing image id",
    512,
  );
  const contentHash = hash(input.contentHash, "content hash");
  const sourceImageIdentityHash = hash(
    input.sourceImageIdentityHash,
    "source image identity hash",
  );
  const sourcePosition = integer(
    input.sourcePosition,
    "source image position",
    0,
  );
  if (typeof input.representativePrimary !== "boolean") {
    throw new TypeError("representative primary must be boolean");
  }
  const representativePrimary = input.representativePrimary ? 1 : 0;
  const acquisitionMethod = imageAcquisitionMethod(input.acquisitionMethod);
  const acquisitionProvenanceHash = hash(
    input.acquisitionProvenanceHash,
    "acquisition provenance hash",
  );
  const sourceInputHash = hash(input.sourceInputHash, "source input hash");
  const expected = expectedHead(input.expectedHead);
  const nowIso = validDate(input.now ?? new Date(), "link time").toISOString();
  const linkIdentity = await hashCanonicalJson({
    sourceId,
    listingId,
    listingImageId,
    contentHash,
    sourceImageIdentityHash,
    sourcePosition,
    representativePrimary: representativePrimary === 1,
    acquisitionMethod,
    acquisitionProvenanceHash,
    sourceInputHash,
    contract: "listing-image-content-link-v1",
  });
  const expectsNoHead = expected === null ? 1 : 0;
  const expectedLinkIdentity = expected?.linkIdentity ?? null;
  const expectedGeneration = expected?.generation ?? null;

  const targetExistsSql = `
    EXISTS (
      SELECT 1
      FROM listing_images AS image
      INNER JOIN listing_stubs AS listing ON listing.id = image.listing_id
      INNER JOIN image_content_blobs AS blob ON blob.content_hash = ?
      WHERE image.id = ? AND image.listing_id = ?
        AND image.position = ? AND image.is_primary = ?
        AND listing.source_id = ?
        AND blob.lifecycle_state = 'active' AND blob.deleted_at IS NULL
    )
  `;
  const headMatchesSql = `
    (
      (? = 1 AND NOT EXISTS (
        SELECT 1 FROM listing_image_content_heads
        WHERE listing_image_id = ?
      ))
      OR (? = 0 AND EXISTS (
        SELECT 1 FROM listing_image_content_heads
        WHERE listing_image_id = ? AND link_identity = ? AND generation = ?
      ))
      OR EXISTS (
        SELECT 1 FROM listing_image_content_heads
        WHERE listing_image_id = ? AND link_identity = ?
      )
    )
  `;
  const results = await input.database.batch([
    input.database.prepare(`
      INSERT INTO listing_image_content_links (
        link_identity, listing_id, listing_image_id, content_hash,
        source_image_identity_hash, source_position, representative_primary,
        acquisition_method, acquisition_provenance_hash, source_input_hash,
        linked_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${targetExistsSql} AND ${headMatchesSql}
      ON CONFLICT DO NOTHING
    `).bind(
      linkIdentity,
      listingId,
      listingImageId,
      contentHash,
      sourceImageIdentityHash,
      sourcePosition,
      representativePrimary,
      acquisitionMethod,
      acquisitionProvenanceHash,
      sourceInputHash,
      nowIso,
      contentHash,
      listingImageId,
      listingId,
      sourcePosition,
      representativePrimary,
      sourceId,
      expectsNoHead,
      listingImageId,
      expectsNoHead,
      listingImageId,
      expectedLinkIdentity,
      expectedGeneration,
      listingImageId,
      linkIdentity,
    ),
    input.database.prepare(`
      INSERT INTO listing_image_content_heads (
        listing_image_id, listing_id, link_identity, content_hash,
        source_input_hash, representative_primary, generation, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 1, ?
      WHERE ? = 1
        AND EXISTS (
          SELECT 1 FROM listing_image_content_links WHERE link_identity = ?
        )
      ON CONFLICT(listing_image_id) DO NOTHING
    `).bind(
      listingImageId,
      listingId,
      linkIdentity,
      contentHash,
      sourceInputHash,
      representativePrimary,
      nowIso,
      expectsNoHead,
      linkIdentity,
    ),
    input.database.prepare(`
      UPDATE listing_image_content_heads
      SET listing_id = ?, link_identity = ?, content_hash = ?,
          source_input_hash = ?, representative_primary = ?,
          generation = generation + 1, updated_at = ?
      WHERE ? = 0 AND listing_image_id = ?
        AND link_identity = ? AND generation = ?
        AND link_identity <> ?
        AND EXISTS (
          SELECT 1 FROM listing_image_content_links WHERE link_identity = ?
        )
    `).bind(
      listingId,
      linkIdentity,
      contentHash,
      sourceInputHash,
      representativePrimary,
      nowIso,
      expectsNoHead,
      listingImageId,
      expectedLinkIdentity,
      expectedGeneration,
      linkIdentity,
      linkIdentity,
    ),
    selectLink(input.database, linkIdentity),
    selectHead(input.database, listingImageId),
    input.database.prepare(`
      SELECT CASE WHEN ${targetExistsSql} THEN 1 ELSE 0 END AS target_exists
    `).bind(
      contentHash,
      listingImageId,
      listingId,
      sourcePosition,
      representativePrimary,
      sourceId,
    ),
  ]);

  const link = oneLink(results[3]);
  const head = oneHead(results[4]);
  const targetRows = (results[5]?.results ?? []) as unknown as Array<{
    target_exists: unknown;
  }>;
  if (Number(targetRows[0]?.target_exists ?? 0) !== 1) {
    return { outcome: "target_missed" };
  }
  if (link !== null && head?.linkIdentity === linkIdentity) {
    assertLinkMatches(link, {
      linkIdentity,
      listingId,
      listingImageId,
      contentHash,
      sourceImageIdentityHash,
      sourcePosition,
      representativePrimary: representativePrimary === 1,
      acquisitionMethod,
      acquisitionProvenanceHash,
      sourceInputHash,
    });
    return {
      outcome: changes(results[0]) === 0 && changes(results[1]) === 0 &&
          changes(results[2]) === 0
        ? "idempotent"
        : expected === null
        ? "linked"
        : "advanced",
      link,
      head,
    };
  }
  if (link !== null) {
    throw new Error("image content link was appended without advancing its head");
  }
  return { outcome: "stale_head", currentHead: head };
}

export async function readListingImageContentHead(
  database: D1Database,
  listingImageIdInput: string,
): Promise<ListingImageContentHead | null> {
  const listingImageId = safeIdentity(
    listingImageIdInput,
    "listing image id",
    512,
  );
  const row = await database.prepare(`
    SELECT ${headColumns}
    FROM listing_image_content_heads WHERE listing_image_id = ?
  `).bind(listingImageId).first<HeadRow>();
  return row === null ? null : headFromRow(row);
}

function selectBlob(database: D1Database, contentHash: string): D1PreparedStatement {
  return database.prepare(`
    SELECT ${blobColumns}
    FROM image_content_blobs WHERE content_hash = ?
  `).bind(contentHash);
}

function selectLink(database: D1Database, linkIdentity: string): D1PreparedStatement {
  return database.prepare(`
    SELECT ${linkColumns}
    FROM listing_image_content_links WHERE link_identity = ?
  `).bind(linkIdentity);
}

function selectHead(database: D1Database, listingImageId: string): D1PreparedStatement {
  return database.prepare(`
    SELECT ${headColumns}
    FROM listing_image_content_heads WHERE listing_image_id = ?
  `).bind(listingImageId);
}

function oneBlob(result: D1Result | undefined): ValidatedImageContentBlob | null {
  const rows = (result?.results ?? []) as unknown as BlobRow[];
  if (rows.length > 1) throw new Error("image content identity returned multiple rows");
  return rows[0] === undefined ? null : blobFromRow(rows[0]);
}

function oneLink(result: D1Result | undefined): ListingImageContentLink | null {
  const rows = (result?.results ?? []) as unknown as LinkRow[];
  if (rows.length > 1) throw new Error("image content link returned multiple rows");
  return rows[0] === undefined ? null : linkFromRow(rows[0]);
}

function oneHead(result: D1Result | undefined): ListingImageContentHead | null {
  const rows = (result?.results ?? []) as unknown as HeadRow[];
  if (rows.length > 1) throw new Error("image content head returned multiple rows");
  return rows[0] === undefined ? null : headFromRow(rows[0]);
}

function blobFromRow(row: BlobRow): ValidatedImageContentBlob {
  const contentHash = hash(row.content_hash, "stored content hash");
  const mimeType = imageMimeType(row.mime_type);
  const byteLength = integer(
    row.byte_length,
    "stored image byte length",
    1,
    MAX_IMAGE_BYTES,
  );
  const storageKey = safeStorageKey(row.storage_key);
  const validationVersion = code(
    row.validation_version,
    "stored validation version",
    256,
  );
  const validationHash = hash(row.validation_hash, "stored validation hash");
  const { width, height } = dimensions(row.pixel_width, row.pixel_height);
  const lifecycleState = row.lifecycle_state;
  if (!(["active", "missing", "deleted"] as const).includes(
    lifecycleState as "active" | "missing" | "deleted",
  )) {
    throw new TypeError("stored image lifecycle state is invalid");
  }
  const firstAcquiredAt = storedText(row.first_acquired_at, "first acquired time");
  const lastVerifiedAt = storedText(row.last_verified_at, "last verified time");
  const deletedAt = row.deleted_at === null
    ? null
    : storedText(row.deleted_at, "deleted time");
  return Object.freeze({
    contentHash,
    mimeType,
    byteLength,
    storageKey,
    validationVersion,
    validationHash,
    pixelWidth: width,
    pixelHeight: height,
    lifecycleState: lifecycleState as "active" | "missing" | "deleted",
    firstAcquiredAt,
    lastVerifiedAt,
    deletedAt,
  });
}

function linkFromRow(row: LinkRow): ListingImageContentLink {
  return Object.freeze({
    linkIdentity: hash(row.link_identity, "stored link identity"),
    listingId: safeIdentity(row.listing_id, "stored listing id", 512),
    listingImageId: safeIdentity(
      row.listing_image_id,
      "stored listing image id",
      512,
    ),
    contentHash: hash(row.content_hash, "stored content hash"),
    sourceImageIdentityHash: hash(
      row.source_image_identity_hash,
      "stored source image identity hash",
    ),
    sourcePosition: integer(
      row.source_position,
      "stored source image position",
      0,
    ),
    representativePrimary: storedBoolean(
      row.representative_primary,
      "stored representative primary",
    ),
    acquisitionMethod: imageAcquisitionMethod(row.acquisition_method),
    acquisitionProvenanceHash: hash(
      row.acquisition_provenance_hash,
      "stored acquisition provenance hash",
    ),
    sourceInputHash: hash(row.source_input_hash, "stored source input hash"),
    linkedAt: storedText(row.linked_at, "stored link time"),
  });
}

function headFromRow(row: HeadRow): ListingImageContentHead {
  return Object.freeze({
    listingImageId: safeIdentity(
      row.listing_image_id,
      "stored listing image id",
      512,
    ),
    listingId: safeIdentity(row.listing_id, "stored listing id", 512),
    linkIdentity: hash(row.link_identity, "stored link identity"),
    contentHash: hash(row.content_hash, "stored content hash"),
    sourceInputHash: hash(row.source_input_hash, "stored source input hash"),
    representativePrimary: storedBoolean(
      row.representative_primary,
      "stored representative primary",
    ),
    generation: integer(row.generation, "stored head generation", 1),
    updatedAt: storedText(row.updated_at, "stored head update time"),
  });
}

function assertBlobMatches(
  actual: ValidatedImageContentBlob,
  expected: Pick<
    ValidatedImageContentBlob,
    | "contentHash"
    | "mimeType"
    | "byteLength"
    | "storageKey"
    | "validationVersion"
    | "validationHash"
    | "pixelWidth"
    | "pixelHeight"
  >,
): void {
  if (
    actual.contentHash !== expected.contentHash ||
    actual.mimeType !== expected.mimeType ||
    actual.byteLength !== expected.byteLength ||
    actual.storageKey !== expected.storageKey ||
    actual.validationVersion !== expected.validationVersion ||
    actual.validationHash !== expected.validationHash ||
    actual.pixelWidth !== expected.pixelWidth ||
    actual.pixelHeight !== expected.pixelHeight ||
    actual.lifecycleState !== "active" ||
    actual.deletedAt !== null
  ) {
    throw new Error("content hash is already bound to different image evidence");
  }
}

function assertLinkMatches(
  actual: ListingImageContentLink,
  expected: Omit<ListingImageContentLink, "linkedAt">,
): void {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) {
      throw new Error("image content link identity is bound to different evidence");
    }
  }
}

function expectedHead(
  value: ExpectedListingImageContentHead | null,
): ExpectedListingImageContentHead | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new TypeError("expected head is invalid");
  return Object.freeze({
    linkIdentity: hash(value.linkIdentity, "expected link identity"),
    generation: integer(value.generation, "expected head generation", 1),
  });
}

function dimensions(
  widthInput: unknown,
  heightInput: unknown,
): { width: number | null; height: number | null } {
  if (widthInput === null && heightInput === null) {
    return { width: null, height: null };
  }
  if (widthInput === null || heightInput === null) {
    throw new RangeError("validated image dimensions must both be present or absent");
  }
  return {
    width: integer(widthInput, "image pixel width", 1),
    height: integer(heightInput, "image pixel height", 1),
  };
}

function imageMimeType(value: unknown): ValidatedImageMimeType {
  if (!(VALIDATED_IMAGE_MIME_TYPES as readonly unknown[]).includes(value)) {
    throw new RangeError("image MIME type is unsupported");
  }
  return value as ValidatedImageMimeType;
}

function imageAcquisitionMethod(value: unknown): ImageContentAcquisitionMethod {
  if (!(["browser", "direct", "content_reuse"] as const)
    .includes(value as ImageContentAcquisitionMethod)) {
    throw new RangeError("image acquisition method is unsupported");
  }
  return value as ImageContentAcquisitionMethod;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 identity`);
  }
  return value;
}

function safeStorageKey(value: unknown): string {
  const checked = boundedText(value, "image storage key", 1_024);
  if (
    !STORAGE_KEY_PATTERN.test(checked) ||
    checked.startsWith("/") ||
    checked.includes("\\") ||
    checked.includes("//") ||
    /[?#%]/u.test(checked) ||
    /^[A-Za-z]:/u.test(checked) ||
    checked.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new RangeError(
      "image storage key must be a safe relative object path without a query",
    );
  }
  return checked;
}

function safeIdentity(value: unknown, label: string, maximum: number): string {
  const checked = boundedText(value, label, maximum);
  if (/^https?:\/\//iu.test(checked) || /[?#]/u.test(checked)) {
    throw new RangeError(`${label} cannot contain a URL query or fragment`);
  }
  return checked;
}

function code(value: unknown, label: string, maximum: number): string {
  const checked = boundedText(value, label, maximum);
  if (!CODE_PATTERN.test(checked)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return checked;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new RangeError(`${label} must be a trimmed 1-${maximum} character string`);
  }
  return value;
}

function storedText(value: unknown, label: string): string {
  return boundedText(value, label, 1_024);
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function storedBoolean(value: unknown, label: string): boolean {
  const integerValue = integer(value, label, 0, 1);
  return integerValue === 1;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function changes(result: D1Result | undefined): number {
  return Math.max(0, Number(result?.meta.changes ?? 0));
}
