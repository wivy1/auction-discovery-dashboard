import {
  readStagedListingEmbeddings,
  readStagedListingEnrichment,
  writeStagedListingEmbeddings,
  writeStagedListingEnrichment,
} from "./staged-generation";
import {
  parseEnrichmentStagingCompanionRequest,
  type EnrichmentStagingCompanionResult,
} from "./staged-generation-companion-wire";

/** Executes one already bounded companion request against the host filesystem. */
export async function executeEnrichmentStagingCompanionRequest(
  value: unknown,
  stagingRoot: string,
): Promise<EnrichmentStagingCompanionResult> {
  const request = parseEnrichmentStagingCompanionRequest(value);
  switch (request.operation) {
    case "read_listing_enrichment":
      return readStagedListingEnrichment({
        root: stagingRoot,
        binding: request.binding,
      });
    case "write_listing_enrichment":
      await writeStagedListingEnrichment({
        root: stagingRoot,
        binding: request.binding,
        prepared: request.prepared,
      });
      return null;
    case "read_listing_embeddings":
      return readStagedListingEmbeddings({
        root: stagingRoot,
        binding: request.binding,
      });
    case "write_listing_embeddings":
      await writeStagedListingEmbeddings({
        root: stagingRoot,
        binding: request.binding,
        results: request.results,
      });
      return null;
  }
}
