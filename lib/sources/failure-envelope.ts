import {
  SourceAccessChallengeError,
  SourceAdapterError,
  SourceRetryableDiscoveryPageError,
  SourceRetryableIncompleteDetailError,
} from "./types";

/** Fixed metadata only; parser messages and source content never cross this boundary. */
export interface SourceAdapterFailureEnvelope {
  readonly category: "adapter_contract";
  readonly reasonCode: "adapter_contract_failed";
}

export const SOURCE_ADAPTER_FAILURE_CODE = "source_adapter_contract_failed";
export const SOURCE_ADAPTER_FAILURE_MESSAGE = "Source adapter rejected the captured inventory";

export function parseSourceAdapterFailureEnvelope(value: unknown): SourceAdapterFailureEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.category !== "adapter_contract" ||
      record.reasonCode !== "adapter_contract_failed") return null;
  return Object.freeze({ category: "adapter_contract", reasonCode: "adapter_contract_failed" });
}

export function sourceAdapterFailureEnvelope(error: unknown, sourceId: string): SourceAdapterFailureEnvelope | null {
  if (!(error instanceof SourceAdapterError) || error.sourceId !== sourceId ||
      error instanceof SourceAccessChallengeError ||
      error instanceof SourceRetryableDiscoveryPageError ||
      error instanceof SourceRetryableIncompleteDetailError) return null;
  return Object.freeze({ category: "adapter_contract", reasonCode: "adapter_contract_failed" });
}
