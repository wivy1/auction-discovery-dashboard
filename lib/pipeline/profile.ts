import { env } from "cloudflare:workers";
import {
  readAiConfig,
  sha256Text,
  type TextGenerationProvider,
} from "../ai";
import {
  EXTRACTION_PROMPT_VERSION,
  SEMANTIC_DOCUMENT_VERSION,
} from "../enrichment/prompt";
import { effectiveAssetClasses } from "../enrichment/asset-classes";
import {
  locationEvidenceSources,
  type LocationEvidenceSource,
  type NormalizedListingDetail,
} from "../domain/listings";
import {
  PROFILE_SIGNAL_RESIDUAL_VERSION,
  interestProfileSummary,
  learnProfile,
  rankEmbedding,
  type VotedEmbedding,
} from "../ranking/profile";
import { hashListingId } from "../ranking/listing-hash";
import {
  INTEREST_PROFILE_NARRATIVE_PROMPT_VERSION,
  buildInterestProfileNarrativeEvidence,
  generateInterestProfileNarrative,
} from "../ranking/profile-narrative";
import {
  activeRemovedProfileSignalConcepts,
  matchingActiveProfileConcepts,
  profileSignalFeedbackIdsMismatch,
  profileSnapshotNeedsRecovery,
} from "../operator-feedback";
import {
  readLatestProfileSignalFeedback,
  type ProfileSignalFeedbackSnapshot,
} from "./profile-feedback";
import {
  PROFILE_CONSTRAINT_MANIFEST_PROMPT_VERSION,
  expectedEmbeddingDimensions,
  readValidatedEnrichmentStates,
  readValidatedListingRatings,
  storeAiArtifact,
  type EnrichmentProvenanceTarget,
} from "./storage";

interface ProfileChainInventoryRow {
  listing_id: string;
  source_id: string;
  source_listing_id: string;
  source_url: string;
  title: string;
  category: string | null;
  lot_number: string | null;
  raw_description: string;
  clean_description: string;
  price_amount_minor: number | null;
  price_currency: string | null;
  price_display_text: string | null;
  auction_ends_at: string | null;
  seller: string | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_country_code: string | null;
  pickup_evidence_source: string | null;
  scraped_at: string;
  content_hash: string;
  vote_value: string | null;
  vote_updated_at: string | null;
  is_current: number;
}

async function readProfileChainInventory(
  target: EnrichmentProvenanceTarget,
): Promise<ProfileChainInventoryRow[]> {
  const result = await env.DB.prepare(`
    SELECT
      s.id AS listing_id,
      s.source_id,
      s.source_listing_id,
      s.source_url,
      COALESCE(observation.title, detail.title_at_scrape, s.title) AS title,
      detail.category_at_scrape AS category,
      detail.lot_number_at_scrape AS lot_number,
      detail.raw_description,
      detail.clean_description,
      detail.price_amount_minor,
      detail.price_currency,
      detail.price_display_text,
      detail.auction_ends_at,
      detail.seller,
      detail.pickup_city,
      detail.pickup_state,
      detail.pickup_postal_code,
      detail.pickup_country_code,
      detail.pickup_evidence_source,
      detail.scraped_at,
      detail.content_hash,
      vote.value AS vote_value,
      vote.updated_at AS vote_updated_at,
      CASE WHEN current_inventory.listing_id IS NOT NULL THEN 1 ELSE 0 END AS is_current
    FROM listing_stubs s
    JOIN listing_details detail ON detail.listing_id = s.id
    LEFT JOIN listing_detail_observations observation
      ON observation.listing_id = s.id
    LEFT JOIN listing_votes vote ON vote.listing_id = s.id
    LEFT JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = s.id
      AND current_inventory.source_id = s.source_id
      AND current_inventory.review_candidate = 1
    WHERE vote.value IN ('interested', 'not_interested')
      OR (
        current_inventory.listing_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM ai_artifacts extraction_candidate
          WHERE extraction_candidate.subject_type = 'listing'
            AND extraction_candidate.subject_id = s.id
            AND extraction_candidate.task = 'listing_extraction'
            AND extraction_candidate.provider_name = ?
            AND extraction_candidate.model_name = ?
            AND extraction_candidate.prompt_version = ?
        )
      )
    ORDER BY s.id
  `).bind(
    target.textProviderName,
    target.textModelName,
    target.extractionPromptVersion,
  ).all<ProfileChainInventoryRow>();
  return result.results ?? [];
}

