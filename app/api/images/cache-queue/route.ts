import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../db/bootstrap";
import { HttpError, jsonError, parseLimit } from "../../../../lib/http";
import { CONTENT_ADDRESSED_IMAGE_REUSE_DERIVATION_VERSION } from "../../../../lib/images/content-addressed";
import { readQueuedPrimaryImageWorkInputs } from "../../../../lib/images/queue-reuse";
import { selectPrimaryImageArchiveTarget } from "../../../../lib/images/archive";
import { assertLocalImageClient } from "../../../../lib/local-request";
import { resolveDatabasePerformanceFeature } from "../../../../lib/performance/runtime-policy";
import { loadAcceptedPrimaryImageQueue } from "../../../../lib/pipeline/storage";
import { findSourceAdapter } from "../../../../lib/sources/registry";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertLocalImageClient(request);
    await ensureDatabase();

    const url = new URL(request.url);
    const requestedSourceId = url.searchParams.get("source");
    const sourceId = requestedSourceId?.trim();
    if (!sourceId || !findSourceAdapter(sourceId)) {
      throw new HttpError(
        "Image queue source is invalid",
        400,
        "invalid_source_id",
      );
    }
    const requestedImageId = url.searchParams.get("id");
    const imageId = requestedImageId === null ? null : requestedImageId.trim();
    if (
      requestedImageId !== null &&
      (!imageId || imageId.length > 512)
    ) {
      throw new HttpError(
        "Image identity is invalid",
        400,
        "invalid_image_id",
      );
    }
    const includeFailed = url.searchParams.get("includeFailed") === "true";
    const limit = imageId
      ? 1
      : parseLimit(url.searchParams.get("limit"), 10, 25);
    const images = await loadAcceptedPrimaryImageQueue({
      sourceId,
      imageId,
      includeFailed,
      requireExactWork: true,
      limit,
    });
    const imageReuse = await resolveDatabasePerformanceFeature({
      database: env.DB,
      feature: "contentAddressedImageReuse",
      derivationVersion: CONTENT_ADDRESSED_IMAGE_REUSE_DERIVATION_VERSION,
    });
    const workInputs = await readQueuedPrimaryImageWorkInputs({
      database: env.DB,
      listingImageIds: images.map((image) => image.id),
    });

    return Response.json(
      {
        images: images.map((image) => {
          const target = selectPrimaryImageArchiveTarget({
            sourceUrl: image.sourceUrl,
            thumbnailUrl: image.thumbnailUrl,
            previousDownloadErrorCode: image.downloadErrorCode,
          });
          return {
            id: image.id,
            listingId: image.listingId,
            source: image.source,
            sourceListingId: image.sourceListingId,
            listingTitle: image.listingTitle,
            listingUrl: image.listingUrl,
            sourceUrl: image.sourceUrl,
            fetchUrl: target.imageUrl,
            representation: target.representation ?? "canonical",
            downloadStatus: image.downloadStatus,
            acquisitionMethod: image.acquisitionMethod,
            attemptCount: image.attemptCount,
            lastAttemptedAt: image.lastAttemptedAt,
            downloadErrorCode: image.downloadErrorCode,
            workInputHash: workInputs.get(image.id)?.inputHash ?? null,
            workRevision: workInputs.get(image.id)?.revision ?? null,
            sourceImageIdentityHash:
              workInputs.get(image.id)?.sourceImageIdentityHash ?? null,
          };
        }),
        count: images.length,
        limit,
        sourceId,
        workMode: imageReuse.decision,
        exactImageId: imageId,
        includeFailed,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
