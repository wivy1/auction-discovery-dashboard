import {
  newListingSnapshotPolicy,
  type NewListingSnapshotPolicy,
} from "../dashboard-new-listings";

export class DiscoveryRunCancelledError extends Error {
  constructor() {
    super("Discovery run was cancelled by its caller");
    this.name = "DiscoveryRunCancelledError";
  }
}

export function isDiscoveryRunCancelled(
  error: unknown,
): error is DiscoveryRunCancelledError {
  return error instanceof DiscoveryRunCancelledError;
}

export function throwIfDiscoveryRunCancelled(
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw new DiscoveryRunCancelledError();
}

export function discoveryFailureSnapshotPolicy(
  error: unknown,
  input: {
    readonly sourceSpecific: boolean;
    readonly inventoryComplete: boolean;
  },
): NewListingSnapshotPolicy {
  return isDiscoveryRunCancelled(error)
    ? "preserve"
    : newListingSnapshotPolicy(input);
}