function profileChainListing(row: ProfileChainInventoryRow): {
  listingId: string;
  detail: NormalizedListingDetail;
} {
  const hasPickup = row.pickup_city || row.pickup_state || row.pickup_postal_code;
  const evidenceSource = locationEvidenceSources.includes(
      row.pickup_evidence_source as LocationEvidenceSource,
    )
    ? row.pickup_evidence_source as LocationEvidenceSource
    : "unknown";
  return {
    listingId: row.listing_id,
    detail: {
      sourceId: row.source_id,
      sourceListingId: row.source_listing_id,
      sourceUrl: row.source_url,
      title: row.title,
      category: row.category,
      lotNumber: row.lot_number,
      rawDescription: row.raw_description,
      cleanDescription: row.clean_description,
      priceAtScrape: {
        amountMinor: row.price_amount_minor,
        currency: row.price_currency,
        displayText: row.price_display_text,
      },
      auctionEndsAt: row.auction_ends_at,
      seller: row.seller,
      pickupLocation: hasPickup ? {
        city: row.pickup_city,
        state: row.pickup_state,
        postalCode: row.pickup_postal_code,
        countryCode: row.pickup_country_code ?? "US",
        evidenceSource,
      } : null,
      images: [],
      scrapedAt: row.scraped_at,
      contentHash: row.content_hash,
    },
  };
}

export interface InterestProfileFreshness {
  needsRebuild: boolean;
  usableVotes: number;
  snapshotVotes: number;
  feedbackMismatch: boolean;
}

