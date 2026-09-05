export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const textEncoder = new TextEncoder();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonInternal(
  value: unknown,
  ancestors: WeakSet<object>,
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON requires finite numbers");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(
        `Canonical JSON does not support values of type ${typeof value}`,
      );
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not support circular values");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError(
          "Canonical JSON arrays must be dense and have no extra enumerable properties",
        );
      }
      return `[${value
        .map((entry) => canonicalJsonInternal(entry, ancestors))
        .join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON requires plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON does not support symbol keys");
    }

    return `{${Object.keys(value)
      .sort(compareText)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonInternal(
            (value as Record<string, unknown>)[key],
            ancestors,
          )}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serializes strict JSON data with recursively sorted object keys. Unsupported
 * values fail instead of being silently dropped from an audit manifest.
 */
export function canonicalJson(value: unknown): string {
  return canonicalJsonInternal(value, new WeakSet());
}

/** Returns the lowercase SHA-256 hex digest of strict canonical JSON. */
export async function sha256CanonicalJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const UNKNOWN_PRE_M20 = "unknown_pre_m20" as const;

export type HistoricalExposureEvidence<T> =
  | { status: "observed"; value: T }
  | { status: typeof UNKNOWN_PRE_M20 };

export interface HistoricalReviewExposure {
  firstExposedAt: HistoricalExposureEvidence<string>;
  profileVersionId: HistoricalExposureEvidence<string>;
  visibilityPolicyVersion: HistoricalExposureEvidence<string>;
  originPostalCode: HistoricalExposureEvidence<string>;
  reviewPosition: HistoricalExposureEvidence<number>;
}

export type ReviewExposureDisposition =
  | "voted"
  | "unvoted_visible"
  | "unvoted_silently_omitted"
  | "not_currently_eligible";

export interface CurrentReviewExposure<
  TPolicyEvidence extends CanonicalJsonValue = CanonicalJsonValue,
> {
  observedAt: string;
  profileVersionId: string;
  visibilityPolicyVersion: string;
  originPostalCode: string;
  disposition: ReviewExposureDisposition;
  policyEvidence: TPolicyEvidence;
}

export interface TruthfulReviewExposure<
  TPolicyEvidence extends CanonicalJsonValue = CanonicalJsonValue,
> {
  current: CurrentReviewExposure<TPolicyEvidence>;
  historical: HistoricalReviewExposure;
}

function unknownPreM20<T>(): HistoricalExposureEvidence<T> {
  return { status: UNKNOWN_PRE_M20 };
}

/**
 * Makes every unavailable pre-instrumentation field explicit. This prevents a
 * current replay from being mistaken for an observed historical first view.
 */
export function unknownPreM20HistoricalExposure(): HistoricalReviewExposure {
  return {
    firstExposedAt: unknownPreM20(),
    profileVersionId: unknownPreM20(),
    visibilityPolicyVersion: unknownPreM20(),
    originPostalCode: unknownPreM20(),
    reviewPosition: unknownPreM20(),
  };
}

export function observedHistoricalExposure<T>(
  value: T,
): HistoricalExposureEvidence<T> {
  return { status: "observed", value };
}

export function truthfulPreM20Exposure<
  TPolicyEvidence extends CanonicalJsonValue,
>(
  current: CurrentReviewExposure<TPolicyEvidence>,
): TruthfulReviewExposure<TPolicyEvidence> {
  return {
    current,
    historical: unknownPreM20HistoricalExposure(),
  };
}

export type IdentityLink = readonly [leftId: string, rightId: string];

export interface DeterministicIdentityGroup {
  /** The lexically first member ID. */
  groupId: string;
  memberIds: string[];
}

function assertIdentity(value: string, context: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${context} must be a nonempty string`);
  }
}

/**
 * Finds connected identity components with stable member and group ordering.
 * All link endpoints must be declared members so incomplete input cannot be
 * hidden by implicit nodes.
 */
export function deterministicIdentityGroups(
  memberIds: Iterable<string>,
  links: Iterable<IdentityLink>,
): DeterministicIdentityGroup[] {
  const orderedMembers = Array.from(memberIds);
  const memberSet = new Set<string>();
  for (const memberId of orderedMembers) {
    assertIdentity(memberId, "Identity member");
    if (memberSet.has(memberId)) {
      throw new Error(`Duplicate identity member: ${memberId}`);
    }
    memberSet.add(memberId);
  }
  orderedMembers.sort(compareText);

  const parent = new Map(orderedMembers.map((memberId) => [memberId, memberId]));
  const find = (memberId: string): string => {
    let root = parent.get(memberId)!;
    while (root !== parent.get(root)) root = parent.get(root)!;
    let cursor = memberId;
    while (cursor !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const orderedLinks = Array.from(links, ([leftId, rightId]) => {
    assertIdentity(leftId, "Identity link endpoint");
    assertIdentity(rightId, "Identity link endpoint");
    if (!memberSet.has(leftId) || !memberSet.has(rightId)) {
      throw new Error(
        `Identity link endpoints must be declared members: ${leftId}, ${rightId}`,
      );
    }
    return compareText(leftId, rightId) <= 0
      ? ([leftId, rightId] as const)
      : ([rightId, leftId] as const);
  }).sort((left, right) =>
    compareText(left[0], right[0]) || compareText(left[1], right[1]),
  );

  for (const [leftId, rightId] of orderedLinks) {
    const leftRoot = find(leftId);
    const rightRoot = find(rightId);
    if (leftRoot === rightRoot) continue;
    const [root, child] =
      compareText(leftRoot, rightRoot) <= 0
        ? [leftRoot, rightRoot]
        : [rightRoot, leftRoot];
    parent.set(child, root);
  }

  const membersByRoot = new Map<string, string[]>();
  for (const memberId of orderedMembers) {
    const root = find(memberId);
    const members = membersByRoot.get(root) ?? [];
    members.push(memberId);
    membersByRoot.set(root, members);
  }

  return Array.from(membersByRoot.values(), (members) => ({
    groupId: members[0]!,
    memberIds: members,
  })).sort((left, right) => compareText(left.groupId, right.groupId));
}

export const DETERMINISTIC_PARTITION_ALGORITHM =
  "sha256-weighted-interval-v1" as const;

export interface WeightedPartition<TPartitionId extends string = string> {
  id: TPartitionId;
  weight: number;
}

export interface GroupPartitionAssignment<
  TPartitionId extends string = string,
> extends DeterministicIdentityGroup {
  partitionId: TPartitionId;
  assignmentHash: string;
}

function canonicalizeGroupsForPartition(
  groups: readonly DeterministicIdentityGroup[],
): DeterministicIdentityGroup[] {
  const groupIds = new Set<string>();
  const allMembers = new Set<string>();
  const canonicalGroups = groups.map((group) => {
    assertIdentity(group.groupId, "Identity group ID");
    if (groupIds.has(group.groupId)) {
      throw new Error(`Duplicate identity group ID: ${group.groupId}`);
    }
    groupIds.add(group.groupId);

    if (group.memberIds.length === 0) {
      throw new Error(`Identity group ${group.groupId} has no members`);
    }
    const memberIds = [...group.memberIds].sort(compareText);
    if (group.groupId !== memberIds[0]) {
      throw new Error(
        `Identity group ID must be its lexically first member: ${group.groupId}`,
      );
    }
    const localMembers = new Set<string>();
    for (const memberId of memberIds) {
      assertIdentity(memberId, `Identity group ${group.groupId} member`);
      if (localMembers.has(memberId)) {
        throw new Error(
          `Identity group ${group.groupId} repeats member ${memberId}`,
        );
      }
      if (allMembers.has(memberId)) {
        throw new Error(`Identity member belongs to multiple groups: ${memberId}`);
      }
      localMembers.add(memberId);
      allMembers.add(memberId);
    }
    return { groupId: group.groupId, memberIds };
  });
  return canonicalGroups.sort((left, right) =>
    compareText(left.groupId, right.groupId),
  );
}

/**
 * Assigns whole groups to caller-defined weighted partitions. The function has
 * no default split, class rule, or metric: seed, partition IDs, order, and
 * weights are all immutable caller inputs.
 */
export async function assignDeterministicGroupPartitions<
  TPartitionId extends string,
>(
  groups: readonly DeterministicIdentityGroup[],
  options: {
    seed: string;
    partitions: readonly WeightedPartition<TPartitionId>[];
  },
): Promise<GroupPartitionAssignment<TPartitionId>[]> {
  if (typeof options.seed !== "string") {
    throw new TypeError("Partition seed must be a string");
  }
  if (options.partitions.length === 0) {
    throw new Error("At least one caller-defined partition is required");
  }

  const partitionIds = new Set<string>();
  let totalWeight = 0;
  const partitions = options.partitions.map((partition) => {
    assertIdentity(partition.id, "Partition ID");
    if (partitionIds.has(partition.id)) {
      throw new Error(`Duplicate partition ID: ${partition.id}`);
    }
    if (!Number.isFinite(partition.weight) || partition.weight <= 0) {
      throw new TypeError(
        `Partition ${partition.id} weight must be finite and positive`,
      );
    }
    partitionIds.add(partition.id);
    totalWeight += partition.weight;
    return { id: partition.id, weight: partition.weight };
  });
  if (!Number.isFinite(totalWeight)) {
    throw new TypeError("Total partition weight must be finite");
  }

  const canonicalGroups = canonicalizeGroupsForPartition(groups);
  const assignments: GroupPartitionAssignment<TPartitionId>[] = [];
  for (const group of canonicalGroups) {
    const assignmentHash = await sha256CanonicalJson({
      algorithm: DETERMINISTIC_PARTITION_ALGORITHM,
      seed: options.seed,
      partitions,
      groupId: group.groupId,
      memberIds: group.memberIds,
    });
    const unitInterval =
      Number.parseInt(assignmentHash.slice(0, 13), 16) / 0x10_0000_0000_0000;
    const targetWeight = unitInterval * totalWeight;
    let cumulativeWeight = 0;
    let selected = partitions[partitions.length - 1]!;
    for (const partition of partitions) {
      cumulativeWeight += partition.weight;
      if (targetWeight < cumulativeWeight) {
        selected = partition;
        break;
      }
    }
    assignments.push({
      groupId: group.groupId,
      memberIds: group.memberIds,
      partitionId: selected.id,
      assignmentHash,
    });
  }
  return assignments;
}
