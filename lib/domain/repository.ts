import { and, eq, lt } from "drizzle-orm";
import type { AuctionDb } from "@/db";
import {
  aiArtifacts,
  embeddings,
  interestProfiles,
  listingActionDeadlines,
  listingDetails,
  listingImages,
  listingStubs,
  listingVotes,
  profileVersionVotes,
  profileVersions,
} from "@/db/schema";
import type { NormalizedListingDetail, NormalizedListingStub } from "./listings";
import type { InterestProfileVersion, ProfileTrainingLabel } from "./profiles";
import { parseBinaryVote, type BinaryVote } from "./votes";

export interface RecordStubOptions {
  readonly id?: string;
  readonly firstSeenRunId?: string | null;
}

export interface RecordAiArtifactInput {
  readonly id?: string;
  readonly subjectType: "listing" | "profile_version";
  readonly subjectId: string;
  readonly task:
    | "listing_extraction"
    | "listing_summary"
    | "semantic_document"
    | "recommendation_explanation"
    | "profile_summary";
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly outputText?: string | null;
  readonly outputJson?: unknown;
  readonly outputHash?: string | null;
  readonly generatedAt?: string;
}

export interface RecordEmbeddingInput {
  readonly id?: string;
  readonly subjectType: "listing" | "profile_version";
  readonly subjectId: string;
  readonly kind:
    | "listing_semantic_document"
    | "profile_positive_centroid"
    | "profile_negative_centroid";
  readonly providerName: string;
  readonly modelName: string;
  readonly inputHash: string;
  readonly vector: readonly number[];
  readonly generatedAt?: string;
}

export interface ImageDownloadMetadata {
  readonly localPath: string;
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly downloadedAt?: string;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertFiniteVector(vector: readonly number[]): void {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError("embedding vector must contain finite numbers");
  }
}

/**
 * All values reach D1 through Drizzle expressions, so source strings are bound
 * parameters rather than interpolated SQL. Initial scrape methods are insert-
 * only and idempotent by design.
 */
