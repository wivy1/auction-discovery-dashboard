import { createSequentialEnrichmentProviders } from "../ai";
import { enrichmentSessionProvenanceTarget } from "../enrichment/target";
import { readCompactPipelineGenerationVector } from "../performance/generations";
import { readActiveOrigin } from "../settings/active-origin";

export const UNRATED_PREFERENCE_CONTRACT_IDENTITY = "preference-unrated-v1";

export async function readCurrentPreferenceContractIdentity(
  database: D1Database,
): Promise<string> {
  const profile = await database.prepare(`
    SELECT id, algorithm_version FROM profile_versions
    ORDER BY version DESC, created_at DESC, id DESC LIMIT 1
  `).first<{ id: string; algorithm_version: string }>();
  if (profile === null) return UNRATED_PREFERENCE_CONTRACT_IDENTITY;
  if (!profile.id?.trim() || !profile.algorithm_version?.trim()) {
    throw new Error("preference profile contract is malformed");
  }
  return `${profile.id}:${profile.algorithm_version}`;
}

/** Reads active local identities without invoking any inference provider. */
export async function readCurrentProjectionContracts(database: D1Database) {
  const [origin, vector, enrichmentTarget, preferenceContractIdentity] = await Promise.all([
    readActiveOrigin(database),
    readCompactPipelineGenerationVector(database),
    enrichmentSessionProvenanceTarget(createSequentialEnrichmentProviders()),
    readCurrentPreferenceContractIdentity(database),
  ]);
  return Object.freeze({
    originPostalCode: origin.postalCode,
    originCountryCode: origin.countryCode,
    generationVectorHash: vector.hash,
    enrichmentTargetIdentity: enrichmentTarget.identity,
    preferenceContractIdentity,
  });
}
