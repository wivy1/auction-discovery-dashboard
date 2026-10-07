import { invokeSourceParser } from "../sources/parser-errors";
import type { SourceAdapter, SourceDiscoveredListing, SourceInventoryPageRequest } from "../sources/types";
import { validateSourceParserEvidencePacket, type SourceParserEvidencePacket } from "./evidence";

export interface ParserReplayResult {
  schemaVersion: "source-parser-replay-result-v1";
  sourceId: string;
  sourceRunId: string;
  bodyHash: string | null;
  operation: "plan_inventory" | "validate_page" | "parse_page";
  outcome: "unavailable" | "error" | "parsed";
  countContext: "bounded" | "limited";
  listingCount?: number;
  failedOperation?: ParserReplayResult["operation"];
  error?: { name: string; message: string };
  reason?: string;
}

/** Runs only the captured operation and saved page; it never follows a plan. */
export async function replaySourceParserEvidence(adapter: SourceAdapter, input: SourceParserEvidencePacket): Promise<ParserReplayResult> {
  const result: ParserReplayResult = { schemaVersion: "source-parser-replay-result-v1", sourceId: input.sourceId,
    sourceRunId: input.sourceRunId, bodyHash: null, operation: input.replay.operation ?? "parse_page", outcome: "unavailable", countContext: "limited" };
  let packet: SourceParserEvidencePacket;
  try { packet = await validateSourceParserEvidencePacket(input, { sourceId: input.sourceId, sourceRunId: input.sourceRunId }); }
  catch { result.reason = "replay_packet_invalid"; return result; }
  result.bodyHash = packet.sanitizedBodyHash;
  if (adapter.manifest.id !== packet.sourceId) { result.reason = "replay_adapter_identity_mismatch"; return result; }
  const context = packet.replay;
  const planned = context.plannedPage;
  const bounded = planned !== undefined && Number.isSafeInteger(planned.minimumListings) && (planned.minimumListings as number) >= 0 &&
    Number.isSafeInteger(planned.maximumListings) && (planned.maximumListings as number) >= (planned.minimumListings as number) &&
    typeof planned.inventoryMember === "boolean" && typeof planned.reviewCandidate === "boolean";
  if (planned && (!bounded || planned.expectedCollectionListings !== undefined &&
      (!Number.isSafeInteger(planned.expectedCollectionListings) || (planned.expectedCollectionListings as number) < 0))) {
    result.reason = "replay_count_context_invalid"; return result;
  }
  result.countContext = bounded && (!adapter.validateInventoryTraversalPage || context.expectedListings !== undefined) ? "bounded" : "limited";
  const pageContext = planned as unknown as SourceInventoryPageRequest | undefined;
  let stage: ParserReplayResult["operation"] | undefined = result.operation;
  try {
    if (stage === "plan_inventory") {
      if (!adapter.planInventoryTraversal) { result.reason = "replay_operation_unavailable"; return result; }
      invokeSourceParser(packet.sourceId, () => adapter.planInventoryTraversal!(context.page));
    } else if (stage === "validate_page") {
      if (!adapter.validateInventoryTraversalPage || context.expectedListings === undefined) { result.reason = "replay_operation_unavailable"; return result; }
      const validation = invokeSourceParser(packet.sourceId, () => adapter.validateInventoryTraversalPage!(context.page, context.expectedListings!, pageContext));
      if (validation === "replan_required") { result.reason = "replay_metadata_replan_required"; return result; }
    }
    stage = "parse_page";
    const rows: readonly SourceDiscoveredListing[] = invokeSourceParser(packet.sourceId, () => adapter.parseDiscoveryBatch?.(context.page, pageContext)
      ?? adapter.parseDiscoveryPage(context.page).map((stub) => ({ stub })));
    stage = undefined;
    if (!Array.isArray(rows)) throw new Error("replay_listing_output_invalid");
    if (bounded && (rows.length < (planned.minimumListings as number) || rows.length > (planned.maximumListings as number))) throw new Error("replay_page_cardinality_mismatch");
    if (planned?.expectedCollectionListings !== undefined && rows.length !== planned.expectedCollectionListings) throw new Error("replay_collection_cardinality_mismatch");
    const explicitZero = bounded && (planned.minimumListings === 0 && planned.maximumListings === 0 || planned.expectedCollectionListings === 0);
    if (rows.length === 0 && !explicitZero) throw new Error("replay_empty_output_unproved");
    const ids = new Set<string>(); const urls = new Set<string>();
    for (const row of rows) {
      if (!row?.stub || row.stub.sourceId !== packet.sourceId || typeof row.stub.sourceListingId !== "string" || !row.stub.sourceListingId ||
          typeof row.stub.sourceUrl !== "string" || !row.stub.sourceUrl) throw new Error("replay_source_identity_mismatch");
      if (ids.has(row.stub.sourceListingId) || urls.has(row.stub.sourceUrl)) throw new Error("replay_duplicate_listing_identity");
      ids.add(row.stub.sourceListingId); urls.add(row.stub.sourceUrl);
      if (row.detail && (row.detail.sourceId !== row.stub.sourceId || row.detail.sourceListingId !== row.stub.sourceListingId || row.detail.sourceUrl !== row.stub.sourceUrl)) throw new Error("replay_detail_identity_mismatch");
    }
    result.outcome = "parsed"; result.listingCount = rows.length;
  } catch (error) {
    result.outcome = "error"; result.failedOperation = stage;
    result.error = { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "non_error_parser_failure" };
  }
  return result;
}

export function replayFailureMatches(result: ParserReplayResult, packet: SourceParserEvidencePacket): boolean {
  return result.outcome === "error" && result.sourceId === packet.sourceId && result.sourceRunId === packet.sourceRunId &&
    result.bodyHash === packet.sanitizedBodyHash && result.operation === (packet.replay.operation ?? "parse_page") &&
    result.failedOperation === result.operation && result.error?.name === packet.diagnostic.errorCode && result.error.message === packet.diagnostic.message;
}
