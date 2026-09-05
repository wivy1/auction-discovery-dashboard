import { type AppConfig, getConfig } from "../config";
import {
  evaluateSourcePermission,
  findSourceRegistration,
  listSourceManifests,
  sourceRegistrationAccessGrant,
  type SourceAccessGrant,
  type SourceId,
} from "../sources";
import { syncSourceManifests } from "../pipeline/storage";

/** Builds the access grant implied by local configuration for one source. */
export function configuredSourceAccessGrant(
  sourceId: SourceId,
  enabled: boolean,
  allowParserReadyCanary = false,
): SourceAccessGrant {
  return sourceRegistrationAccessGrant(findSourceRegistration(sourceId), enabled, allowParserReadyCanary);
}

/**
 * Seeds source rows before settings/dashboard reads, preserves runnable
 * operator switches, and clears any stale enabled bit for an unavailable source.
 */
export async function syncConfiguredSourceManifests(
  config: AppConfig = getConfig(),
) {
  const manifests = listSourceManifests();
  const accessAllowed = Object.fromEntries(manifests.map((manifest) => [
    manifest.id,
    evaluateSourcePermission(
      manifest,
      configuredSourceAccessGrant(manifest.id, true),
    ).allowed,
  ]));
  await syncSourceManifests(manifests, config.sources, accessAllowed);
  return manifests;
}
