/** Prioritize new local work, then retry the oldest recoverable listing. */
export const NON_INLINE_RECOVERY_ORDER_SQL = `
  CASE WHEN current_inventory_new = 1 AND origin_priority = 1 THEN 0 ELSE 1 END,
  CASE WHEN origin_priority = 1 THEN 0 ELSE 1 END,
  CASE WHEN current_inventory_new = 1 THEN 0 ELSE 1 END,
  CASE WHEN recovery_state = 'retryable' THEN 1 ELSE 0 END,
  COALESCE(recovery_last_attempted_at, ''),
  discovered_at,
  id
`;

/** Oldest-first selection prevents freshness hints from starving retained work. */
export const NON_INLINE_RECOVERY_FAIRNESS_ORDER_SQL = `
  CASE WHEN recovery_state = 'retryable' THEN 1 ELSE 0 END,
  COALESCE(recovery_last_attempted_at, ''),
  discovered_at,
  id
`;
