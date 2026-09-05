/** Exact signed-int32 listing hash used to seed deterministic exploration. */
export function hashListingId(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}