export function createDomainRepository(db: AuctionDb) {
  const findSeenListingId = async (
    sourceId: string,
    sourceListingId: string,
  ): Promise<string | null> => {
    const [row] = await db
      .select({ id: listingStubs.id })
      .from(listingStubs)
      .where(
        and(
          eq(listingStubs.sourceId, sourceId),
          eq(listingStubs.sourceListingId, sourceListingId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  };

  return {
    findSeenListingId,

    async recordStub(
      stub: NormalizedListingStub,
      options: RecordStubOptions = {},
    ): Promise<{ id: string; inserted: boolean }> {
      const id = options.id ?? newId("lst");
      const location = stub.visibleLocation;
      const inserted = await db
        .insert(listingStubs)
        .values({
          id,
          sourceId: stub.sourceId,
          sourceListingId: stub.sourceListingId,
          sourceUrl: stub.sourceUrl,
          title: stub.title,
          category: stub.category,
          lotNumber: stub.lotNumber,
          visibleCity: location?.city ?? null,
          visibleState: location?.state ?? null,
          visiblePostalCode: location?.postalCode ?? null,
          visibleCountryCode: location?.countryCode ?? null,
          locationEvidenceSource: location?.evidenceSource ?? null,
          thumbnailUrl: stub.thumbnailUrl,
          firstSeenRunId: options.firstSeenRunId ?? null,
          discoveredAt: stub.discoveredAt,
          contentHash: stub.contentHash,
        })
        .onConflictDoNothing()
        .returning({ id: listingStubs.id });

      if (inserted[0]) return { id: inserted[0].id, inserted: true };

      const existingId = await findSeenListingId(
        stub.sourceId,
        stub.sourceListingId,
      );
      if (!existingId) {
        throw new Error(
          "listing stub conflicted on canonical URL but no matching source listing ID was found",
        );
      }
      return { id: existingId, inserted: false };
    },

    async recordInitialDetail(
      listingId: string,
      detail: NormalizedListingDetail,
    ): Promise<{ inserted: boolean }> {
      const [stub] = await db
        .select({
          sourceId: listingStubs.sourceId,
          sourceListingId: listingStubs.sourceListingId,
          sourceUrl: listingStubs.sourceUrl,
        })
        .from(listingStubs)
        .where(eq(listingStubs.id, listingId))
        .limit(1);

      if (!stub) throw new Error(`listing stub ${listingId} does not exist`);
      if (
        stub.sourceId !== detail.sourceId ||
        stub.sourceListingId !== detail.sourceListingId ||
        stub.sourceUrl !== detail.sourceUrl
      ) {
        throw new Error("detail identity does not match its immutable listing stub");
      }

      const location = detail.pickupLocation;
      const inserted = await db
        .insert(listingDetails)
        .values({
          listingId,
          titleAtScrape: detail.title,
          categoryAtScrape: detail.category,
          lotNumberAtScrape: detail.lotNumber,
          rawDescription: detail.rawDescription,
          cleanDescription: detail.cleanDescription,
          priceAmountMinor: detail.priceAtScrape.amountMinor,
          priceCurrency: detail.priceAtScrape.currency,
          priceDisplayText: detail.priceAtScrape.displayText,
          auctionEndsAt: detail.auctionEndsAt,
          seller: detail.seller,
          pickupCity: location?.city ?? null,
          pickupState: location?.state ?? null,
          pickupPostalCode: location?.postalCode ?? null,
          pickupCountryCode: location?.countryCode ?? null,
          pickupEvidenceSource: location?.evidenceSource ?? null,
          scrapedAt: detail.scrapedAt,
          contentHash: detail.contentHash,
        })
        .onConflictDoNothing({ target: listingDetails.listingId })
        .returning({ listingId: listingDetails.listingId });

      if (detail.actionDeadline) {
        await db
          .insert(listingActionDeadlines)
          .values({
            listingId,
            deadlineAt: detail.actionDeadline.at,
            basis: detail.actionDeadline.basis,
            sourceText: detail.actionDeadline.sourceText,
            sourceUrl: detail.sourceUrl,
            detailContentHash: detail.contentHash,
            observedAt: detail.scrapedAt,
          })
          .onConflictDoNothing({ target: listingActionDeadlines.listingId });
      }

      // Idempotent inserts let a retry finish cataloguing images after a partial
      // failure without ever updating the immutable detail row.
      for (const image of detail.images) {
        await db
          .insert(listingImages)
          .values({
            id: newId("img"),
            listingId,
            position: image.position,
            isPrimary: image.isPrimary,
            sourceUrl: image.sourceUrl,
            thumbnailUrl: image.thumbnailUrl,
            downloadStatus: image.isPrimary ? "pending" : "deferred",
          })
          .onConflictDoNothing();
      }

      return { inserted: Boolean(inserted[0]) };
    },

    async markImageDownloaded(
      imageId: string,
      metadata: ImageDownloadMetadata,
    ): Promise<void> {
      if (
        !Number.isSafeInteger(metadata.width) ||
        metadata.width <= 0 ||
        !Number.isSafeInteger(metadata.height) ||
        metadata.height <= 0
      ) {
        throw new TypeError("downloaded image dimensions must be positive integers");
      }
      await db
        .update(listingImages)
        .set({
          downloadStatus: "downloaded",
          localPath: metadata.localPath,
          contentHash: metadata.contentHash,
          width: metadata.width,
          height: metadata.height,
          downloadedAt: metadata.downloadedAt ?? nowIso(),
          downloadError: null,
        })
        .where(eq(listingImages.id, imageId));
    },

    async markImageDownloadFailed(imageId: string, message: string): Promise<void> {
      await db
        .update(listingImages)
        .set({ downloadStatus: "failed", downloadError: message })
        .where(eq(listingImages.id, imageId));
    },

    async castVote(listingId: string, value: BinaryVote): Promise<void> {
      const vote = parseBinaryVote(value);
      const timestamp = nowIso();
      await db
        .insert(listingVotes)
        .values({ listingId, value: vote, createdAt: timestamp, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: listingVotes.listingId,
          set: { value: vote, updatedAt: timestamp },
        });
    },

    async recordAiArtifact(input: RecordAiArtifactInput): Promise<string> {
      if (input.outputText == null && input.outputJson === undefined) {
        throw new TypeError("AI artifact must have text or JSON output");
      }
      const id = input.id ?? newId("ai");
      const inserted = await db
        .insert(aiArtifacts)
        .values({
          id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          task: input.task,
          providerName: input.providerName,
          modelName: input.modelName,
          promptVersion: input.promptVersion,
          inputHash: input.inputHash,
          outputText: input.outputText ?? null,
          outputJson:
            input.outputJson === undefined ? null : JSON.stringify(input.outputJson),
          outputHash: input.outputHash ?? null,
          generatedAt: input.generatedAt ?? nowIso(),
        })
        .onConflictDoNothing()
        .returning({ id: aiArtifacts.id });
      if (inserted[0]) return inserted[0].id;

      const [existing] = await db
        .select({ id: aiArtifacts.id })
        .from(aiArtifacts)
        .where(
          and(
            eq(aiArtifacts.subjectType, input.subjectType),
            eq(aiArtifacts.subjectId, input.subjectId),
            eq(aiArtifacts.task, input.task),
            eq(aiArtifacts.providerName, input.providerName),
            eq(aiArtifacts.modelName, input.modelName),
            eq(aiArtifacts.promptVersion, input.promptVersion),
            eq(aiArtifacts.inputHash, input.inputHash),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("AI artifact insert conflicted unexpectedly");
      return existing.id;
    },

    async recordEmbedding(input: RecordEmbeddingInput): Promise<string> {
      assertFiniteVector(input.vector);
      const id = input.id ?? newId("emb");
      const inserted = await db
        .insert(embeddings)
        .values({
          id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
          providerName: input.providerName,
          modelName: input.modelName,
          inputHash: input.inputHash,
          dimensions: input.vector.length,
          vectorJson: JSON.stringify(input.vector),
          generatedAt: input.generatedAt ?? nowIso(),
        })
        .onConflictDoNothing()
        .returning({ id: embeddings.id });
      if (inserted[0]) return inserted[0].id;

      const [existing] = await db
        .select({ id: embeddings.id })
        .from(embeddings)
        .where(
          and(
            eq(embeddings.subjectType, input.subjectType),
            eq(embeddings.subjectId, input.subjectId),
            eq(embeddings.kind, input.kind),
            eq(embeddings.providerName, input.providerName),
            eq(embeddings.modelName, input.modelName),
            eq(embeddings.inputHash, input.inputHash),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("embedding insert conflicted unexpectedly");
      return existing.id;
    },

    async ensureProfile(profileId: string, name: string): Promise<void> {
      await db
        .insert(interestProfiles)
        .values({ id: profileId, name })
        .onConflictDoNothing({ target: interestProfiles.id });
    },

    async recordProfileVersion(
      profile: InterestProfileVersion,
      labels: readonly ProfileTrainingLabel[],
    ): Promise<void> {
      const inserted = await db
        .insert(profileVersions)
        .values({
          id: profile.id,
          profileId: profile.profileId,
          version: profile.version,
          algorithmVersion: profile.algorithmVersion,
          humanSummary: profile.humanSummary,
          interestedConceptsJson: JSON.stringify(profile.interestedConcepts),
          notInterestedConceptsJson: JSON.stringify(profile.notInterestedConcepts),
          interestedSupportCount: profile.interestedSupportCount,
          notInterestedSupportCount: profile.notInterestedSupportCount,
          basedOnVotesThrough: profile.basedOnVotesThrough,
          createdAt: profile.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: profileVersions.id });

      let profileVersionId = inserted[0]?.id;
      if (!profileVersionId) {
        const [existing] = await db
          .select({ id: profileVersions.id })
          .from(profileVersions)
          .where(
            and(
              eq(profileVersions.profileId, profile.profileId),
              eq(profileVersions.version, profile.version),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("profile version insert conflicted unexpectedly");
        if (existing.id !== profile.id) {
          throw new Error(
            `profile version ${profile.profileId}/${profile.version} already has a different immutable ID`,
          );
        }
        profileVersionId = existing.id;
      }

      for (const label of labels) {
        await db
          .insert(profileVersionVotes)
          .values({
            profileVersionId,
            listingId: label.listingId,
            value: parseBinaryVote(label.vote),
          })
          .onConflictDoNothing();
      }

      await db
        .update(interestProfiles)
        .set({ currentVersion: profile.version, updatedAt: nowIso() })
        .where(
          and(
            eq(interestProfiles.id, profile.profileId),
            lt(interestProfiles.currentVersion, profile.version),
          ),
        );
    },
  };
}

export type DomainRepository = ReturnType<typeof createDomainRepository>;
