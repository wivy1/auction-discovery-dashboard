/** Integrations express review scope through their normalized reviewCandidate flag. */
export function sourceCategoryInScope(
  _sourceId: string,
  _category: string | null | undefined,
): boolean {
  void _sourceId;
  void _category;
  return true;
}

export function sourceListingInScope(
  sourceId: string,
  category: string | null | undefined,
  _title: string,
): boolean {
  void _title;
  return sourceCategoryInScope(sourceId, category);
}
