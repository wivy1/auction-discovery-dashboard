import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../../db/bootstrap";
import { HttpError, jsonError, readJson } from "../../../../../lib/http";
import {
  primaryImageFailureExhaustsArchiveTargets,
  selectPrimaryImageArchiveTarget,
} from "../../../../../lib/images/archive";
import { parseImageAcquisitionFailurePayload } from "../../../../../lib/images/browser-failure";
import {
  commitPrimaryImageFailure,
  readQueuedPrimaryImageWorkInputs,
} from "../../../../../lib/images/queue-reuse";
import {
  parseOptionalImageRepresentation,
  parseOptionalPrimaryImageWorkIdentity,
} from "../../../../../lib/images/work-request";
import { assertLocalImageClient } from "../../../../../lib/local-request";
import {
  findAcceptedPrimaryImageById,
  markImageById,
} from "../../../../../lib/pipeline/storage";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalImageClient(request);
    const requestedRepresentation = parseOptionalImageRepresentation(request);
    const requestedWork = parseOptionalPrimaryImageWorkIdentity(request);
    if ((requestedRepresentation === null) !== (requestedWork === null)) {
      throw new HttpError(
        "Image failure representation and work identity must be supplied together",
        400,
        "invalid_image_failure_identity",
      );
    }
    await ensureDatabase();

    const { id: imageId } = await context.params;
    if (!imageId || imageId.length > 512) {
      throw new HttpError("Image identity is invalid", 400, "invalid_image_id");
    }
    const payload = parseImageAcquisitionFailurePayload(await readJson<unknown>(request));
    
    const image = await findAcceptedPrimaryImageById(imageId);
    if (!image) {
      throw new HttpError(
        "Accepted primary image was not found",
        404,
        "image_not_found",
      );
    }
    if (image.downloadStatus === "downloaded" && image.localPath) {
      throw new HttpError(
        "Image is already cached locally",
        409,
        "image_already_cached",
      );
    }
    if (requestedWork && requestedRepresentation) {
      const queuedWork = (await readQueuedPrimaryImageWorkInputs({
        database: env.DB,
        listingImageIds: [image.id],
      })).get(image.id);
      if (
        !queuedWork ||
        queuedWork.listingId !== image.listingId ||
        queuedWork.sourceId !== image.source ||
        queuedWork.inputHash !== requestedWork.inputHash ||
        queuedWork.revision !== requestedWork.revision ||
        queuedWork.sourceImageIdentityHash !== requestedWork.sourceImageIdentityHash
      ) {
        throw new HttpError(
          "Image work revision changed before its failure could be recorded",
          409,
          "image_work_stale",
        );
      }
      const selectedTarget = selectPrimaryImageArchiveTarget({
        sourceUrl: image.sourceUrl,
        thumbnailUrl: image.thumbnailUrl,
        previousDownloadErrorCode: image.downloadErrorCode,
      });
      const selectedRepresentation = selectedTarget.representation ?? "canonical";
      if (requestedRepresentation !== selectedRepresentation) {
        throw new HttpError(
          "Image representation no longer matches the current stored image failure",
          409,
          "image_representation_stale",
        );
      }
      const terminalUnavailable = payload.acquisitionMethod === "direct" &&
        primaryImageFailureExhaustsArchiveTargets({
          sourceUrl: image.sourceUrl,
          thumbnailUrl: image.thumbnailUrl,
          attemptedRepresentation: requestedRepresentation,
          errorCode: payload.errorCode,
        });
      const committed = await commitPrimaryImageFailure({
        database: env.DB,
        ...queuedWork,
        representation: requestedRepresentation,
        acquisitionMethod: payload.acquisitionMethod,
        errorCode: payload.errorCode,
        errorMessage: payload.message,
        terminalUnavailable,
      });
      if (committed.outcome === "stale_work") {
        throw new HttpError(
          "Image work revision changed before its failure could be committed",
          409,
          "image_work_stale",
        );
      }
      return Response.json({
        imageId: image.id,
        listingId: image.listingId,
        status: "failed",
        errorCode: payload.errorCode,
        attemptCount: committed.attemptCount,
        terminalUnavailable: committed.terminalUnavailable,
      });
    }
    const updated = await markImageById(image.id, {
      status: "failed",
      acquisitionMethod: payload.acquisitionMethod,
      errorCode: payload.errorCode,
      error: payload.message,
    });
    if (!updated) {
      throw new HttpError(
        "Image identity disappeared before it could be updated",
        409,
        "image_update_conflict",
      );
    }

    return Response.json({
      imageId: image.id,
      listingId: image.listingId,
      status: "failed",
      errorCode: payload.errorCode,
      attemptCount: image.attemptCount + 1,
    });
  } catch (error) {
    return jsonError(error);
  }
}