function conceptsFromExtraction(value: unknown, title: string): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const list = (key: string) => Array.isArray(parsed[key])
      ? (parsed[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    const includedItems = list("included_items");
    return [
      typeof parsed.industry_domain === "string" ? parsed.industry_domain : "",
      ...effectiveAssetClasses(list("asset_classes"), { title, includedItems }),
      ...list("high_value_signals"),
      ...list("negative_signals"),
    ].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Compares the newest immutable profile snapshot with votes that currently
 * have the complete configured extraction -> semantic -> embedding chain.
 * This lets a later no-op batch recover a profile write that failed after the
 * final listing artifact was committed, without creating duplicate versions.
 */
export async function assessInterestProfileFreshness(
  target: EnrichmentProvenanceTarget = configuredProvenanceTarget(),
): Promise<InterestProfileFreshness> {
  const currentFeedback = await readLatestProfileSignalFeedback();
  const feedbackHash = await profileSignalFeedbackHash(currentFeedback);
  const [inventory, latestProfile] = await Promise.all([
    readProfileChainInventory(target),
    env.DB.prepare(`
      SELECT id, algorithm_version, created_at
      FROM profile_versions
      WHERE profile_id = 'default'
      ORDER BY created_at DESC, version DESC
      LIMIT 1
    `).first<{
      id: string;
      algorithm_version: string;
      created_at: string;
    }>(),
  ]);
  const states = await readValidatedEnrichmentStates({
    listings: inventory.map(profileChainListing),
    target,
  });
  const scorable = inventory.flatMap((inventoryRow) => {
    const chain = states.get(inventoryRow.listing_id)?.completeChain;
    return chain ? [{ inventoryRow, chain }] : [];
  });
  const eligible = scorable.filter(({ inventoryRow }) =>
    inventoryRow.vote_value === "interested" || inventoryRow.vote_value === "not_interested"
  );
  const currentScorable = scorable.filter(({ inventoryRow }) => inventoryRow.is_current === 1);
  const [snapshotResult, scoreResult] = latestProfile ? await Promise.all([
    env.DB.prepare(`
      SELECT listing_id, value
      FROM profile_version_votes
      WHERE profile_version_id = ?
    `).bind(latestProfile.id).all<{ listing_id: string; value: string }>(),
    env.DB.prepare(`
      SELECT listing_id
      FROM listing_scores
      WHERE profile_version_id = ?
    `).bind(latestProfile.id).all<{ listing_id: string }>(),
  ]) : [{ results: [] }, { results: [] }];
  const snapshots = snapshotResult.results ?? [];
  const snapshotKeys = new Set(snapshots.map((snapshot) =>
    `${snapshot.listing_id}\u0000${snapshot.value}`
  ));
  const eligibleKeys = new Set(eligible.map(({ inventoryRow }) =>
    `${inventoryRow.listing_id}\u0000${inventoryRow.vote_value}`
  ));
  const voteMismatches = eligible.filter(({ inventoryRow }) =>
    !snapshotKeys.has(`${inventoryRow.listing_id}\u0000${inventoryRow.vote_value}`)
  ).length + snapshots.filter((snapshot) =>
    !eligibleKeys.has(`${snapshot.listing_id}\u0000${snapshot.value}`)
  ).length + (latestProfile ? eligible.filter(({ chain }) =>
    chain.chainGeneratedAt > latestProfile.created_at
  ).length : 0);
  const minimumScoredAt = new Map(currentScorable.map(({ inventoryRow, chain }) =>
    [inventoryRow.listing_id, chain.chainGeneratedAt]
  ));
  const semanticOutputHashes = new Map(currentScorable.map(({ inventoryRow, chain }) =>
    [inventoryRow.listing_id, chain.semanticOutputHash]
  ));
  const validRatings = latestProfile
    ? await readValidatedListingRatings({
        listingIds: currentScorable.map(({ inventoryRow }) => inventoryRow.listing_id),
        profileVersionId: latestProfile.id,
        embeddingDimensions: expectedEmbeddingDimensions(target),
        minimumScoredAtByListing: minimumScoredAt,
        semanticOutputHashByListing: semanticOutputHashes,
      })
    : new Map();
  const currentScorableIds = new Set(currentScorable.map(({ inventoryRow }) =>
    inventoryRow.listing_id
  ));
  const scoreMismatches = currentScorable.filter(({ inventoryRow }) =>
    !validRatings.has(inventoryRow.listing_id)
  ).length + (scoreResult.results ?? []).filter((score) =>
    !currentScorableIds.has(score.listing_id)
  ).length;

  const usableVotes = eligible.length;
  const snapshotVotes = snapshots.length;
  const snapshotFeedback = latestProfile?.id
    ? await env.DB.prepare(`
        SELECT feedback_id
        FROM profile_version_signal_feedback
        WHERE profile_version_id = ?
        ORDER BY feedback_id
      `).bind(latestProfile.id).all<{ feedback_id: string }>()
    : null;
  const feedbackMismatch = profileSignalFeedbackIdsMismatch(
    currentFeedback.map((entry) => entry.id),
    (snapshotFeedback?.results ?? []).map((entry) => entry.feedback_id),
  );
  const algorithmMatches =
    latestProfile?.algorithm_version === profileAlgorithmVersion(target, feedbackHash);
  const neutralBootstrapNeedsRebuild = usableVotes === 0 && currentScorable.length > 0 && (
    !latestProfile || snapshotVotes > 0 || scoreMismatches > 0 ||
    feedbackMismatch || !algorithmMatches
  );
  return {
    needsRebuild: neutralBootstrapNeedsRebuild || profileSnapshotNeedsRecovery({
      usableVotes,
      snapshotVotes,
      voteMismatches,
      scoreMismatches,
      feedbackMismatch,
      algorithmMatches,
    }),
    usableVotes,
    snapshotVotes,
    feedbackMismatch,
  };
}

export interface RebuildInterestProfileOptions {
  /**
   * Supplied only by the explicit enrichment runner. Interactive feedback,
   * discovery, routing, image, and recovery paths never construct a provider.
   */
  narrativeProvider?: TextGenerationProvider;
  renewLease?: () => Promise<unknown>;
}

export async function rebuildInterestProfile(
  target: EnrichmentProvenanceTarget = configuredProvenanceTarget(),
  options: RebuildInterestProfileOptions = {},
): Promise<{ profileVersionId: string | null; profileVersion: number | null; votes: number }> {
  const inventory = await readProfileChainInventory(target);
  const states = await readValidatedEnrichmentStates({
    listings: inventory.map(profileChainListing),
    target,
    includeVectors: true,
  });
  const voteRows = inventory.flatMap((inventoryRow) => {
    const chain = states.get(inventoryRow.listing_id)?.completeChain;
    if (
      !chain?.vector ||
      (inventoryRow.vote_value !== "interested" && inventoryRow.vote_value !== "not_interested")
    ) return [];
    return [{
      listingId: inventoryRow.listing_id,
      value: inventoryRow.vote_value as "interested" | "not_interested",
      updatedAt: inventoryRow.vote_updated_at ?? "",
      title: inventoryRow.title,
      vector: chain.vector,
      extractionJson: chain.extractionOutputJson,
      extractionInputHash: chain.extractionInputHash,
      semanticOutputHash: chain.semanticOutputHash,
      priceAmountMinor: inventoryRow.price_amount_minor,
      priceCurrency: inventoryRow.price_currency,
      priceDisplayText: inventoryRow.price_display_text,
    }];
  });

  const usable: VotedEmbedding[] = [];
  let newestVote: string | null = null;
  for (const row of voteRows) {
    usable.push({
      vote: row.value,
      vector: row.vector,
      concepts: conceptsFromExtraction(row.extractionJson, row.title),
      listingId: hashListingId(row.listingId),
      title: row.title || "Untitled listing",
    });
    const updatedAt = row.updatedAt || null;
    if (updatedAt && (!newestVote || updatedAt > newestVote)) newestVote = updatedAt;
  }

  const currentEmbeddings = inventory.flatMap((inventoryRow) => {
    const chain = states.get(inventoryRow.listing_id)?.completeChain;
    return inventoryRow.is_current === 1 && chain?.vector
      ? [{ inventoryRow, chain }]
      : [];
  });
  if (usable.length === 0 && currentEmbeddings.length === 0) {
    return { profileVersionId: null, profileVersion: null, votes: 0 };
  }

  const profileId = "default";
  const signalFeedback = await readLatestProfileSignalFeedback(profileId);
  const neutralPositiveConcepts = Array.from(
    activeRemovedProfileSignalConcepts(signalFeedback, "positive"),
  ).sort();
  const neutralNegativeConcepts = Array.from(
    activeRemovedProfileSignalConcepts(signalFeedback, "negative"),
  ).sort();
  const learned = learnProfile(usable, {
    neutralPositiveConcepts,
    neutralNegativeConcepts,
  });
  const residualProvenance = {
    version: PROFILE_SIGNAL_RESIDUAL_VERSION,
    positive: {
      requested: neutralPositiveConcepts,
      applied: learned.appliedPositiveNeutralConcepts,
      skipped: learned.skippedPositiveNeutralConcepts,
      basisHash: await sha256Text(JSON.stringify(learned.positiveResidualBasis)),
    },
    negative: {
      requested: neutralNegativeConcepts,
      applied: learned.appliedNegativeNeutralConcepts,
      skipped: learned.skippedNegativeNeutralConcepts,
      basisHash: await sha256Text(JSON.stringify(learned.negativeResidualBasis)),
    },
  };
  const feedbackHash = await profileSignalFeedbackHash(signalFeedback);
  const current = await env.DB.prepare(`SELECT current_version FROM interest_profiles WHERE id = ?`).bind(profileId).first<{ current_version: number }>();
  const version = (current?.current_version ?? 0) + 1;
  const profileVersionId = `${profileId}:v${version}`;
  const algorithmVersion = profileAlgorithmVersion(target, feedbackHash);
  const snapshot = voteRows.map((row) => ({
    listingId: row.listingId,
    vote: row.value,
    updatedAt: row.updatedAt,
    extractionInputHash: row.extractionInputHash,
    semanticOutputHash: row.semanticOutputHash,
  }));
  const inputHash = await sha256Text(JSON.stringify({
    target,
    snapshot,
    signalFeedback: signalFeedback.map((entry) => ({
      id: entry.id,
      polarity: entry.polarity,
      normalizedConcept: entry.normalizedConcept,
      action: entry.action,
    })),
    residualProvenance,
  }));
  const residualProvenanceJson = JSON.stringify(residualProvenance);
  const residualProvenanceHash = await sha256Text(residualProvenanceJson);
  const positives = learned.positiveConcepts;
  const negatives = learned.negativeConcepts;
  const narrativeEvidence = buildInterestProfileNarrativeEvidence(
    voteRows.map((row) => ({
      vote: row.value,
      title: row.title,
      extractionJson: row.extractionJson,
      priceAmountMinor: row.priceAmountMinor,
      priceCurrency: row.priceCurrency,
      priceDisplayText: row.priceDisplayText,
    })),
    { neutralPositiveConcepts, neutralNegativeConcepts },
  );
  const deterministicSummary = interestProfileSummary(learned);
  const narrativeInputHash = await sha256Text(JSON.stringify({
    profileInputHash: inputHash,
    promptVersion: INTEREST_PROFILE_NARRATIVE_PROMPT_VERSION,
    evidence: narrativeEvidence,
  }));
  await options.renewLease?.();
  const generatedNarrative = await generateInterestProfileNarrative({
    provider: options.narrativeProvider,
    evidence: narrativeEvidence,
    deterministicSeed: deterministicSummary,
  });
  await options.renewLease?.();
  const summary = generatedNarrative.narrative.summary;
  const narrativeOutputJson = JSON.stringify({
    mode: generatedNarrative.mode,
    summary,
    positive_evidence_ids:
      generatedNarrative.narrative.positiveEvidenceIds,
    negative_evidence_ids:
      generatedNarrative.narrative.negativeEvidenceIds,
    failure_code: generatedNarrative.failureCode,
  });
  const narrativeOutputHash = await sha256Text(narrativeOutputJson);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO interest_profiles (id, name, current_version, created_at, updated_at)
      VALUES (?, 'Default interest profile', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version, updated_at = excluded.updated_at
    `).bind(profileId, version, now, now),
    env.DB.prepare(`
      INSERT INTO profile_versions (
        id, profile_id, version, algorithm_version, human_summary,
        interested_concepts_json, not_interested_concepts_json,
        interested_support_count, not_interested_support_count,
        based_on_votes_through, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      profileVersionId,
      profileId,
      version,
      algorithmVersion,
      summary,
      JSON.stringify(positives),
      JSON.stringify(negatives),
      learned.positiveExamples,
      learned.negativeExamples,
      newestVote,
      now,
    ),
    env.DB.prepare(`
      INSERT INTO ai_artifacts (
        id, subject_type, subject_id, task, provider_name, model_name,
        prompt_version, input_hash, output_json, output_hash, generated_at
      ) VALUES (
        ?, 'profile_version', ?, 'profile_summary', 'profile', ?, ?, ?, ?, ?, ?
      )
    `).bind(
      crypto.randomUUID(),
      profileVersionId,
      algorithmVersion,
      PROFILE_CONSTRAINT_MANIFEST_PROMPT_VERSION,
      inputHash,
      residualProvenanceJson,
      residualProvenanceHash,
      now,
    ),
    env.DB.prepare(`
      INSERT INTO ai_artifacts (
        id, subject_type, subject_id, task, provider_name, model_name,
        prompt_version, input_hash, output_text, output_json, output_hash,
        generated_at
      ) VALUES (
        ?, 'profile_version', ?, 'profile_summary', ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).bind(
      crypto.randomUUID(),
      profileVersionId,
      generatedNarrative.providerName ?? "profile",
      generatedNarrative.modelName ?? algorithmVersion,
      generatedNarrative.promptVersion,
      narrativeInputHash,
      summary,
      narrativeOutputJson,
      narrativeOutputHash,
      generatedNarrative.generatedAt,
    ),
  ]);

  const voteStatements = voteRows.map((row) => env.DB.prepare(`
    INSERT INTO profile_version_votes (profile_version_id, listing_id, value)
    VALUES (?, ?, ?)
  `).bind(profileVersionId, row.listingId, row.value));
  if (voteStatements.length > 0) await env.DB.batch(voteStatements);

  if (signalFeedback.length > 0) {
    await env.DB.batch(signalFeedback.map((entry) => env.DB.prepare(`
      INSERT INTO profile_version_signal_feedback (profile_version_id, feedback_id)
      VALUES (?, ?)
    `).bind(profileVersionId, entry.id)));
  }

  const centroidStatements: Array<{ kind: string; vector: number[] }> = [
    { kind: "profile_positive_centroid", vector: learned.positiveCentroid },
    { kind: "profile_negative_centroid", vector: learned.negativeCentroid },
  ].filter((entry): entry is { kind: string; vector: number[] } => Boolean(entry.vector));
  if (centroidStatements.length === 0) {
    centroidStatements.push({
      kind: "profile_positive_centroid",
      vector: Array(expectedEmbeddingDimensions(target)).fill(0),
    });
  }
  if (centroidStatements.length > 0) {
    await env.DB.batch(centroidStatements.map((entry) => env.DB.prepare(`
      INSERT INTO embeddings (
        id, subject_type, subject_id, kind, provider_name, model_name,
        input_hash, dimensions, vector_json, generated_at
      ) VALUES (?, 'profile_version', ?, ?, 'profile', ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      profileVersionId,
      entry.kind,
      algorithmVersion,
      inputHash,
      entry.vector.length,
      JSON.stringify(entry.vector),
      now,
    )));
  }

  for (const { inventoryRow, chain } of currentEmbeddings) {
    const listingId = inventoryRow.listing_id;
    const candidateConcepts = conceptsFromExtraction(
      chain.extractionOutputJson,
      inventoryRow.title,
    );
    const matchingConcepts = matchingActiveProfileConcepts(candidateConcepts, positives);
    const matchingNegativeConcepts = matchingActiveProfileConcepts(candidateConcepts, negatives);
    const ranked = rankEmbedding(chain.vector!, learned, {
      listingId: hashListingId(listingId),
      matchingConcepts,
      matchingNegativeConcepts,
    });
    const explanationId = await storeAiArtifact({
      listingId,
      task: "recommendation_explanation",
      providerName: "profile",
      modelName: algorithmVersion,
      promptVersion: "recommendation-explanation-v6",
      inputHash: await sha256Text(
        `${inputHash}:${listingId}:${chain.semanticOutputHash}`,
      ),
      outputText: ranked.explanation,
      outputHash: await sha256Text(ranked.explanation),
    });
    await env.DB.prepare(`
      INSERT INTO listing_scores (
        listing_id, profile_version_id, score, positive_similarity,
        negative_similarity, exploration_weight, explanation_artifact_id, scored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      listingId,
      profileVersionId,
      ranked.score,
      ranked.positiveSimilarity,
      ranked.negativeSimilarity,
      ranked.exploration ? 0.12 : 0,
      explanationId,
      now,
    ).run();
  }

  return {
    profileVersionId,
    profileVersion: version,
    votes: usable.length,
  };
}

function configuredProvenanceTarget(): EnrichmentProvenanceTarget {
  const config = readAiConfig();
  return {
    textProviderName: config.textProvider,
    textModelName: config.textModel,
    extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
    semanticDocumentVersion: SEMANTIC_DOCUMENT_VERSION,
    embeddingProviderName: config.embeddingProvider,
    embeddingModelName: config.embeddingModel,
  };
}

function profileAlgorithmVersion(
  target: EnrichmentProvenanceTarget,
  feedbackHash: string,
): string {
  return [
    "centroid-v14-cabinet-furniture-classification",
    PROFILE_SIGNAL_RESIDUAL_VERSION,
    target.textProviderName,
    target.textModelName,
    target.extractionPromptVersion,
    target.semanticDocumentVersion,
    target.embeddingProviderName,
    target.embeddingModelName,
    `dimensions:${expectedEmbeddingDimensions(target)}`,
    INTEREST_PROFILE_NARRATIVE_PROMPT_VERSION,
    `feedback:${feedbackHash.slice(0, 16)}`,
  ].join("|");
}

async function profileSignalFeedbackHash(
  feedback: readonly ProfileSignalFeedbackSnapshot[],
): Promise<string> {
  return sha256Text(JSON.stringify(feedback.map((entry) => ({
    id: entry.id,
    polarity: entry.polarity,
    normalizedConcept: entry.normalizedConcept,
    action: entry.action,
  }))));
}
