import { sha256CanonicalJson } from "../corpus-readiness/primitives.ts";

export const PREFERENCE_V2_RUNTIME_IDENTITY_VERSIONS = Object.freeze({
  physical: "preference-v2-physical-asset-cluster-v1",
  event: "preference-v2-source-authoritative-auction-event-v1",
  semantic: "preference-v2-semantic-family-v1",
});

export const PREFERENCE_V2_RUNTIME_IDENTITY_NAMESPACE_MAP =
  "preference-v2-runtime-identity-namespace-map-v1" as const;

export const PREFERENCE_V2_NIGHTLY_SINGLETON_IDENTITY_VERSION =
  "preference-v2-nightly-singleton-identity-v1" as const;

export interface PreferenceV2AcceptedRuntimeIdentity {
  readonly physicalAssetClusterId: `physical-asset:${string}`;
  readonly auctionEventBlockId: `auction-event:${string}`;
  readonly semanticFamilyId: `semantic-family:${string}`;
}

export interface PreferenceV2RuntimeIdentityInput {
  readonly listingId: string;
  readonly sourceId: string;
  readonly physicalAssetClusterId: string | null;
  readonly auctionEventBlockId: string | null;
  readonly semanticFamilyId: string | null;
}

export interface PreferenceV2ScoreInputRuntimeIdentity {
  readonly physicalAssetClusterId: `physical-asset:${string}` | null;
  readonly auctionEventBlockId: `auction-event:${string}` | null;
  readonly semanticFamilyId: `semantic-family:${string}` | null;
}

export const PREFERENCE_V2_LEGACY_NULL_SCORE_INPUT_IDENTITY = Object.freeze({
  physicalAssetClusterId: null,
  auctionEventBlockId: null,
  semanticFamilyId: null,
} satisfies PreferenceV2ScoreInputRuntimeIdentity);

async function deterministicSingletonIdentity(
  listingId: string,
  sourceId: string,
): Promise<PreferenceV2AcceptedRuntimeIdentity> {
  const digest = async (kind: "physical" | "event" | "family") =>
    await sha256CanonicalJson({
      version: PREFERENCE_V2_NIGHTLY_SINGLETON_IDENTITY_VERSION,
      kind,
      listingId,
      sourceId,
    });
  return {
    physicalAssetClusterId: `physical-asset:${await digest("physical")}`,
    auctionEventBlockId: `auction-event:${await digest("event")}`,
    semanticFamilyId: `semantic-family:${await digest("family")}`,
  };
}

/**
 * Resolves both sides of the runtime identity-import boundary to the accepted
 * identity namespaces used by snapshots and score-input hashes.
 */
export async function resolvePreferenceV2RuntimeIdentity(
  input: PreferenceV2RuntimeIdentityInput,
): Promise<PreferenceV2AcceptedRuntimeIdentity> {
  const identities = [
    input.physicalAssetClusterId,
    input.auctionEventBlockId,
    input.semanticFamilyId,
  ];
  const presentCount = identities.filter((identity) => identity !== null).length;
  if (presentCount !== 0 && presentCount !== identities.length) {
    throw new Error(`Preference V2 runtime identity tuple is partial for ${input.listingId}`);
  }

  if (presentCount === 0) {
    return deterministicSingletonIdentity(input.listingId, input.sourceId);
  }

  const physicalMatch = /^sha256:([0-9a-f]{64})$/u.exec(
    input.physicalAssetClusterId!,
  );
  const eventMatch = /^auction-event:([0-9a-f]{64})$/u.exec(
    input.auctionEventBlockId!,
  );
  const semanticMatch = /^semantic-family:([0-9a-f]{64})$/u.exec(
    input.semanticFamilyId!,
  );
  if (!physicalMatch || !eventMatch || !semanticMatch) {
    throw new Error(`Preference V2 runtime identity tuple is malformed for ${input.listingId}`);
  }
  return {
    physicalAssetClusterId: `physical-asset:${physicalMatch[1]}`,
    auctionEventBlockId: input.auctionEventBlockId as `auction-event:${string}`,
    semanticFamilyId: input.semanticFamilyId as `semantic-family:${string}`,
  };
}

/**
 * Preserves the historical null score-input identity only for an absent tuple
 * and its exact deterministic singleton import. Snapshots and imports continue
 * to use resolvePreferenceV2RuntimeIdentity's full accepted identities.
 */
export async function resolvePreferenceV2ScoreInputRuntimeIdentity(
  input: PreferenceV2RuntimeIdentityInput,
): Promise<PreferenceV2ScoreInputRuntimeIdentity> {
  const accepted = await resolvePreferenceV2RuntimeIdentity(input);
  const absent = input.physicalAssetClusterId === null &&
    input.auctionEventBlockId === null && input.semanticFamilyId === null;
  if (absent) return PREFERENCE_V2_LEGACY_NULL_SCORE_INPUT_IDENTITY;

  const singleton = await deterministicSingletonIdentity(
    input.listingId,
    input.sourceId,
  );
  if (
    accepted.physicalAssetClusterId === singleton.physicalAssetClusterId &&
    accepted.auctionEventBlockId === singleton.auctionEventBlockId &&
    accepted.semanticFamilyId === singleton.semanticFamilyId
  ) return PREFERENCE_V2_LEGACY_NULL_SCORE_INPUT_IDENTITY;
  return accepted;
}

/**
 * Lossless physical-identity namespace projection for the physical-cluster key constraint. Event and semantic identities fit
 * unchanged. Accepted source artifacts are never rewritten.
 */
export function mapAcceptedIdentityToRuntimeSha256(
  acceptedIdentity: string,
  expectedPrefix: "physical-asset",
): `sha256:${string}` {
  const match = new RegExp(`^${expectedPrefix}:([0-9a-f]{64})$`, "u")
    .exec(acceptedIdentity);
  if (!match) {
    throw new Error(`Accepted ${expectedPrefix} identity is malformed`);
  }
  return `sha256:${match[1]}`;
}
