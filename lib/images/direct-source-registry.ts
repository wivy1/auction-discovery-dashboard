import { listSourceManifests } from "../sources/registry";
import type { SourceId } from "../sources/types";

/** Only explicitly declared image hosts enable a direct image lane. */
export const SUPPORTED_DIRECT_IMAGE_SOURCE_IDS: readonly SourceId[] = Object.freeze(
  listSourceManifests().filter(manifest =>
    (manifest.acquisition ?? "direct") === "direct" &&
    (manifest.requests.allowedImageHosts?.length ?? 0) > 0,
  ).map(manifest => manifest.id),
);
export type DirectImageSourceId = SourceId;
export function isDirectImageSourceId(value: string): value is DirectImageSourceId {
  return SUPPORTED_DIRECT_IMAGE_SOURCE_IDS.includes(value);
}
