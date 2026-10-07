import { captureSourceParserEvidence, type SourceParserEvidenceOperation } from "../source-repair/evidence";
import { invokeSourceParser } from "../sources/parser-errors";
import {
  SourceAccessChallengeError, SourceAdapterError, SourceNotImplementedError,
  SourceRetryableDiscoveryPageError, SourceRetryableIncompleteDetailError,
  type SourceId, type SourceInventoryPageRequest, type SourcePage,
} from "../sources/types";

export const SOURCE_PARSER_EVIDENCE_PREFIX = "source-repair-evidence/v1/";
export const MAX_SOURCE_PARSER_EVIDENCE_PACKETS = 64;
export const MAX_SOURCE_PARSER_EVIDENCE_BYTES = 8 * 1_024 * 1_024;

type EvidenceStorage = Pick<R2Bucket, "head" | "list" | "put">;
interface ParserInvocation {
  readonly page: SourcePage;
  readonly operation: SourceParserEvidenceOperation;
  readonly expectedListings?: number;
  readonly plannedPage?: SourceInventoryPageRequest;
}
interface FailedParserInvocation extends ParserInvocation {
  readonly error: SourceAdapterError;
}
export type SourceParserEvidenceRetention =
  | { readonly retained: true; readonly key: string }
  | { readonly retained: false; readonly reason: string };

function semanticPlannedPage(plannedPage: SourceInventoryPageRequest | undefined): SourceInventoryPageRequest | undefined {
  if (plannedPage === undefined) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Deliberately omit transport headers/body from replay context.
  const { headers: _headers, body: _body, ...request } = plannedPage.request;
  return { ...plannedPage, request };
}

/** One bounded failed invocation, associated with its exact thrown error. */
export function createSourceParserEvidenceCapture(sourceId: SourceId) {
  let failedInvocation: FailedParserInvocation | null = null;
  return {
    run<Result>(invocation: ParserInvocation, parse: () => Result): Result {
      failedInvocation = null;
      try {
        return invokeSourceParser(sourceId, parse);
      } catch (error) {
        try {
          if (error instanceof SourceAdapterError && error.sourceId === sourceId &&
            !(error instanceof SourceAccessChallengeError) &&
            !(error instanceof SourceNotImplementedError) &&
            !(error instanceof SourceRetryableDiscoveryPageError) &&
            !(error instanceof SourceRetryableIncompleteDetailError) &&
            invocation.page.body.length <= MAX_SOURCE_PARSER_EVIDENCE_BYTES &&
            new TextEncoder().encode(invocation.page.body).byteLength <= MAX_SOURCE_PARSER_EVIDENCE_BYTES) {
            failedInvocation = { ...invocation, error, plannedPage: semanticPlannedPage(invocation.plannedPage) };
          }
        } catch { /* Optional evidence preparation cannot replace the parser error. */ }
        throw error;
      }
    },
    clear(): void { failedInvocation = null; },
    async retain(error: unknown, input: {
      readonly sourceRunId: string;
      readonly observedAt: string;
      readonly storage: EvidenceStorage | null | undefined;
    }): Promise<SourceParserEvidenceRetention> {
      const invocation = failedInvocation;
      failedInvocation = null;
      if (invocation === null || invocation.error !== error) return { retained: false, reason: "unsupported_parser_invocation" };
      try {
        const storage = input.storage;
        if (!storage) return { retained: false, reason: "evidence_storage_unavailable" };
        const captured = await captureSourceParserEvidence({
          sourceId, sourceRunId: input.sourceRunId, observedAt: input.observedAt,
          diagnostic: { errorCode: invocation.error.name, message: invocation.error.message },
          page: invocation.page, operation: invocation.operation,
          ...(invocation.expectedListings === undefined ? {} : { expectedListings: invocation.expectedListings }),
          ...(invocation.plannedPage === undefined ? {} : { plannedPage: invocation.plannedPage }),
        });
        if (!captured.available) return { retained: false, reason: captured.reason };
        if (!captured.key.startsWith(SOURCE_PARSER_EVIDENCE_PREFIX) || captured.byteLength > MAX_SOURCE_PARSER_EVIDENCE_BYTES) {
          return { retained: false, reason: "evidence_size_or_key_invalid" };
        }
        if (await storage.head(captured.key)) return { retained: false, reason: "evidence_already_retained" };
        // Discovery already owns the serialized mutation lane. Admission and put
        // stay in its source catch, without starting another database/runtime.
        const existing = await storage.list({ prefix: SOURCE_PARSER_EVIDENCE_PREFIX, limit: MAX_SOURCE_PARSER_EVIDENCE_PACKETS });
        if (existing.truncated || existing.objects.length >= MAX_SOURCE_PARSER_EVIDENCE_PACKETS) {
          return { retained: false, reason: "evidence_storage_full" };
        }
        const stored = await storage.put(captured.key, captured.serializedPacket, {
          onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
        });
        return stored === null ? { retained: false, reason: "evidence_already_retained" } : { retained: true, key: captured.key };
      } catch {
        return { retained: false, reason: "evidence_storage_unavailable" };
      }
    },
  };
}
