export interface StoredStubIdentity {
  id: string;
  sourceId: string;
  sourceListingId: string;
  sourceUrl: string;
}

/** Stable source identity wins; the first canonical URL remains immutable. */
export function storedStubMatchesIdentity(
  stored: StoredStubIdentity | null | undefined,
  expected: StoredStubIdentity,
): boolean {
  return Boolean(
    stored &&
      stored.id === expected.id &&
      stored.sourceId === expected.sourceId &&
      stored.sourceListingId === expected.sourceListingId,
  );
}
