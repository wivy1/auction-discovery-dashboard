import { sha256Text } from "../ai/provenance";
import type { NormalizedListingDetail } from "../domain/listings";
import {
  buildExtractionPrompt,
  type ListingTextForEnrichment,
} from "./prompt";
import { canonicalItemDescription } from "../domain/item-text";

export const DEFAULT_ENRICHMENT_INPUT_CHARS = 8_000;

export function enrichmentInputLimit(
  value = process.env.AI_MAX_INPUT_CHARS,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ENRICHMENT_INPUT_CHARS;
}

/** One canonical projection feeds both queue provenance and model execution. */
export function listingTextForEnrichment(
  detail: NormalizedListingDetail,
  inputLimit = enrichmentInputLimit(),
): ListingTextForEnrichment {
  return listingTextProjection(
    detail,
    canonicalItemDescription(detail.cleanDescription).slice(0, inputLimit),
  );
}

export function marketplacePolicyCleanupApplied(
  detail: Pick<NormalizedListingDetail, "cleanDescription" | "rawDescription">,
): boolean {
  return canonicalItemDescription(detail.cleanDescription) !==
      detail.cleanDescription ||
    canonicalItemDescription(detail.rawDescription) !== detail.rawDescription;
}

/**
 * Exact pre-policy-cleaning projection used only to migrate a verified
 * immutable artifact to the canonical input hash. It must not feed a new model
 * request or any ordinary queue/read path.
 */
export function legacyUnfilteredListingTextForEnrichment(
  detail: NormalizedListingDetail,
  inputLimit = enrichmentInputLimit(),
): ListingTextForEnrichment {
  return listingTextProjection(
    detail,
    detail.cleanDescription.slice(0, inputLimit),
  );
}

function listingTextProjection(
  detail: NormalizedListingDetail,
  itemDescription: string,
): ListingTextForEnrichment {
  return {
    source: detail.sourceId,
    sourceListingId: detail.sourceListingId,
    title: detail.title,
    category: detail.category,
    cleanDescription: itemDescription,
    // Only the cleaned item text is sent to the local model.
    rawDescription: itemDescription,
    seller: detail.seller,
    pickupLocationText: [
      detail.pickupLocation?.city,
      detail.pickupLocation?.state,
      detail.pickupLocation?.postalCode,
    ].filter(Boolean).join(", ") || null,
    removalText: null,
  };
}

export async function listingExtractionInput(
  detail: NormalizedListingDetail,
  inputLimit = enrichmentInputLimit(),
): Promise<{
  listingText: ListingTextForEnrichment;
  prompt: string;
  inputHash: string;
}> {
  const listingText = listingTextForEnrichment(detail, inputLimit);
  const prompt = buildExtractionPrompt(listingText);
  return {
    listingText,
    prompt,
    inputHash: await sha256Text(prompt),
  };
}
