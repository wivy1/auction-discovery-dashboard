import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../../db/bootstrap";
import { HttpError, jsonError } from "../../../../../lib/http";
import {
  archiveImageBytes,
  selectPrimaryImageArchiveTarget,
  storeValidatedImageBytes,
  validateImageBytes,
} from "../../../../../lib/images/archive";
import {
  CONTENT_ADDRESSED_IMAGE_REUSE_DERIVATION_VERSION,
  readValidatedImageContentByHash,
  type ValidatedImageMimeType,
} from "../../../../../lib/images/content-addressed";
import {
  parseOptionalImageRepresentation,
  parseOptionalPrimaryImageWorkIdentity,
} from "../../../../../lib/images/work-request";
import {
  commitValidatedPrimaryImageWork,
  completeCanonicalPrimaryImageWork,
} from "../../../../../lib/images/queue-reuse";
import { assertLocalImageClient } from "../../../../../lib/local-request";
import { hashCanonicalJson } from "../../../../../lib/performance/generations";
import { resolveDatabasePerformanceFeature } from "../../../../../lib/performance/runtime-policy";
import {
  findAcceptedPrimaryImageById,
  inferImageDownloadErrorCode,
  markImageById,
} from "../../../../../lib/pipeline/storage";

export const dynamic = "force-dynamic";

const MAX_IMAGE_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACQUISITION_METHOD_HEADER = "x-image-acquisition-method";
const VALIDATION_VERSION = "image-byte-validation-v1";
const SUPPORTED_DECLARED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function parseAcquisitionMethod(request: Request): "browser" | "direct" {
  const method = request.headers.get(ACQUISITION_METHOD_HEADER)?.trim();
  if (method === "browser" || method === "direct") {
    return method;
  }
  throw new HttpError(
    `${ACQUISITION_METHOD_HEADER} must be browser or direct`,
    400,
    "invalid_acquisition_method",
  );
}

