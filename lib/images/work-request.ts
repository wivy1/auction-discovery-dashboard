import { HttpError } from "../http";

export const IMAGE_REPRESENTATION_HEADER = "x-image-representation";
export const IMAGE_WORK_INPUT_HEADER = "x-image-work-input-hash";
export const IMAGE_WORK_REVISION_HEADER = "x-image-work-revision";
export const IMAGE_SOURCE_IDENTITY_HEADER = "x-image-source-identity-hash";

export type PrimaryImageRepresentation = "canonical" | "observed_thumbnail";

export interface PrimaryImageWorkRequestIdentity {
  readonly inputHash: string;
  readonly revision: number;
  readonly sourceImageIdentityHash: string;
}

export function parseOptionalImageRepresentation(
  request: Request,
): PrimaryImageRepresentation | null {
  const representation = request.headers.get(IMAGE_REPRESENTATION_HEADER);
  if (representation === null) return null;
  const normalized = representation.trim();
  if (normalized === "canonical" || normalized === "observed_thumbnail") {
    return normalized;
  }
  throw new HttpError(
    `${IMAGE_REPRESENTATION_HEADER} must be canonical or observed_thumbnail`,
    400,
    "invalid_image_representation",
  );
}

export function parseOptionalPrimaryImageWorkIdentity(
  request: Request,
): PrimaryImageWorkRequestIdentity | null {
  const inputHash = request.headers.get(IMAGE_WORK_INPUT_HEADER);
  const revisionText = request.headers.get(IMAGE_WORK_REVISION_HEADER);
  const sourceImageIdentityHash = request.headers.get(IMAGE_SOURCE_IDENTITY_HEADER);
  if (inputHash === null && revisionText === null && sourceImageIdentityHash === null) {
    return null;
  }
  const revision = Number(revisionText);
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(inputHash ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(sourceImageIdentityHash ?? "") ||
    !Number.isSafeInteger(revision) || revision < 1
  ) {
    throw new HttpError(
      "Image work headers must identify one exact queue revision",
      400,
      "invalid_image_work_identity",
    );
  }
  return Object.freeze({
    inputHash: inputHash!,
    revision,
    sourceImageIdentityHash: sourceImageIdentityHash!,
  });
}
