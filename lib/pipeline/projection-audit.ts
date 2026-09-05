import {
  hashCanonicalJson,
  serializeCanonicalJson,
  type Sha256Identity,
} from "../performance/generations";

export interface ExactAuditRow {
  readonly id: string;
  readonly value: unknown;
}

export interface ExactPopulationAudit {
  readonly canonicalCount: number;
  readonly canonicalOrderedHash: Sha256Identity;
  readonly projectionCount: number;
  readonly projectionOrderedHash: Sha256Identity;
  readonly mismatchCount: number;
  readonly differingIds: readonly string[];
  readonly differingIdsHash: Sha256Identity;
}

export interface ProjectionParityAudit {
  readonly rows: ExactPopulationAudit;
  readonly queue: ExactPopulationAudit;
  readonly mismatchCount: number;
  readonly differingIds: readonly string[];
  readonly differingIdsHash: Sha256Identity;
}

const MAX_AUDIT_ROWS = 500_000;

/**
 * Compares the complete exact population. Values are canonicalized for parity,
 * but only row identities and aggregate hashes leave this function.
 */
export async function auditExactPopulation(
  canonicalRows: readonly ExactAuditRow[],
  projectionRows: readonly ExactAuditRow[],
): Promise<ExactPopulationAudit> {
  const canonical = canonicalPopulation(canonicalRows, "canonical");
  const projection = canonicalPopulation(projectionRows, "projection");
  const differingIds: string[] = [];
  let left = 0;
  let right = 0;
  while (left < canonical.rows.length || right < projection.rows.length) {
    const canonicalRow = canonical.rows[left];
    const projectionRow = projection.rows[right];
    if (!canonicalRow) {
      differingIds.push(projectionRow!.id);
      right += 1;
    } else if (!projectionRow) {
      differingIds.push(canonicalRow.id);
      left += 1;
    } else if (canonicalRow.id < projectionRow.id) {
      differingIds.push(canonicalRow.id);
      left += 1;
    } else if (projectionRow.id < canonicalRow.id) {
      differingIds.push(projectionRow.id);
      right += 1;
    } else {
      if (canonicalRow.canonicalValue !== projectionRow.canonicalValue) {
        differingIds.push(canonicalRow.id);
      }
      left += 1;
      right += 1;
    }
  }
  return Object.freeze({
    canonicalCount: canonical.rows.length,
    canonicalOrderedHash: await hashCanonicalJson(canonical.hashInput),
    projectionCount: projection.rows.length,
    projectionOrderedHash: await hashCanonicalJson(projection.hashInput),
    mismatchCount: differingIds.length,
    differingIds: Object.freeze(differingIds),
    differingIdsHash: await hashCanonicalJson(differingIds),
  });
}

export async function auditProjectionParity(input: {
  readonly canonicalRows: readonly ExactAuditRow[];
  readonly projectionRows: readonly ExactAuditRow[];
  readonly expectedQueueRows: readonly ExactAuditRow[];
  readonly actualQueueRows: readonly ExactAuditRow[];
}): Promise<ProjectionParityAudit> {
  const [rows, queue] = await Promise.all([
    auditExactPopulation(input.canonicalRows, input.projectionRows),
    auditExactPopulation(input.expectedQueueRows, input.actualQueueRows),
  ]);
  const differingIds = [
    ...rows.differingIds.map((id) => `listing:${id}`),
    ...queue.differingIds.map((id) => `queue:${id}`),
  ].sort(compareText);
  return Object.freeze({
    rows,
    queue,
    mismatchCount: rows.mismatchCount + queue.mismatchCount,
    differingIds: Object.freeze(differingIds),
    differingIdsHash: await hashCanonicalJson(differingIds),
  });
}

function canonicalPopulation(rows: readonly ExactAuditRow[], label: string) {
  if (rows.length > MAX_AUDIT_ROWS) {
    throw new RangeError(`${label} audit exceeds ${MAX_AUDIT_ROWS} rows`);
  }
  const normalized = rows.map((row) => {
    const id = auditIdentity(row.id, `${label} row id`);
    return { id, canonicalValue: serializeCanonicalJson(row.value) };
  }).sort((left, right) => compareText(left.id, right.id));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.id === normalized[index]!.id) {
      throw new Error(`${label} audit repeats identity ${normalized[index]!.id}`);
    }
  }
  return {
    rows: normalized,
    hashInput: normalized.map((row) => [row.id, row.canonicalValue]),
  };
}

function auditIdentity(value: string, label: string): string {
  if (
    typeof value !== "string" || value.trim() !== value ||
    value.length < 1 || value.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is not a bounded canonical identity`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
