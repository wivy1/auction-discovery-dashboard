import type {
  GenerationCapacity,
  TextGenerationProvider,
} from "../ai/types";

export type GenerationCapacityEvidence =
  | "configured_single_slot"
  | "capability_unavailable"
  | "capability_probe_failed"
  | "capability_probe_timed_out"
  | GenerationCapacity["evidence"];

export interface VerifiedTextGenerationCapacity {
  readonly configuredConcurrency: 1 | 2;
  readonly verifiedProviderCapacity: 1 | 2;
  readonly effectiveConcurrency: 1 | 2;
  readonly providerSlots: number | null;
  readonly evidence: GenerationCapacityEvidence;
}

export async function verifyTextGenerationCapacity(input: {
  readonly configuredConcurrency: 1 | 2;
  readonly provider: TextGenerationProvider;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<VerifiedTextGenerationCapacity> {
  throwIfAborted(input.signal);
  if (input.configuredConcurrency === 1) {
    return result(input.configuredConcurrency, 1, null, "configured_single_slot");
  }
  if (input.provider.generationCapacity === undefined) {
    return result(input.configuredConcurrency, 1, null, "capability_unavailable");
  }

  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("generation capacity timeout must be 1..60000ms");
  }
  const controller = new AbortController();
  let timedOut = false;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abortFromCaller = () => {
    controller.abort(input.signal?.reason);
    rejectCancellation(input.signal?.reason);
  };
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("generation capacity probe timed out"));
      reject(new Error("generation capacity probe timed out"));
    }, timeoutMs);
  });
  try {
    const capacity = await Promise.race([
      input.provider.generationCapacity(controller.signal),
      timeout,
      cancellation,
    ]);
    throwIfAborted(input.signal);
    if (
      (capacity.maximumConcurrentGenerations !== 1 &&
        capacity.maximumConcurrentGenerations !== 2) ||
      !Number.isSafeInteger(capacity.providerSlots) || capacity.providerSlots < 1 ||
      capacity.evidence !== "provider_reported_slots"
    ) {
      return result(input.configuredConcurrency, 1, null, "capability_probe_failed");
    }
    const verified = capacity.maximumConcurrentGenerations === 2 &&
        capacity.providerSlots >= 2
      ? 2
      : 1;
    return result(
      input.configuredConcurrency,
      verified,
      capacity.providerSlots,
      capacity.evidence,
    );
  } catch {
    throwIfAborted(input.signal);
    return result(
      input.configuredConcurrency,
      1,
      null,
      timedOut ? "capability_probe_timed_out" : "capability_probe_failed",
    );
  } finally {
    clearTimeout(timer);
    controller.abort(new Error("generation capacity probe settled"));
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function result(
  configuredConcurrency: 1 | 2,
  verifiedProviderCapacity: 1 | 2,
  providerSlots: number | null,
  evidence: GenerationCapacityEvidence,
): VerifiedTextGenerationCapacity {
  return Object.freeze({
    configuredConcurrency,
    verifiedProviderCapacity,
    effectiveConcurrency: Math.min(
      configuredConcurrency,
      verifiedProviderCapacity,
    ) as 1 | 2,
    providerSlots,
    evidence,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("generation capacity probe cancelled");
}
