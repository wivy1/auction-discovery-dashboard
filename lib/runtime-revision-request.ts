import { HttpError } from "./http";
import {
  loadedRuntimeRevision,
  RUNTIME_REVISION_HEADER,
  RUNTIME_REVISION_MISMATCH_MESSAGE,
  RuntimeRevisionError,
} from "./runtime-revision";

/** Fail closed before a revision-bound local request can parse or mutate state. */
export function assertMatchingLoadedRuntimeRevision(request: Request): void {
  let loaded: string;
  try {
    loaded = loadedRuntimeRevision();
  } catch (error) {
    if (error instanceof RuntimeRevisionError) {
      throw new HttpError(
        "The loaded local runtime revision is unavailable",
        503,
        "runtime_revision_unavailable",
      );
    }
    throw error;
  }
  if (request.headers.get(RUNTIME_REVISION_HEADER) !== loaded) {
    throw new HttpError(
      RUNTIME_REVISION_MISMATCH_MESSAGE,
      409,
      "runtime_revision_mismatch",
    );
  }
}