function validateDeclaredContentType(request: Request): string | null {
  const raw = request.headers.get("content-type");
  if (!raw) return null;
  const contentType = raw.split(";", 1)[0]!.trim().toLowerCase();
  if (SUPPORTED_DECLARED_CONTENT_TYPES.has(contentType)) {
    return contentType;
  }
  throw new HttpError(
    "Image content must use image/* or application/octet-stream",
    415,
    "image_unsupported_type",
  );
}

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const advertisedLength = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new HttpError(
      `Image exceeds the ${maxBytes}-byte archive limit`,
      413,
      "image_too_large",
    );
  }
  if (!request.body) {
    throw new HttpError("Image request body is empty", 400, "image_body_empty");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("image upload exceeded archive limit");
        throw new HttpError(
          `Image exceeds the ${maxBytes}-byte archive limit`,
          413,
          "image_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) {
    throw new HttpError("Image request body is empty", 400, "image_body_empty");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function archiveErrorStatus(code: string): number {
  if (code === "image_too_large") return 413;
  if (code === "image_unsupported_type") return 415;
  if (code === "image_signature_mismatch" || code === "image_body_empty") return 422;
  return 500;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalImageClient(request);
    const acquisitionMethod = parseAcquisitionMethod(request);
    const requestedRepresentation = parseOptionalImageRepresentation(request);
    const workInput = parseOptionalPrimaryImageWorkIdentity(request);
    await ensureDatabase();
    const imageReuse = workInput
      ? await resolveDatabasePerformanceFeature({
        database: env.DB,
        feature: "contentAddressedImageReuse",
        derivationVersion: CONTENT_ADDRESSED_IMAGE_REUSE_DERIVATION_VERSION,
      })
      : null;
    if (imageReuse?.decision === "shadow") {
      throw new HttpError(
        "Content-addressed image work is not ready for optimized commits",
        409,
        "image_work_not_ready",
      );
    }

    const { id: imageId } = await context.params;
    if (!imageId || imageId.length > 512) {
      throw new HttpError("Image identity is invalid", 400, "invalid_image_id");
    }
    const image = await findAcceptedPrimaryImageById(imageId);
    if (!image) {
      throw new HttpError(
        "Accepted primary image was not found",
        404,
        "image_not_found",
      );
    }

    if (image.downloadStatus === "downloaded" && image.localPath) {
      const existing = await env.STORAGE.head(image.localPath);
      if (existing) {
        if (workInput && imageReuse?.decision === "canonical") {
          const completed = await completeCanonicalPrimaryImageWork({
            database: env.DB,
            listingImageId: image.id,
            listingId: image.listingId,
            sourceId: image.source,
            sourceImageIdentityHash: workInput.sourceImageIdentityHash,
            sourcePosition: 0,
            representativePrimary: true,
            inputHash: workInput.inputHash,
            revision: workInput.revision,
          });
          if (completed.outcome === "stale_work") {
            throw new HttpError(
              "Image work revision changed before canonical completion",
              409,
              "image_work_stale",
            );
          }
        }
        return Response.json({
          imageId: image.id,
          listingId: image.listingId,
          localPath: image.localPath,
          localUrl: `/stored-images/${image.localPath.split("/").map(encodeURIComponent).join("/")}`,
          alreadyCached: true,
          ...(workInput && imageReuse?.decision === "canonical"
            ? {
                workInputHash: workInput.inputHash,
                workRevision: workInput.revision,
              }
            : {}),
        });
      }
    }

    const selectedArchiveTarget = selectPrimaryImageArchiveTarget({
      sourceUrl: image.sourceUrl,
      thumbnailUrl: image.thumbnailUrl,
      previousDownloadErrorCode: image.downloadErrorCode,
    });
    const selectedRepresentation =
      selectedArchiveTarget.representation ?? "canonical";
    if (
      requestedRepresentation !== null &&
      requestedRepresentation !== selectedRepresentation
    ) {
      throw new HttpError(
        "Image representation no longer matches the current stored image failure",
        409,
        "image_representation_stale",
      );
    }
    const archiveTarget = requestedRepresentation === null
      ? {
          imageUrl: image.sourceUrl,
          canonicalSourceUrl: undefined,
          representation: undefined,
        }
      : selectedArchiveTarget;

    try {
      const declaredContentType = validateDeclaredContentType(request);
      const body = await readBoundedRequestBody(request, MAX_IMAGE_UPLOAD_BYTES);
      if (workInput && imageReuse?.decision === "optimized") {
        const validated = await validateImageBytes({
          body,
          declaredContentType,
          maxBytes: MAX_IMAGE_UPLOAD_BYTES,
        });
        const validationHash = await hashCanonicalJson({
          contentHash: validated.contentHash,
          mimeType: validated.contentType,
          byteLength: validated.byteSize,
          pixelWidth: validated.width,
          pixelHeight: validated.height,
          validationVersion: VALIDATION_VERSION,
        });
        const existing = await readValidatedImageContentByHash(
          env.DB,
          validated.contentHash,
        );
        let reusedBytes = 0;
        if (existing) {
          if (
            existing.mimeType !== validated.contentType ||
            existing.byteLength !== validated.byteSize ||
            existing.storageKey !== validated.objectKey ||
            existing.validationVersion !== VALIDATION_VERSION ||
            existing.validationHash !== validationHash ||
            existing.pixelWidth !== validated.width ||
            existing.pixelHeight !== validated.height
          ) {
            throw new HttpError(
              "Validated image content conflicts with its immutable storage record",
              409,
              "image_content_conflict",
            );
          }
          const stored = await env.STORAGE.head(existing.storageKey);
          if (!stored || stored.size !== validated.byteSize) {
            throw new HttpError(
              "Validated image storage record is missing or inconsistent",
              409,
              "image_storage_record_mismatch",
            );
          }
          reusedBytes = validated.byteSize;
        } else {
          await storeValidatedImageBytes({
            storage: env.STORAGE,
            source: image.source,
            sourceListingId: image.sourceListingId,
            sourceUrl: archiveTarget.imageUrl,
            canonicalSourceUrl: archiveTarget.canonicalSourceUrl,
            representation: archiveTarget.representation,
            acquisitionMethod,
            declaredContentType,
            validated,
            includeSourceMetadata:
              archiveTarget.representation === "observed_thumbnail",
          });
        }
        const acquisitionProvenanceHash = await hashCanonicalJson({
          sourceId: image.source,
          listingId: image.listingId,
          listingImageId: image.id,
          sourceImageIdentityHash: workInput.sourceImageIdentityHash,
          inputHash: workInput.inputHash,
          revision: workInput.revision,
          acquisitionMethod,
          contentHash: validated.contentHash,
          contract: "primary-image-acquisition-provenance-v1",
        });
        const committed = await commitValidatedPrimaryImageWork({
          database: env.DB,
          listingImageId: image.id,
          listingId: image.listingId,
          sourceId: image.source,
          sourceImageIdentityHash: workInput.sourceImageIdentityHash,
          sourcePosition: 0,
          representativePrimary: true,
          inputHash: workInput.inputHash,
          revision: workInput.revision,
          contentHash: validated.contentHash,
          mimeType: validated.contentType as ValidatedImageMimeType,
          byteLength: validated.byteSize,
          storageKey: validated.objectKey,
          validationVersion: VALIDATION_VERSION,
          validationHash,
          pixelWidth: validated.width,
          pixelHeight: validated.height,
          acquisitionMethod,
          acquisitionProvenanceHash,
        });
        if (committed.outcome === "stale_work") {
          throw new HttpError(
            "Image work revision changed before commit",
            409,
            "image_work_stale",
          );
        }
        if (committed.outcome === "content_conflict") {
          throw new HttpError(
            "Validated image content conflicted during commit",
            409,
            "image_content_conflict",
          );
        }
        return Response.json({
          imageId: image.id,
          listingId: image.listingId,
          sourceListingId: image.sourceListingId,
          sourceUrl: image.sourceUrl,
          localPath: validated.objectKey,
          localUrl: `/stored-images/${validated.objectKey.split("/").map(encodeURIComponent).join("/")}`,
          sha256: validated.sha256,
          byteSize: validated.byteSize,
          contentType: validated.contentType,
          width: validated.width,
          height: validated.height,
          acquisitionMethod,
          alreadyCached: committed.outcome === "idempotent",
          downloadedBytes: validated.byteSize,
          reusedBytes,
          storedBytes: reusedBytes === 0 ? validated.byteSize : 0,
          workInputHash: workInput.inputHash,
          workRevision: workInput.revision,
        });
      }
      const archived = await archiveImageBytes({
        storage: env.STORAGE,
        source: image.source,
        sourceListingId: image.sourceListingId,
        sourceUrl: archiveTarget.imageUrl,
        canonicalSourceUrl: archiveTarget.canonicalSourceUrl,
        representation: archiveTarget.representation,
        body,
        declaredContentType,
        acquisitionMethod,
        maxBytes: MAX_IMAGE_UPLOAD_BYTES,
      });
      const updated = await markImageById(image.id, {
        status: "downloaded",
        acquisitionMethod,
        localPath: archived.objectKey,
        contentHash: archived.sha256,
        width: archived.width,
        height: archived.height,
      });
      if (!updated) {
        throw new HttpError(
          "Image identity disappeared before it could be updated",
          409,
          "image_update_conflict",
        );
      }

      if (workInput && imageReuse?.decision === "canonical") {
        const completed = await completeCanonicalPrimaryImageWork({
          database: env.DB,
          listingImageId: image.id,
          listingId: image.listingId,
          sourceId: image.source,
          sourceImageIdentityHash: workInput.sourceImageIdentityHash,
          sourcePosition: 0,
          representativePrimary: true,
          inputHash: workInput.inputHash,
          revision: workInput.revision,
        });
        if (completed.outcome === "stale_work") {
          throw new HttpError(
            "Image work revision changed before canonical completion",
            409,
            "image_work_stale",
          );
        }
      }

      return Response.json({
        imageId: image.id,
        listingId: image.listingId,
        sourceListingId: image.sourceListingId,
        sourceUrl: image.sourceUrl,
        localPath: archived.objectKey,
        localUrl: `/stored-images/${archived.objectKey.split("/").map(encodeURIComponent).join("/")}`,
        sha256: archived.sha256,
        byteSize: archived.byteSize,
        contentType: archived.contentType,
        width: archived.width,
        height: archived.height,
        acquisitionMethod,
        alreadyCached: false,
        ...(workInput && imageReuse?.decision === "canonical"
          ? {
              workInputHash: workInput.inputHash,
              workRevision: workInput.revision,
            }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof HttpError &&
        [
          "image_update_conflict",
          "image_work_stale",
          "image_content_conflict",
          "image_storage_record_mismatch",
        ].includes(error.code)
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Image archive failed";
      const errorCode = error instanceof HttpError
        ? error.code
        : inferImageDownloadErrorCode(message);
      await markImageById(image.id, {
        status: "failed",
        acquisitionMethod,
        error: message,
        errorCode,
      });
      if (error instanceof HttpError) throw error;
      throw new HttpError(message, archiveErrorStatus(errorCode), errorCode);
    }
  } catch (error) {
    return jsonError(error);
  }
}
