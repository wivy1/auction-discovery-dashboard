
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
const nowUtc = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
export const sourceAcquisitionState = sqliteTable(
  "source_acquisition_state",
  {
    sourceId: text("source_id").primaryKey(),
    generation: integer("generation").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("source_acquisition_state_generation_check", sql`${table.generation} >= 1`),
  ],
);
export const sourceAcquisitionPublications = sqliteTable(
  "source_acquisition_publications",
  {
    proofId: text("proof_id").primaryKey(),
    sourceId: text("source_id").notNull(),
    reservationId: text("reservation_id").notNull().unique(),
    bundleIdentity: text("bundle_identity").notNull(),
    resultingInventoryRunId: text("resulting_inventory_run_id").notNull(),
    resultingUnionCount: integer("resulting_union_count").notNull(),
    publishedAt: text("published_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("source_acquisition_publications_count_check", sql`${table.resultingUnionCount} >= 0`),
  ],
);
export const sourcePermissionStatuses = [
  "allowed",
  "review_required",
  "disabled",
] as const;
export const runStatuses = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;
export const runTriggers = ["manual", "scheduled"] as const;
export const enrichmentRunStatuses = [
  "running",
  "completed",
  "partial",
  "failed",
  "stopped",
] as const;
export const pipelineRunKinds = ["discovery", "enrichment"] as const;
export const driveBuckets = [
  "under_2h",
  "under_4h",
  "under_8h",
  "exclude",
] as const;
export const voteValues = ["interested", "not_interested"] as const;
export const lotFeedbackDecisions = ["lot", "not_lot", "automatic"] as const;
export const profileSignalPolarities = ["positive", "negative"] as const;
export const profileSignalActions = ["removed", "restored"] as const;
export const preferenceModelActivationEventTypes = ["promote", "disable"] as const;
export const preferenceModelActivationAuthorities = [
  "operator",
  "automatic_fail_closed",
] as const;
export const preferenceModelActivationReasonCodes = [
  "operator_promote",
  "operator_disable",
  "artifact_or_implementation_drift",
  "profile_or_input_drift",
  "provider_or_resource_failure",
  "incomplete_scoring_run",
] as const;
export const imageDownloadStatuses = [
  "deferred",
  "pending",
  "downloaded",
  "failed",
] as const;
export const imageAcquisitionMethods = [
  "browser",
  "direct",
  "resolved_endpoint",
] as const;
export const aiSubjectTypes = ["listing", "profile_version"] as const;
export const aiTaskTypes = [
  "listing_extraction",
  "listing_summary",
  "semantic_document",
  "recommendation_explanation",
  "profile_summary",
] as const;
export const embeddingKinds = [
  "listing_semantic_document",
  "profile_positive_centroid",
  "profile_negative_centroid",
] as const;
export const pipelineScopeTypes = ["listing", "source", "group", "global"] as const;
export const pipelineWorkStages = [
  "projection_listing_refresh",
  "projection_source_refresh",
  "projection_group_refresh",
  "projection_global_refresh",
  "detail",
  "action_deadline",
  "owner_refresh",
  "factual_supplement",
  "image_evidence",
  "primary_image",
  "proximity",
  "enrichment_text",
  "enrichment_embedding",
  "preference_v2_score",
  "source_release",
  "source_acquisition_readiness",
] as const;
export const operationalOwnerStates = [
  "native_primary",
  "publisher_primary",
  "shared_alias",
  "upstream_representative",
  "unresolved",
  "other",
] as const;
export const operationalCounterpartStates = [
  "present",
  "absent_with_complete_proof",
  "unknown",
] as const;
export const sourceCoverageModes = [
  "complete_current",
  "discovery_frontier",
] as const;
export const sourceAccessStates = [
  "ready",
  "cooldown",
  "manual_reset_required",
] as const;
export const appSettings = sqliteTable(
  "app_settings",
  {
    singleton: integer("singleton").primaryKey(),
    originPostalCode: text("origin_postal_code").notNull(),
    originCountry: text("origin_country").notNull().default("US"),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    check("app_settings_singleton_check", sql`${table.singleton} = 1`),
    check(
      "app_settings_origin_postal_check",
      sql`length(${table.originPostalCode}) = 5 and ${table.originPostalCode} not glob '*[^0-9]*'`,
    ),
    check(
      "app_settings_origin_country_check",
      sql`${table.originCountry} = 'US'`,
    ),
  ],
);
export const auctionSources = sqliteTable(
  "auction_sources",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    permissionStatus: text("permission_status", {
      enum: sourcePermissionStatuses,
    })
      .notNull()
      .default("review_required"),
    pickupLocationVisibility: text("pickup_location_visibility", {
      enum: ["listing", "detail", "mixed"] as const,
    })
      .notNull()
      .default("mixed"),
    createdAt: text("created_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    check(
      "auction_sources_permission_status_check",
      sql`${table.permissionStatus} in ('allowed', 'review_required', 'disabled')`,
    ),
    check(
      "auction_sources_location_visibility_check",
      sql`${table.pickupLocationVisibility} in ('listing', 'detail', 'mixed')`,
    ),
  ],
);
export const discoveryRuns = sqliteTable(
  "discovery_runs",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger", { enum: runTriggers }).notNull(),
    status: text("status", { enum: runStatuses }).notNull().default("queued"),
    originPostalCode: text("origin_postal_code").notNull(),
    startedAt: text("started_at").notNull().default(nowUtc),
    completedAt: text("completed_at"),
    listingsDiscovered: integer("listings_discovered").notNull().default(0),
    listingsNew: integer("listings_new").notNull().default(0),
    listingsAccepted: integer("listings_accepted").notNull().default(0),
    listingsExcluded: integer("listings_excluded").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("discovery_runs_started_at_idx").on(table.startedAt),
    index("discovery_runs_status_idx").on(table.status),
    check(
      "discovery_runs_trigger_check",
      sql`${table.trigger} in ('manual', 'scheduled')`,
    ),
    check(
      "discovery_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')`,
    ),
  ],
);
export const enrichmentRuns = sqliteTable(
  "enrichment_runs",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: enrichmentRunStatuses }).notNull(),
    originPostalCode: text("origin_postal_code").notNull(),
    startedAt: text("started_at").notNull().default(nowUtc),
    completedAt: text("completed_at"),
    requestedLimit: integer("requested_limit").notNull(),
    effectiveLimit: integer("effective_limit").notNull(),
    pendingAtStart: integer("pending_at_start").notNull().default(0),
    attempted: integer("attempted").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    remaining: integer("remaining").notNull().default(0),
    textProviderName: text("text_provider_name").notNull(),
    textModelName: text("text_model_name").notNull(),
    extractionPromptVersion: text("extraction_prompt_version").notNull(),
    semanticDocumentVersion: text("semantic_document_version").notNull(),
    embeddingProviderName: text("embedding_provider_name").notNull(),
    embeddingModelName: text("embedding_model_name").notNull(),
    profileVotesUsed: integer("profile_votes_used").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("enrichment_runs_started_at_idx").on(table.startedAt),
    index("enrichment_runs_status_idx").on(table.status),
    check(
      "enrichment_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'partial', 'failed', 'stopped')`,
    ),
    check(
      "enrichment_runs_limits_check",
      sql`${table.requestedLimit} between 0 and 10 and ${table.effectiveLimit} between 0 and 10`,
    ),
    check(
      "enrichment_runs_counts_check",
      sql`${table.pendingAtStart} >= 0 and ${table.attempted} >= 0 and ${table.completedCount} >= 0 and ${table.failures} >= 0 and ${table.remaining} >= 0 and ${table.profileVotesUsed} >= 0 and ${table.completedCount} <= ${table.attempted} and ${table.failures} <= 1`,
    ),
  ],
);
export const pipelineRunLease = sqliteTable(
  "pipeline_run_lease",
  {
    singleton: integer("singleton").primaryKey(),
    runKind: text("run_kind", { enum: pipelineRunKinds }).notNull(),
    runId: text("run_id").notNull(),
    acquiredAt: text("acquired_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    check("pipeline_run_lease_singleton_check", sql`${table.singleton} = 1`),
    check(
      "pipeline_run_lease_kind_check",
      sql`${table.runKind} in ('discovery', 'enrichment')`,
    ),
  ],
);
export const sourceRuns = sqliteTable(
  "source_runs",
  {
    id: text("id").primaryKey(),
    discoveryRunId: text("discovery_run_id")
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    status: text("status", { enum: runStatuses }).notNull().default("queued"),
    startedAt: text("started_at").notNull().default(nowUtc),
    completedAt: text("completed_at"),
    stubsDiscovered: integer("stubs_discovered").notNull().default(0),
    skippedAlreadySeen: integer("skipped_already_seen").notNull().default(0),
    detailsFetched: integer("details_fetched").notNull().default(0),
    listingsAccepted: integer("listings_accepted").notNull().default(0),
    listingsExcluded: integer("listings_excluded").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("source_runs_run_source_uidx").on(
      table.discoveryRunId,
      table.sourceId,
    ),
    index("source_runs_status_idx").on(table.status),
    check(
      "source_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')`,
    ),
  ],
);
export const listingStubs = sqliteTable(
  "listing_stubs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    sourceListingId: text("source_listing_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    lotNumber: text("lot_number"),
    visibleCity: text("visible_city"),
    visibleState: text("visible_state"),
    visiblePostalCode: text("visible_postal_code"),
    visibleCountryCode: text("visible_country_code"),
    locationEvidenceSource: text("location_evidence_source"),
    thumbnailUrl: text("thumbnail_url"),
    firstSeenRunId: text("first_seen_run_id").references(() => discoveryRuns.id),
    discoveredAt: text("discovered_at").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    uniqueIndex("listing_stubs_source_listing_uidx").on(
      table.sourceId,
      table.sourceListingId,
    ),
    uniqueIndex("listing_stubs_source_url_uidx").on(
      table.sourceId,
      table.sourceUrl,
    ),
    index("listing_stubs_discovered_at_idx").on(table.discoveredAt),
    index("listing_stubs_content_hash_idx").on(table.contentHash),
  ],
);
export const sourceCurrentListings = sqliteTable(
  "source_current_listings",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    inventoryRunId: text("inventory_run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    observedAt: text("observed_at").notNull(),
    reviewCandidate: integer("review_candidate", { mode: "boolean" })
      .notNull()
      .default(true),
  },
  (table) => [
    index("source_current_listings_source_idx").on(
      table.sourceId,
      table.observedAt,
    ),
    check(
      "source_current_listings_review_candidate_check",
      sql`${table.reviewCandidate} in (0, 1)`,
    ),
  ],
);
export const sourceInventoryPublications = sqliteTable(
  "source_inventory_publications",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    inventoryRunId: text("inventory_run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    listingCount: integer("listing_count").notNull(),
    collectionCountsJson: text("collection_counts_json")
      .notNull()
      .default("[]"),
    publishedAt: text("published_at").notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.inventoryRunId] }),
    index("source_inventory_publications_run_idx").on(table.inventoryRunId),
    check(
      "source_inventory_publications_counts_check",
      sql`${table.listingCount} >= 0`,
    ),
    check(
      "source_inventory_publications_collection_counts_check",
      sql`json_valid(${table.collectionCountsJson}) and json_type(${table.collectionCountsJson}) = 'array'`,
    ),
  ],
);
export const sourceInventoryPublicationHeads = sqliteTable(
  "source_inventory_publication_heads",
  {
    sourceId: text("source_id")
      .primaryKey()
      .references(() => auctionSources.id),
    inventoryRunId: text("inventory_run_id").notNull(),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceId, table.inventoryRunId],
      foreignColumns: [
        sourceInventoryPublications.sourceId,
        sourceInventoryPublications.inventoryRunId,
      ],
    }),
  ],
);
export const adhocReviewCohorts = sqliteTable(
  "adhoc_review_cohorts",
  {
    id: text("id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    state: text("state", { enum: ["building", "ready"] as const })
      .notNull()
      .default("building"),
    refreshBoundary: text("refresh_boundary").notNull(),
    originCacheKey: text("origin_cache_key").notNull(),
    routeProviderName: text("route_provider_name").notNull(),
    selectionSeed: text("selection_seed").notNull(),
    selectionVersion: text("selection_version").notNull(),
    requestedTarget: integer("requested_target").notNull(),
    selectedCount: integer("selected_count").notNull().default(0),
    ordinaryAcceptedCount: integer("ordinary_accepted_count").notNull().default(0),
    distanceExemptCount: integer("distance_exempt_count").notNull().default(0),
    sourceCount: integer("source_count").notNull(),
    headVectorHash: text("head_vector_hash").notNull(),
    baseCohortId: text("base_cohort_id"),
    createdAt: text("created_at").notNull().default(nowUtc),
    readyAt: text("ready_at"),
  },
  (table) => [
    check(
      "adhoc_review_cohorts_schema_check",
      sql`${table.schemaVersion} = 'adhoc-review-cohort-v1'`,
    ),
    check(
      "adhoc_review_cohorts_state_check",
      sql`${table.state} in ('building', 'ready')`,
    ),
    check(
      "adhoc_review_cohorts_counts_check",
      sql`${table.requestedTarget} between 1 and 5000 and ${table.selectedCount} between 0 and 5000 and ${table.ordinaryAcceptedCount} between 0 and ${table.selectedCount} and ${table.distanceExemptCount} = ${table.selectedCount} - ${table.ordinaryAcceptedCount} and ${table.sourceCount} between 1 and 100`,
    ),
    check(
      "adhoc_review_cohorts_ready_check",
      sql`(${table.state} = 'building' and ${table.readyAt} is null) or (${table.state} = 'ready' and ${table.readyAt} is not null and ${table.selectedCount} >= 1)`,
    ),
  ],
);
export const adhocReviewCohortSources = sqliteTable(
  "adhoc_review_cohort_sources",
  {
    cohortId: text("cohort_id")
      .notNull()
      .references(() => adhocReviewCohorts.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    inventoryRunId: text("inventory_run_id").notNull(),
    listingCount: integer("listing_count").notNull(),
    publishedAt: text("published_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.cohortId, table.sourceId] }),
    uniqueIndex("adhoc_review_cohort_sources_binding_uidx").on(
      table.cohortId,
      table.sourceId,
      table.inventoryRunId,
    ),
    foreignKey({
      columns: [table.sourceId, table.inventoryRunId],
      foreignColumns: [
        sourceInventoryPublications.sourceId,
        sourceInventoryPublications.inventoryRunId,
      ],
    }),
    check(
      "adhoc_review_cohort_sources_count_check",
      sql`${table.listingCount} >= 0`,
    ),
  ],
);
export const adhocReviewCohortMemberships = sqliteTable(
  "adhoc_review_cohort_memberships",
  {
    cohortId: text("cohort_id").notNull(),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id),
    sourceId: text("source_id").notNull(),
    inventoryRunId: text("inventory_run_id").notNull(),
    basis: text("basis", {
      enum: ["ordinary_accepted", "distance_exempt"] as const,
    }).notNull(),
    categoryStratum: text("category_stratum").notNull(),
    stateStratum: text("state_stratum").notNull(),
    stableSelectionKey: text("stable_selection_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    selectedAt: text("selected_at").notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.cohortId, table.listingId] }),
    uniqueIndex("adhoc_review_cohort_memberships_ordinal_uidx").on(
      table.cohortId,
      table.ordinal,
    ),
    index("adhoc_review_cohort_memberships_source_idx").on(
      table.cohortId,
      table.sourceId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.cohortId, table.sourceId, table.inventoryRunId],
      foreignColumns: [
        adhocReviewCohortSources.cohortId,
        adhocReviewCohortSources.sourceId,
        adhocReviewCohortSources.inventoryRunId,
      ],
    }),
    check(
      "adhoc_review_cohort_memberships_basis_check",
      sql`${table.basis} in ('ordinary_accepted', 'distance_exempt')`,
    ),
    check(
      "adhoc_review_cohort_memberships_ordinal_check",
      sql`${table.ordinal} between 1 and 5000`,
    ),
  ],
);
export const sourceInventoryObservations = sqliteTable(
  "source_inventory_observations",
  {
    runId: text("run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.listingId] }),
    index("source_inventory_observations_source_run_idx").on(
      table.sourceId,
      table.runId,
    ),
  ],
);
export const sourceOriginPriorityObservations = sqliteTable(
  "source_origin_priority_observations",
  {
    runId: text("run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    originCacheKey: text("origin_cache_key").notNull(),
    originPostalCode: text("origin_postal_code").notNull(),
    radiusMiles: integer("radius_miles").notNull(),
    observedAt: text("observed_at").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.listingId, table.originCacheKey],
    }),
    index("source_origin_priority_observations_lookup_idx").on(
      table.sourceId,
      table.originCacheKey,
      table.observedAt,
      table.listingId,
    ),
    check(
      "source_origin_priority_origin_check",
      sql`${table.originPostalCode} glob '[0-9][0-9][0-9][0-9][0-9]'`,
    ),
    check(
      "source_origin_priority_radius_check",
      sql`${table.radiusMiles} between 1 and 1000`,
    ),
    check(
      "source_origin_priority_cache_key_check",
      sql`length(${table.originCacheKey}) between 1 and 512`,
    ),
    check(
      "source_origin_priority_content_hash_check",
      sql`length(${table.contentHash}) between 1 and 256`,
    ),
  ],
);
export const sourceInventoryTraversals = sqliteTable(
  "source_inventory_traversals",
  {
    traversalId: text("traversal_id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .unique()
      .references(() => auctionSources.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    expectedPages: integer("expected_pages").notNull(),
    expectedListings: integer("expected_listings").notNull(),
    startedAt: text("started_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    check(
      "source_inventory_traversals_expected_pages_check",
      sql`${table.expectedPages} >= 1`,
    ),
    check(
      "source_inventory_traversals_expected_listings_check",
      sql`${table.expectedListings} >= 0`,
    ),
  ],
);
export const sourceInventoryAcquisitionAttempts = sqliteTable(
  "source_inventory_acquisition_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .unique()
      .references(() => auctionSources.id, { onDelete: "cascade" }),
    traversalId: text("traversal_id")
      .unique()
      .references(() => sourceInventoryTraversals.traversalId, {
        onDelete: "cascade",
      }),
    reservedRequestUnits: integer("reserved_request_units").notNull(),
    maxRequestUnits: integer("max_request_units").notNull(),
    activePlanFingerprint: text("active_plan_fingerprint"),
    startedAt: text("started_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    check(
      "source_inventory_acquisition_attempts_reserved_check",
      sql`${table.reservedRequestUnits} >= 0
        and ${table.reservedRequestUnits} <= ${table.maxRequestUnits}`,
    ),
    check(
      "source_inventory_acquisition_attempts_max_check",
      sql`${table.maxRequestUnits} >= 1`,
    ),
    check(
      "source_inventory_acquisition_attempts_plan_check",
      sql`${table.activePlanFingerprint} is null
        or (
          length(${table.activePlanFingerprint}) = 64
          and ${table.activePlanFingerprint} not glob '*[^0-9a-f]*'
        )`,
    ),
  ],
);
export const sourceInventoryTraversalPages = sqliteTable(
  "source_inventory_traversal_pages",
  {
    traversalId: text("traversal_id")
      .notNull()
      .references(() => sourceInventoryTraversals.traversalId, {
        onDelete: "cascade",
      }),
    pageKey: text("page_key").notNull(),
    completedAt: text("completed_at"),
    observedCount: integer("observed_count").notNull().default(0),
    inventoryMember: integer("inventory_member", { mode: "boolean" }).notNull(),
    reviewCandidate: integer("review_candidate", { mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.traversalId, table.pageKey] }),
    check(
      "source_inventory_traversal_pages_observed_count_check",
      sql`${table.observedCount} >= 0`,
    ),
    check(
      "source_inventory_traversal_pages_inventory_member_check",
      sql`${table.inventoryMember} in (0, 1)`,
    ),
    check(
      "source_inventory_traversal_pages_review_candidate_check",
      sql`${table.reviewCandidate} in (0, 1)`,
    ),
  ],
);
export const sourceInventoryTraversalListings = sqliteTable(
  "source_inventory_traversal_listings",
  {
    traversalId: text("traversal_id")
      .notNull()
      .references(() => sourceInventoryTraversals.traversalId, {
        onDelete: "cascade",
      }),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => auctionSources.id, { onDelete: "cascade" }),
    partitionKey: text("partition_key").notNull().default("legacy"),
    observedAt: text("observed_at").notNull(),
    factHash: text("fact_hash"),
    inventoryMember: integer("inventory_member", { mode: "boolean" })
      .notNull()
      .default(false),
    reviewCandidate: integer("review_candidate", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    primaryKey({ columns: [table.traversalId, table.listingId] }),
    check(
      "source_inventory_traversal_listings_partition_key_check",
      sql`length(${table.partitionKey}) between 1 and 256`,
    ),
    check(
      "source_inventory_traversal_listings_fact_hash_check",
      sql`${table.factHash} is null or (length(${table.factHash}) = 24 and substr(${table.factHash}, 1, 8) = 'fnv1a64:' and substr(${table.factHash}, 9) not glob '*[^0-9a-f]*')`,
    ),
    check(
      "source_inventory_traversal_listings_inventory_member_check",
      sql`${table.inventoryMember} in (0, 1)`,
    ),
    check(
      "source_inventory_traversal_listings_review_candidate_check",
      sql`${table.reviewCandidate} in (0, 1)`,
    ),
  ],
);
export const dashboardNewListings = sqliteTable(
  "dashboard_new_listings",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    firstSeenRunId: text("first_seen_run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    addedAt: text("added_at").notNull().default(nowUtc),
  },
);
export const listingDetails = sqliteTable(
  "listing_details",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    titleAtScrape: text("title_at_scrape").notNull(),
    categoryAtScrape: text("category_at_scrape"),
    lotNumberAtScrape: text("lot_number_at_scrape"),
    rawDescription: text("raw_description").notNull(),
    cleanDescription: text("clean_description").notNull(),
    priceAmountMinor: integer("price_amount_minor"),
    priceCurrency: text("price_currency"),
    priceDisplayText: text("price_display_text"),
    auctionEndsAt: text("auction_ends_at"),
    seller: text("seller"),
    pickupCity: text("pickup_city"),
    pickupState: text("pickup_state"),
    pickupPostalCode: text("pickup_postal_code"),
    pickupCountryCode: text("pickup_country_code"),
    pickupEvidenceSource: text("pickup_evidence_source"),
    scrapedAt: text("scraped_at").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    index("listing_details_ends_at_idx").on(table.auctionEndsAt),
    index("listing_details_pickup_postal_idx").on(table.pickupPostalCode),
    check(
      "listing_details_price_amount_check",
      sql`${table.priceAmountMinor} is null or ${table.priceAmountMinor} >= 0`,
    ),
  ],
);
export const upstreamLotRepresentatives = sqliteTable(
  "upstream_lot_representatives",
  {
    platform: text("platform").notNull(),
    host: text("host").notNull(),
    eventOrCatalogId: text("event_or_catalog_id").notNull(),
    lotId: text("lot_id").notNull(),
    ownerListingId: text("owner_listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    assignedAt: text("assigned_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.platform,
        table.host,
        table.eventOrCatalogId,
        table.lotId,
      ],
    }),
    uniqueIndex("upstream_lot_representatives_owner_uidx").on(
      table.ownerListingId,
    ),
    check(
      "upstream_lot_representatives_identity_check",
      sql`length(${table.platform}) between 1 and 100 and length(${table.host}) between 1 and 253 and length(${table.eventOrCatalogId}) between 1 and 512 and length(${table.lotId}) between 1 and 512`,
    ),
    check(
      "upstream_lot_representatives_host_check",
      sql`${table.host} = lower(${table.host}) and instr(${table.host}, '/') = 0 and instr(${table.host}, ':') = 0`,
    ),
  ],
);
export const listingUpstreamProvenance = sqliteTable(
  "listing_upstream_provenance",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    host: text("host").notNull(),
    eventOrCatalogId: text("event_or_catalog_id").notNull(),
    lotId: text("lot_id").notNull(),
    eventName: text("event_name"),
    eventUrl: text("event_url"),
    observedAliasesJson: text("observed_aliases_json").notNull().default("[]"),
    publisherEventJson: text("publisher_event_json"),
    observedAt: text("observed_at").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.platform,
        table.host,
        table.eventOrCatalogId,
        table.lotId,
      ],
      foreignColumns: [
        upstreamLotRepresentatives.platform,
        upstreamLotRepresentatives.host,
        upstreamLotRepresentatives.eventOrCatalogId,
        upstreamLotRepresentatives.lotId,
      ],
    }),
    index("listing_upstream_provenance_identity_idx").on(
      table.platform,
      table.host,
      table.eventOrCatalogId,
      table.lotId,
    ),
    check(
      "listing_upstream_provenance_identity_check",
      sql`length(${table.platform}) between 1 and 100 and length(${table.host}) between 1 and 253 and length(${table.eventOrCatalogId}) between 1 and 512 and length(${table.lotId}) between 1 and 512`,
    ),
    check(
      "listing_upstream_provenance_host_check",
      sql`${table.host} = lower(${table.host}) and instr(${table.host}, '/') = 0 and instr(${table.host}, ':') = 0`,
    ),
    check(
      "listing_upstream_provenance_event_check",
      sql`(${table.eventName} is null or length(${table.eventName}) between 1 and 1000) and (${table.eventUrl} is null or ${table.eventUrl} like 'https://%')`,
    ),
    check(
      "listing_upstream_provenance_aliases_check",
      sql`json_valid(${table.observedAliasesJson}) and json_type(${table.observedAliasesJson}) = 'array'`,
    ),
    check(
      "listing_upstream_provenance_publisher_event_check",
      sql`${table.publisherEventJson} is null or (json_valid(${table.publisherEventJson}) and json_type(${table.publisherEventJson}) = 'object')`,
    ),
    check(
      "listing_upstream_provenance_hash_check",
      sql`length(${table.contentHash}) = 24 and substr(${table.contentHash}, 1, 8) = 'fnv1a64:' and substr(${table.contentHash}, 9) not glob '*[^0-9a-f]*'`,
    ),
  ],
);
export const listingUpstreamAliasObservations = sqliteTable(
  "listing_upstream_alias_observations",
  {
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    observedCanonicalUrl: text("observed_canonical_url").notNull(),
    platform: text("platform").notNull(),
    host: text("host").notNull(),
    eventOrCatalogId: text("event_or_catalog_id").notNull(),
    lotId: text("lot_id").notNull(),
    eventName: text("event_name"),
    eventUrl: text("event_url"),
    observedAt: text("observed_at").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.listingId, table.observedCanonicalUrl] }),
    index("listing_upstream_alias_observations_identity_idx").on(
      table.platform,
      table.host,
      table.eventOrCatalogId,
      table.lotId,
    ),
    check(
      "listing_upstream_alias_observations_identity_check",
      sql`length(${table.platform}) between 1 and 100 and length(${table.host}) between 1 and 253 and length(${table.eventOrCatalogId}) between 1 and 512 and length(${table.lotId}) between 1 and 512`,
    ),
    check(
      "listing_upstream_alias_observations_urls_check",
      sql`${table.host} = lower(${table.host}) and ${table.observedCanonicalUrl} like 'https://%' and (${table.eventUrl} is null or ${table.eventUrl} like 'https://%')`,
    ),
    check(
      "listing_upstream_alias_observations_hash_check",
      sql`length(${table.contentHash}) = 24 and substr(${table.contentHash}, 1, 8) = 'fnv1a64:' and substr(${table.contentHash}, 9) not glob '*[^0-9a-f]*'`,
    ),
  ],
);
export const listingDetailObservations = sqliteTable(
  "listing_detail_observations",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    auctionEndsAt: text("auction_ends_at"),
    sourceUrl: text("source_url").notNull(),
    detailContentHash: text("detail_content_hash").notNull(),
    observedAt: text("observed_at").notNull(),
    importedAt: text("imported_at").notNull().default(nowUtc),
  },
  (table) => [
    check(
      "listing_detail_observations_title_check",
      sql`length(trim(${table.title})) > 0`,
    ),
    check(
      "listing_detail_observations_hash_check",
      sql`length(${table.detailContentHash}) = 24 and substr(${table.detailContentHash}, 1, 8) = 'fnv1a64:' and substr(${table.detailContentHash}, 9) not glob '*[^0-9a-f]*'`,
    ),
  ],
);
export const listingActionDeadlines = sqliteTable(
  "listing_action_deadlines",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    deadlineAt: text("deadline_at").notNull(),
    basis: text("basis", {
      enum: ["live_auction_start"] as const,
    }).notNull(),
    sourceText: text("source_text").notNull(),
    sourceUrl: text("source_url").notNull(),
    detailContentHash: text("detail_content_hash").notNull(),
    observedAt: text("observed_at").notNull(),
    importedAt: text("imported_at").notNull().default(nowUtc),
  },
  (table) => [
    check(
      "listing_action_deadlines_timestamp_check",
      sql`${table.deadlineAt} glob '????-??-??T??:??:??.???Z' and julianday(${table.deadlineAt}) is not null`,
    ),
    check(
      "listing_action_deadlines_basis_check",
      sql`${table.basis} = 'live_auction_start'`,
    ),
    check(
      "listing_action_deadlines_source_text_check",
      sql`length(trim(${table.sourceText})) between 1 and 200`,
    ),
    check(
      "listing_action_deadlines_source_url_check",
      sql`${table.sourceUrl} glob 'https://*'`,
    ),
    check(
      "listing_action_deadlines_hash_check",
      sql`length(${table.detailContentHash}) = 24 and substr(${table.detailContentHash}, 1, 8) = 'fnv1a64:' and substr(${table.detailContentHash}, 9) not glob '*[^0-9a-f]*'`,
    ),
  ],
);
export const listingImages = sqliteTable(
  "listing_images",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    sourceUrl: text("source_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    downloadStatus: text("download_status", {
      enum: imageDownloadStatuses,
    })
      .notNull()
      .default("deferred"),
    localPath: text("local_path"),
    contentHash: text("content_hash"),
    width: integer("width"),
    height: integer("height"),
    downloadedAt: text("downloaded_at"),
    downloadError: text("download_error"),
    downloadErrorCode: text("download_error_code"),
    acquisitionMethod: text("acquisition_method", {
      enum: imageAcquisitionMethods,
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptedAt: text("last_attempted_at"),
  },
  (table) => [
    uniqueIndex("listing_images_position_uidx").on(
      table.listingId,
      table.position,
    ),
    uniqueIndex("listing_images_source_url_uidx").on(
      table.listingId,
      table.sourceUrl,
    ),
    uniqueIndex("listing_images_one_primary_uidx")
      .on(table.listingId)
      .where(sql`${table.isPrimary} = 1`),
    index("listing_images_repair_queue_idx").on(
      table.isPrimary,
      table.downloadStatus,
      table.attemptCount,
      table.lastAttemptedAt,
    ),
    check("listing_images_position_check", sql`${table.position} >= 0`),
    check(
      "listing_images_download_status_check",
      sql`${table.downloadStatus} in ('deferred', 'pending', 'downloaded', 'failed')`,
    ),
    check(
      "listing_images_dimensions_check",
      sql`(${table.width} is null or ${table.width} > 0) and (${table.height} is null or ${table.height} > 0)`,
    ),
    check(
      "listing_images_acquisition_method_check",
      sql`${table.acquisitionMethod} is null or ${table.acquisitionMethod} in ('browser', 'direct', 'resolved_endpoint')`,
    ),
    check(
      "listing_images_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);
export const locations = sqliteTable(
  "locations",
  {
    id: text("id").primaryKey(),
    cacheKey: text("cache_key").notNull(),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    countryCode: text("country_code").notNull().default("US"),
    displayName: text("display_name"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    resolutionStatus: text("resolution_status", {
      enum: ["pending", "resolved", "unknown", "failed"] as const,
    })
      .notNull()
      .default("pending"),
    geocodeProvider: text("geocode_provider"),
    geocodedAt: text("geocoded_at"),
    geocodeError: text("geocode_error"),
    createdAt: text("created_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    uniqueIndex("locations_cache_key_uidx").on(table.cacheKey),
    index("locations_postal_code_idx").on(table.postalCode),
    check(
      "locations_coordinates_check",
      sql`(${table.latitude} is null and ${table.longitude} is null) or (${table.latitude} between -90 and 90 and ${table.longitude} between -180 and 180)`,
    ),
    check(
      "locations_resolution_status_check",
      sql`${table.resolutionStatus} in ('pending', 'resolved', 'unknown', 'failed')`,
    ),
  ],
);
export const routeCache = sqliteTable(
  "route_cache",
  {
    id: text("id").primaryKey(),
    originCacheKey: text("origin_cache_key").notNull(),
    destinationLocationId: text("destination_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    providerName: text("provider_name").notNull(),
    inputHash: text("input_hash").notNull(),
    driveSeconds: integer("drive_seconds"),
    distanceMeters: integer("distance_meters"),
    driveBucket: text("drive_bucket", { enum: driveBuckets })
      .notNull()
      .default("exclude"),
    isApproximate: integer("is_approximate", { mode: "boolean" })
      .notNull()
      .default(false),
    calculatedAt: text("calculated_at").notNull().default(nowUtc),
    errorCode: text("error_code"),
  },
  (table) => [
    uniqueIndex("route_cache_input_uidx").on(
      table.originCacheKey,
      table.destinationLocationId,
      table.providerName,
      table.inputHash,
    ),
    index("route_cache_bucket_idx").on(table.driveBucket),
    check(
      "route_cache_bucket_check",
      sql`${table.driveBucket} in ('under_2h', 'under_4h', 'under_8h', 'exclude')`,
    ),
    check(
      "route_cache_drive_seconds_check",
      sql`${table.driveSeconds} is null or ${table.driveSeconds} >= 0`,
    ),
  ],
);
export const listingRoutes = sqliteTable(
  "listing_routes",
  {
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    routeCacheId: text("route_cache_id")
      .notNull()
      .references(() => routeCache.id, { onDelete: "cascade" }),
    assignedAt: text("assigned_at").notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.listingId, table.routeCacheId] }),
    uniqueIndex("listing_routes_listing_uidx").on(table.listingId),
  ],
);
export const listingRecoveryStatus = sqliteTable(
  "listing_recovery_status",
  {
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    originCacheKey: text("origin_cache_key").notNull(),
    state: text("state", { enum: ["retryable", "terminal"] as const }).notNull(),
    stage: text("stage", {
      enum: ["scope", "prefilter", "detail", "route", "image", "pipeline"] as const,
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    lastAttemptedAt: text("last_attempted_at").notNull().default(nowUtc),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.listingId, table.originCacheKey] }),
    index("listing_recovery_status_queue_idx").on(
      table.originCacheKey,
      table.state,
      table.lastAttemptedAt,
    ),
    check(
      "listing_recovery_status_state_check",
      sql`${table.state} in ('retryable', 'terminal')`,
    ),
    check(
      "listing_recovery_status_stage_check",
      sql`${table.stage} in ('scope', 'prefilter', 'detail', 'route', 'image', 'pipeline')`,
    ),
    check(
      "listing_recovery_status_attempt_check",
      sql`${table.attemptCount} >= 1`,
    ),
  ],
);
export const listingDetailTerminalStatus = sqliteTable(
  "listing_detail_terminal_status",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    errorCode: text("error_code", {
      enum: ["detail_access_restricted", "detail_location_conflict"] as const,
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    lastAttemptedAt: text("last_attempted_at").notNull().default(nowUtc),
  },
  (table) => [
    check(
      "listing_detail_terminal_status_error_check",
      sql`${table.errorCode} in ('detail_access_restricted', 'detail_location_conflict')`,
    ),
    check(
      "listing_detail_terminal_status_attempt_check",
      sql`${table.attemptCount} >= 1`,
    ),
  ],
);
export const listingVotes = sqliteTable(
  "listing_votes",
  {
    listingId: text("listing_id")
      .primaryKey()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    value: text("value", { enum: voteValues }).notNull(),
    createdAt: text("created_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_votes_value_idx").on(table.value),
    check(
      "listing_votes_value_check",
      sql`${table.value} in ('interested', 'not_interested')`,
    ),
  ],
);
export const listingLotFeedback = sqliteTable(
  "listing_lot_feedback",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    decision: text("decision", { enum: lotFeedbackDecisions }).notNull(),
    source: text("source").notNull().default("operator_dashboard"),
    createdAt: text("created_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_lot_feedback_history_idx").on(
      table.listingId,
      table.createdAt,
      table.id,
    ),
    check(
      "listing_lot_feedback_decision_check",
      sql`${table.decision} in ('lot', 'not_lot', 'automatic')`,
    ),
    check(
      "listing_lot_feedback_source_check",
      sql`${table.source} = 'operator_dashboard'`,
    ),
  ],
);
export const interestProfiles = sqliteTable("interest_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  currentVersion: integer("current_version").notNull().default(0),
  createdAt: text("created_at").notNull().default(nowUtc),
  updatedAt: text("updated_at").notNull().default(nowUtc),
});
export const profileVersions = sqliteTable(
  "profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => interestProfiles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    humanSummary: text("human_summary").notNull(),
    interestedConceptsJson: text("interested_concepts_json").notNull().default("[]"),
    notInterestedConceptsJson: text("not_interested_concepts_json")
      .notNull()
      .default("[]"),
    interestedSupportCount: integer("interested_support_count").notNull().default(0),
    notInterestedSupportCount: integer("not_interested_support_count")
      .notNull()
      .default(0),
    basedOnVotesThrough: text("based_on_votes_through"),
    createdAt: text("created_at").notNull().default(nowUtc),
  },
  (table) => [
    uniqueIndex("profile_versions_profile_version_uidx").on(
      table.profileId,
      table.version,
    ),
    check("profile_versions_version_check", sql`${table.version} > 0`),
    check(
      "profile_versions_support_counts_check",
      sql`${table.interestedSupportCount} >= 0 and ${table.notInterestedSupportCount} >= 0`,
    ),
  ],
);
export const profileVersionVotes = sqliteTable(
  "profile_version_votes",
  {
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => profileVersions.id, { onDelete: "cascade" }),
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    value: text("value", { enum: voteValues }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileVersionId, table.listingId] }),
    check(
      "profile_version_votes_value_check",
      sql`${table.value} in ('interested', 'not_interested')`,
    ),
  ],
);
export const profileSignalFeedback = sqliteTable(
  "profile_signal_feedback",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => interestProfiles.id, { onDelete: "cascade" }),
    concept: text("concept").notNull(),
    normalizedConcept: text("normalized_concept").notNull(),
    polarity: text("polarity", { enum: profileSignalPolarities }).notNull(),
    action: text("action", { enum: profileSignalActions }).notNull(),
    sourceProfileVersionId: text("source_profile_version_id")
      .notNull()
      .references(() => profileVersions.id),
    source: text("source").notNull().default("operator_dashboard"),
    createdAt: text("created_at").notNull().default(nowUtc),
  },
  (table) => [
    index("profile_signal_feedback_history_idx").on(
      table.profileId,
      table.polarity,
      table.normalizedConcept,
      table.createdAt,
      table.id,
    ),
    check(
      "profile_signal_feedback_concept_check",
      sql`length(${table.concept}) between 1 and 200`,
    ),
    check(
      "profile_signal_feedback_normalized_check",
      sql`length(${table.normalizedConcept}) between 1 and 200`,
    ),
    check(
      "profile_signal_feedback_polarity_check",
      sql`${table.polarity} in ('positive', 'negative')`,
    ),
    check(
      "profile_signal_feedback_action_check",
      sql`${table.action} in ('removed', 'restored')`,
    ),
    check(
      "profile_signal_feedback_source_check",
      sql`${table.source} = 'operator_dashboard'`,
    ),
  ],
);
export const profileVersionSignalFeedback = sqliteTable(
  "profile_version_signal_feedback",
  {
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => profileVersions.id, { onDelete: "cascade" }),
    feedbackId: text("feedback_id")
      .notNull()
      .references(() => profileSignalFeedback.id),
  },
  (table) => [
    primaryKey({ columns: [table.profileVersionId, table.feedbackId] }),
    index("profile_version_signal_feedback_feedback_idx").on(table.feedbackId),
  ],
);
export const aiArtifacts = sqliteTable(
  "ai_artifacts",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: aiSubjectTypes }).notNull(),
    subjectId: text("subject_id").notNull(),
    task: text("task", { enum: aiTaskTypes }).notNull(),
    providerName: text("provider_name").notNull(),
    modelName: text("model_name").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    outputText: text("output_text"),
    outputJson: text("output_json"),
    outputHash: text("output_hash"),
    generatedAt: text("generated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("ai_artifacts_provenance_idx").on(
      table.subjectType,
      table.subjectId,
      table.task,
      table.providerName,
      table.modelName,
      table.promptVersion,
      table.inputHash,
    ),
    index("ai_artifacts_subject_idx").on(table.subjectType, table.subjectId),
    check(
      "ai_artifacts_subject_type_check",
      sql`${table.subjectType} in ('listing', 'profile_version')`,
    ),
    check(
      "ai_artifacts_task_check",
      sql`${table.task} in ('listing_extraction', 'listing_summary', 'semantic_document', 'recommendation_explanation', 'profile_summary')`,
    ),
    check(
      "ai_artifacts_output_check",
      sql`${table.outputText} is not null or ${table.outputJson} is not null`,
    ),
  ],
);
export const embeddings = sqliteTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: aiSubjectTypes }).notNull(),
    subjectId: text("subject_id").notNull(),
    kind: text("kind", { enum: embeddingKinds }).notNull(),
    providerName: text("provider_name").notNull(),
    modelName: text("model_name").notNull(),
    inputHash: text("input_hash").notNull(),
    dimensions: integer("dimensions").notNull(),
    vectorJson: text("vector_json").notNull(),
    generatedAt: text("generated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("embeddings_provenance_idx").on(
      table.subjectType,
      table.subjectId,
      table.kind,
      table.providerName,
      table.modelName,
      table.inputHash,
    ),
    index("embeddings_subject_idx").on(table.subjectType, table.subjectId),
    check("embeddings_dimensions_check", sql`${table.dimensions} > 0`),
    check(
      "embeddings_subject_type_check",
      sql`${table.subjectType} in ('listing', 'profile_version')`,
    ),
    check(
      "embeddings_kind_check",
      sql`${table.kind} in ('listing_semantic_document', 'profile_positive_centroid', 'profile_negative_centroid')`,
    ),
  ],
);
export const listingScores = sqliteTable(
  "listing_scores",
  {
    listingId: text("listing_id")
      .notNull()
      .references(() => listingStubs.id, { onDelete: "cascade" }),
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => profileVersions.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    positiveSimilarity: real("positive_similarity"),
    negativeSimilarity: real("negative_similarity"),
    explorationWeight: real("exploration_weight").notNull().default(0),
    explanationArtifactId: text("explanation_artifact_id").references(
      () => aiArtifacts.id,
    ),
    scoredAt: text("scored_at").notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.listingId, table.profileVersionId] }),
    index("listing_scores_score_idx").on(table.score),
    check(
      "listing_scores_exploration_weight_check",
      sql`${table.explorationWeight} between 0 and 1`,
    ),
  ],
);
export const preferenceModelActivationEvents = sqliteTable(
  "preference_model_activation_events",
  {
    eventIdentity: text("event_identity").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    sequence: integer("sequence").notNull().unique(),
    eventType: text("event_type", {
      enum: preferenceModelActivationEventTypes,
    }).notNull(),
    eventAuthority: text("event_authority", {
      enum: preferenceModelActivationAuthorities,
    }).notNull(),
    reasonCode: text("reason_code", {
      enum: preferenceModelActivationReasonCodes,
    }).notNull(),
    previousEventIdentity: text("previous_event_identity"),
    recordedAt: text("recorded_at").notNull(),
    protocolIdentity: text("protocol_identity").notNull(),
    implementationIdentity: text("implementation_identity").notNull(),
    workRootIdentity: text("work_root_identity").notNull(),
    snapshotEvidenceIdentity: text("snapshot_evidence_identity").notNull(),
    manifestIdentity: text("manifest_identity").notNull(),
    candidateGuardIdentity: text("candidate_guard_identity").notNull(),
    testResultGuardIdentity: text("test_result_guard_identity").notNull(),
    evaluationResultIdentity: text("evaluation_result_identity").notNull(),
    terminalOrchestrationReceiptIdentity: text(
      "terminal_orchestration_receipt_identity",
    ).notNull(),
    retrospectiveShadowResultIdentity: text(
      "retrospective_shadow_result_identity",
    ).notNull(),
    currentShadowReceiptIdentity: text("current_shadow_receipt_identity").notNull(),
    disabledExerciseShadowReceiptIdentity: text(
      "disabled_exercise_shadow_receipt_identity",
    ).notNull(),
    currentCohortSnapshotIdentity: text("current_cohort_snapshot_identity").notNull(),
    selectedFamily: text("selected_family").notNull(),
    selectedConfigurationId: text("selected_configuration_id").notNull(),
    candidateArtifactRelativePath: text("candidate_artifact_relative_path").notNull(),
    candidateArtifactHash: text("candidate_artifact_hash").notNull(),
    canonicalFittedStateHash: text("canonical_fitted_state_hash").notNull(),
    runtimeIdentity: text("runtime_identity").notNull(),
    deterministicProfileVersionId: text("deterministic_profile_version_id")
      .notNull()
      .references(() => profileVersions.id),
    profilePriorHash: text("profile_prior_hash").notNull(),
    acceptedBaselineProfileIdentity: text(
      "accepted_baseline_profile_identity",
    ).notNull(),
    profileFeedbackSnapshotIdentity: text(
      "profile_feedback_snapshot_identity",
    ).notNull(),
    decisionEvidenceHash: text("decision_evidence_hash").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.previousEventIdentity],
      foreignColumns: [table.eventIdentity],
      name: "preference_model_activation_previous_fk",
    }),
    check(
      "preference_model_activation_schema_check",
      sql`${table.schemaVersion} = 'm21-preference-model-activation-event-v1'`,
    ),
    check(
      "preference_model_activation_event_type_check",
      sql`${table.eventType} in ('promote', 'disable')`,
    ),
    check(
      "preference_model_activation_authority_reason_check",
      sql`(${table.eventType} = 'promote' and ${table.eventAuthority} = 'operator' and ${table.reasonCode} = 'operator_promote') or (${table.eventType} = 'disable' and ${table.eventAuthority} = 'operator' and ${table.reasonCode} = 'operator_disable') or (${table.eventType} = 'disable' and ${table.eventAuthority} = 'automatic_fail_closed' and ${table.reasonCode} in ('artifact_or_implementation_drift', 'profile_or_input_drift', 'provider_or_resource_failure', 'incomplete_scoring_run'))`,
    ),
    check(
      "preference_model_activation_artifact_path_check",
      sql`${table.candidateArtifactRelativePath} = 'artifacts/preference-candidate-v1.joblib'`,
    ),
  ],
);
export const learnedListingScores = sqliteTable(
  "learned_listing_scores",
  {
    rowIdentity: text("row_identity").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    activationEventIdentity: text("activation_event_identity")
      .notNull()
      .references(() => preferenceModelActivationEvents.eventIdentity),
    protocolIdentity: text("protocol_identity").notNull(),
    implementationIdentity: text("implementation_identity").notNull(),
    candidateArtifactHash: text("candidate_artifact_hash").notNull(),
    evaluationResultIdentity: text("evaluation_result_identity").notNull(),
    selectedFamily: text("selected_family").notNull(),
    selectedConfigurationId: text("selected_configuration_id").notNull(),
    listingId: text("listing_id").notNull().references(() => listingStubs.id),
    deterministicProfileVersionId: text("deterministic_profile_version_id")
      .notNull()
      .references(() => profileVersions.id),
    profilePriorHash: text("profile_prior_hash").notNull(),
    acceptedBaselineProfileIdentity: text(
      "accepted_baseline_profile_identity",
    ).notNull(),
    profileFeedbackSnapshotIdentity: text(
      "profile_feedback_snapshot_identity",
    ).notNull(),
    cleanDescriptionHash: text("clean_description_hash").notNull(),
    extractionArtifactId: text("extraction_artifact_id")
      .notNull()
      .references(() => aiArtifacts.id),
    extractionOutputHash: text("extraction_output_hash").notNull(),
    semanticArtifactId: text("semantic_artifact_id")
      .notNull()
      .references(() => aiArtifacts.id),
    semanticOutputHash: text("semantic_output_hash").notNull(),
    embeddingId: text("embedding_id").notNull().references(() => embeddings.id),
    embeddingInputHash: text("embedding_input_hash").notNull(),
    embeddingVectorHash: text("embedding_vector_hash").notNull(),
    scoringInputHash: text("scoring_input_hash").notNull(),
    baselineProbability: real("baseline_probability").notNull(),
    candidateProbability: real("candidate_probability").notNull(),
    score: real("score").notNull(),
    explanation: text("explanation").notNull(),
    explanationHash: text("explanation_hash").notNull(),
    scoredAt: text("scored_at").notNull(),
  },
  (table) => [
    index("learned_listing_scores_active_listing_idx").on(
      table.activationEventIdentity,
      table.listingId,
      table.scoredAt,
      table.rowIdentity,
    ),
    check(
      "learned_listing_scores_schema_check",
      sql`${table.schemaVersion} = 'm21-learned-listing-score-v1'`,
    ),
    check(
      "learned_listing_scores_probability_check",
      sql`${table.baselineProbability} between 0 and 1 and ${table.candidateProbability} between 0 and 1 and ${table.score} between 0 and 100`,
    ),
  ],
);
export const pipelineGenerationState = sqliteTable(
  "pipeline_generation_state",
  {
    domain: text("domain").notNull(),
    scopeType: text("scope_type", { enum: pipelineScopeTypes }).notNull(),
    scopeId: text("scope_id").notNull(),
    generation: integer("generation").notNull().default(1),
    fingerprint: text("fingerprint").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.domain, table.scopeType, table.scopeId] }),
    index("pipeline_generation_scope_idx").on(
      table.scopeType,
      table.scopeId,
      table.domain,
    ),
    check("pipeline_generation_scope_type_check", sql`${table.scopeType} in ('listing', 'source', 'group', 'global')`),
    check("pipeline_generation_value_check", sql`${table.generation} >= 1`),
  ],
);
export const listingOperationalOwnership = sqliteTable(
  "listing_operational_ownership",
  {
    listingId: text("listing_id").primaryKey().references(() => listingStubs.id, {
      onDelete: "cascade",
    }),
    sourceId: text("source_id").notNull().references(() => auctionSources.id),
    actionableOwnerListingId: text("actionable_owner_listing_id")
      .references(() => listingStubs.id),
    actionableOwnerSourceId: text("actionable_owner_source_id")
      .references(() => auctionSources.id),
    ownerState: text("owner_state", { enum: operationalOwnerStates }).notNull(),
    ownerBasis: text("owner_basis").notNull(),
    ownerProofHash: text("owner_proof_hash"),
    sharedGroupIdentity: text("shared_group_identity"),
    upstreamTupleIdentity: text("upstream_tuple_identity"),
    counterpartState: text("counterpart_state", {
      enum: operationalCounterpartStates,
    }).notNull(),
    counterpartOwnerListingId: text("counterpart_owner_listing_id")
      .references(() => listingStubs.id),
    counterpartOwnerSourceId: text("counterpart_owner_source_id")
      .references(() => auctionSources.id),
    counterpartAbsenceProofHash: text("counterpart_absence_proof_hash"),
    ownershipInputHash: text("ownership_input_hash").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    updateGeneration: integer("update_generation").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_operational_owner_idx").on(
      table.actionableOwnerListingId,
      table.listingId,
    ),
    index("listing_operational_source_idx").on(table.sourceId, table.listingId),
    index("listing_operational_group_idx").on(
      table.sharedGroupIdentity,
      table.listingId,
    ),
    index("listing_operational_tuple_idx").on(
      table.upstreamTupleIdentity,
      table.listingId,
    ),
    check("listing_operational_owner_state_check", sql`${table.ownerState} in ('native_primary', 'publisher_primary', 'shared_alias', 'upstream_representative', 'unresolved', 'other')`),
    check("listing_operational_counterpart_state_check", sql`${table.counterpartState} in ('present', 'absent_with_complete_proof', 'unknown')`),
    check("listing_operational_generation_check", sql`${table.updateGeneration} >= 1`),
  ],
);
export const listingCurrentPipelineState = sqliteTable(
  "listing_current_pipeline_state",
  {
    listingId: text("listing_id").primaryKey().references(() => listingStubs.id, {
      onDelete: "cascade",
    }),
    sourceId: text("source_id").notNull().references(() => auctionSources.id),
    sourceCurrent: integer("source_current", { mode: "boolean" }).notNull().default(false),
    activeInventoryRunId: text("active_inventory_run_id")
      .references(() => discoveryRuns.id),
    sourcePublicationGeneration: integer("source_publication_generation"),
    sourceCoverageMode: text("source_coverage_mode", { enum: sourceCoverageModes }),
    reviewCandidate: integer("review_candidate", { mode: "boolean" }).notNull().default(false),
    categoryScope: text("category_scope"),
    ownershipInputHash: text("ownership_input_hash"),
    acceptedDetailIdentity: text("accepted_detail_identity"),
    acceptedDetailHash: text("accepted_detail_hash"),
    effectiveLocationInputHash: text("effective_location_input_hash"),
    routeCacheIdentity: text("route_cache_identity"),
    routeAssignmentIdentity: text("route_assignment_identity"),
    routeInputHash: text("route_input_hash"),
    routeTerminalIdentity: text("route_terminal_identity"),
    factualSupplementState: text("factual_supplement_state").notNull().default("unknown"),
    factualSupplementInputHash: text("factual_supplement_input_hash"),
    sourceImageIdentityHash: text("source_image_identity_hash"),
    localPrimaryState: text("local_primary_state").notNull().default("unknown"),
    imageInputHash: text("image_input_hash"),
    enrichmentHeadIdentity: text("enrichment_head_identity"),
    enrichmentInputHash: text("enrichment_input_hash"),
    scoreHeadIdentity: text("score_head_identity"),
    scoreSnapshotIdentity: text("score_snapshot_identity"),
    scoreInputHash: text("score_input_hash"),
    sourceReleaseInputHash: text("source_release_input_hash"),
    projectionWorkInputHash: text("projection_work_input_hash"),
    detailWorkInputHash: text("detail_work_input_hash"),
    actionDeadlineWorkInputHash: text("action_deadline_work_input_hash"),
    ownerWorkInputHash: text("owner_work_input_hash"),
    factualWorkInputHash: text("factual_work_input_hash"),
    imageWorkInputHash: text("image_work_input_hash"),
    proximityWorkInputHash: text("proximity_work_input_hash"),
    enrichmentTextWorkInputHash: text("enrichment_text_work_input_hash"),
    enrichmentEmbeddingWorkInputHash: text("enrichment_embedding_work_input_hash"),
    preferenceScoreWorkInputHash: text("preference_score_work_input_hash"),
    sourceReleaseWorkInputHash: text("source_release_work_input_hash"),
    relevantGenerationVectorHash: text("relevant_generation_vector_hash").notNull(),
    projectionDerivationVersion: text("projection_derivation_version").notNull(),
    updateGeneration: integer("update_generation").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_current_source_idx").on(
      table.sourceId,
      table.sourceCurrent,
      table.reviewCandidate,
      table.listingId,
    ),
    index("listing_current_source_fanout_idx").on(
      table.sourceId,
      table.listingId,
    ),
    index("listing_current_proximity_idx").on(
      table.sourceCurrent,
      table.proximityWorkInputHash,
      table.listingId,
    ),
    index("listing_current_release_idx").on(
      table.sourceId,
      table.sourceReleaseInputHash,
      table.listingId,
    ),
    check("listing_current_boolean_check", sql`${table.sourceCurrent} in (0, 1) and ${table.reviewCandidate} in (0, 1)`),
    check("listing_current_generation_check", sql`${table.updateGeneration} >= 1 and (${table.sourcePublicationGeneration} is null or ${table.sourcePublicationGeneration} >= 1)`),
  ],
);
export const pipelineWorkItems = sqliteTable(
  "pipeline_work_items",
  {
    stage: text("stage", { enum: pipelineWorkStages }).notNull(),
    subjectType: text("subject_type", { enum: pipelineScopeTypes }).notNull(),
    subjectId: text("subject_id").notNull(),
    listingId: text("listing_id").references(() => listingStubs.id, {
      onDelete: "cascade",
    }),
    sourceId: text("source_id").references(() => auctionSources.id),
    subjectPayloadJson: text("subject_payload_json"),
    laneKey: text("lane_key").notNull(),
    inputHash: text("input_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    reasonCode: text("reason_code").notNull(),
    availableAt: text("available_at").notNull().default(nowUtc),
    inputAttemptCount: integer("input_attempt_count").notNull().default(0),
    lifetimeAttemptCount: integer("lifetime_attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    claimedInputHash: text("claimed_input_hash"),
    claimedRevision: integer("claimed_revision"),
    progressCursor: text("progress_cursor"),
    progressGeneration: integer("progress_generation"),
    progressRows: integer("progress_rows").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorFingerprint: text("last_error_fingerprint"),
    createdAt: text("created_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
    lastClaimedAt: text("last_claimed_at"),
    lastCompletedAt: text("last_completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.stage, table.subjectType, table.subjectId] }),
    index("pipeline_work_ready_idx").on(
      table.stage,
      table.availableAt,
      table.priority,
      table.updatedAt,
      table.subjectId,
    ),
    index("pipeline_work_lane_ready_idx").on(
      table.stage,
      table.laneKey,
      table.availableAt,
      table.priority,
      table.subjectId,
    ),
    index("pipeline_work_lease_expiry_idx").on(table.leaseExpiresAt, table.stage),
    index("pipeline_work_source_idx").on(table.sourceId, table.stage, table.subjectId),
    index("pipeline_work_listing_idx").on(table.listingId, table.stage),
    check("pipeline_work_stage_check", sql`${table.stage} in ('projection_listing_refresh', 'projection_source_refresh', 'projection_group_refresh', 'projection_global_refresh', 'detail', 'action_deadline', 'owner_refresh', 'factual_supplement', 'image_evidence', 'primary_image', 'proximity', 'enrichment_text', 'enrichment_embedding', 'preference_v2_score', 'source_release', 'source_acquisition_readiness')`),
    check("pipeline_work_subject_type_check", sql`${table.subjectType} in ('listing', 'source', 'group', 'global')`),
    check("pipeline_work_revision_check", sql`${table.revision} >= 1 and ${table.inputAttemptCount} >= 0 and ${table.lifetimeAttemptCount} >= ${table.inputAttemptCount} and ${table.progressRows} >= 0`),
  ],
);
export const pipelineRebuildState = sqliteTable(
  "pipeline_rebuild_state",
  {
    rebuildId: text("rebuild_id").primaryKey(),
    domain: text("domain").notNull(),
    scopeType: text("scope_type", { enum: pipelineScopeTypes }).notNull(),
    scopeId: text("scope_id").notNull(),
    state: text("state", {
      enum: ["pending", "running", "completed", "superseded", "failed"] as const,
    }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    targetGenerationVectorJson: text("target_generation_vector_json").notNull(),
    targetGenerationVectorHash: text("target_generation_vector_hash").notNull(),
    endingGenerationVectorJson: text("ending_generation_vector_json"),
    endingGenerationVectorHash: text("ending_generation_vector_hash"),
    cursorListingId: text("cursor_listing_id"),
    rowsProcessed: integer("rows_processed").notNull().default(0),
    batchesProcessed: integer("batches_processed").notNull().default(0),
    copiedDatabaseIdentity: text("copied_database_identity"),
    errorCode: text("error_code"),
    errorFingerprint: text("error_fingerprint"),
    startedAt: text("started_at").notNull().default(nowUtc),
    updatedAt: text("updated_at").notNull().default(nowUtc),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("pipeline_rebuild_active_idx").on(
      table.domain,
      table.scopeType,
      table.scopeId,
      table.state,
      table.updatedAt,
    ),
    check("pipeline_rebuild_count_check", sql`${table.schemaVersion} >= 39 and ${table.rowsProcessed} >= 0 and ${table.batchesProcessed} >= 0`),
  ],
);
export const pipelineAuditReceipts = sqliteTable(
  "pipeline_audit_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    receiptKind: text("receipt_kind", {
      enum: ["rebuild", "full_audit", "shadow_pass", "readiness", "mismatch"] as const,
    }).notNull(),
    featureName: text("feature_name").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    beforeGenerationVectorHash: text("before_generation_vector_hash").notNull(),
    afterGenerationVectorHash: text("after_generation_vector_hash").notNull(),
    canonicalCount: integer("canonical_count").notNull(),
    canonicalOrderedHash: text("canonical_ordered_hash").notNull(),
    projectionCount: integer("projection_count").notNull(),
    projectionOrderedHash: text("projection_ordered_hash").notNull(),
    queueCount: integer("queue_count").notNull(),
    queueOrderedHash: text("queue_ordered_hash").notNull(),
    mismatchCount: integer("mismatch_count").notNull(),
    differingIdsHash: text("differing_ids_hash"),
    copiedDatabaseIdentity: text("copied_database_identity"),
    shadowPassCount: integer("shadow_pass_count").notNull().default(0),
    readinessGranted: integer("readiness_granted", { mode: "boolean" }).notNull().default(false),
    priorReceiptId: text("prior_receipt_id"),
    completedAt: text("completed_at").notNull(),
  },
  (table) => [
    index("pipeline_audit_feature_idx").on(
      table.featureName,
      table.readinessGranted,
      table.completedAt,
      table.receiptId,
    ),
    check("pipeline_audit_count_check", sql`${table.schemaVersion} >= 39 and ${table.canonicalCount} >= 0 and ${table.projectionCount} >= 0 and ${table.queueCount} >= 0 and ${table.mismatchCount} >= 0 and ${table.shadowPassCount} >= 0 and ${table.readinessGranted} in (0, 1)`),
  ],
);
export const pipelineExecutionEvidence = sqliteTable(
  "pipeline_execution_evidence",
  {
    executionReceiptId: text("execution_receipt_id").primaryKey(),
    evidenceKind: text("evidence_kind", {
      enum: [
        "unified_source_scheduler",
        "preparation_scheduler",
      ] as const,
    }).notNull(),
    evidenceSchemaVersion: text("evidence_schema_version").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    evidenceIdentityHash: text("evidence_identity_hash").notNull(),
    executionIdentityHash: text("execution_identity_hash").notNull().unique(),
    invocationIdentityHash: text("invocation_identity_hash").notNull(),
    inputGenerationVectorHash: text("input_generation_vector_hash").notNull(),
    inputBoundaryHash: text("input_boundary_hash").notNull(),
    outputBoundaryHash: text("output_boundary_hash").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    completedAt: text("completed_at").notNull(),
  },
  (table) => [
    index("pipeline_execution_evidence_latest_idx").on(
      table.evidenceKind,
      table.completedAt,
      table.executionReceiptId,
    ),
    index("pipeline_execution_evidence_derivation_idx").on(
      table.evidenceKind,
      table.derivationVersion,
      table.inputGenerationVectorHash,
      table.completedAt,
    ),
    check("pipeline_execution_evidence_kind_check", sql`${table.evidenceKind} in ('unified_source_scheduler', 'preparation_scheduler')`),
    check("pipeline_execution_evidence_schema_check", sql`${table.evidenceSchemaVersion} = 'auction-discovery-runtime-execution-evidence-v2'`),
    check("pipeline_execution_evidence_json_check", sql`json_valid(${table.evidenceJson}) and json_type(${table.evidenceJson}) = 'object' and length(cast(${table.evidenceJson} as blob)) between 2 and 65536`),
  ],
);
export const pipelineComponentExecutionLinks = sqliteTable(
  "pipeline_component_execution_links",
  {
    linkIdentity: text("link_identity").primaryKey(),
    componentName: text("component_name", {
      enum: [
        "preparationScheduler",
        "unifiedSourceScheduler",
      ] as const,
    }).notNull(),
    shadowReceiptId: text("shadow_receipt_id").notNull()
      .references(() => pipelineAuditReceipts.receiptId),
    executionReceiptId: text("execution_receipt_id").notNull()
      .references(() => pipelineExecutionEvidence.executionReceiptId),
    derivationVersion: text("derivation_version").notNull(),
    generationVectorHash: text("generation_vector_hash").notNull(),
    linkedAt: text("linked_at").notNull(),
  },
  (table) => [
    uniqueIndex("pipeline_component_execution_shadow_unique_idx").on(
      table.componentName,
      table.shadowReceiptId,
    ),
    uniqueIndex("pipeline_component_execution_receipt_unique_idx").on(
      table.componentName,
      table.executionReceiptId,
    ),
    index("pipeline_component_execution_shadow_idx").on(
      table.shadowReceiptId,
      table.componentName,
      table.executionReceiptId,
    ),
    index("pipeline_component_execution_receipt_idx").on(
      table.executionReceiptId,
      table.componentName,
      table.shadowReceiptId,
    ),
    check("pipeline_component_execution_component_check", sql`${table.componentName} in ('preparationScheduler', 'unifiedSourceScheduler')`),
  ],
);
export const listingEnrichmentHeads = sqliteTable(
  "listing_enrichment_heads",
  {
    listingId: text("listing_id").primaryKey().references(() => listingStubs.id, { onDelete: "cascade" }),
    provenanceTargetIdentity: text("provenance_target_identity").notNull(),
    enrichmentInputHash: text("enrichment_input_hash").notNull(),
    state: text("state", { enum: ["pending_text", "text_ready", "pending_embedding", "complete", "terminal"] as const }).notNull(),
    extractionArtifactId: text("extraction_artifact_id").references(() => aiArtifacts.id),
    extractionOutputHash: text("extraction_output_hash"),
    semanticArtifactId: text("semantic_artifact_id").references(() => aiArtifacts.id),
    semanticOutputHash: text("semantic_output_hash"),
    embeddingId: text("embedding_id").references(() => embeddings.id),
    embeddingInputHash: text("embedding_input_hash"),
    embeddingVectorHash: text("embedding_vector_hash"),
    headIdentity: text("head_identity").notNull(),
    generation: integer("generation").notNull().default(1),
    derivationVersion: text("derivation_version").notNull(),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_enrichment_state_idx").on(table.state, table.updatedAt, table.listingId),
    index("listing_enrichment_input_idx").on(table.enrichmentInputHash, table.listingId),
    check("listing_enrichment_head_state_check", sql`${table.state} in ('pending_text', 'text_ready', 'pending_embedding', 'complete', 'terminal')`),
    check("listing_enrichment_generation_check", sql`${table.generation} >= 1`),
  ],
);
export const preferenceShadowScoresV2 = sqliteTable(
  "preference_shadow_scores_v2",
  {
    shadowScoreId: text("shadow_score_id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    listingId: text("listing_id").notNull().references(() => listingStubs.id),
    physicalAssetClusterId: text("physical_asset_cluster_id").notNull(),
    auctionEventBlockId: text("auction_event_block_id").notNull(),
    semanticFamilyId: text("semantic_family_id").notNull(),
    baselineScore: real("baseline_score").notNull(),
    intrinsicScore: real("intrinsic_score").notNull(),
    observedPreferenceScore: real("observed_preference_score").notNull(),
    actionabilityScore: real("actionability_score").notNull(),
    investigationScore: real("investigation_score").notNull(),
    finalScore: real("final_score").notNull(),
    modelVersion: text("model_version").notNull(),
    featureVersion: text("feature_version").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    scoredAt: text("scored_at").notNull(),
    uncertainty: real("uncertainty").notNull(),
    explanationText: text("explanation_text").notNull(),
    explanationJson: text("explanation_json").notNull(),
    fallbackModelVersion: text("fallback_model_version").notNull(),
    fallbackScore: real("fallback_score").notNull(),
    fallbackExplanation: text("fallback_explanation").notNull(),
    promotionState: text("promotion_state", {
      enum: ["shadow_only_pending_prospective"] as const,
    }).notNull(),
    createdAt: text("created_at").notNull().default(nowUtc),
  },
  (table) => [
    uniqueIndex("preference_shadow_score_listing_identity_idx").on(
      table.shadowScoreId,
      table.listingId,
    ),
    uniqueIndex("preference_shadow_scores_v2_listing_contract_idx").on(
      table.listingId,
      table.modelVersion,
      table.featureVersion,
      table.snapshotId,
    ),
    check("preference_shadow_scores_v2_schema_check", sql`${table.schemaVersion} = 'preference-shadow-score-v2'`),
    check("preference_shadow_scores_v2_score_check", sql`${table.baselineScore} between 0 and 1 and ${table.intrinsicScore} between 0 and 1 and ${table.observedPreferenceScore} between 0 and 1 and ${table.actionabilityScore} between 0 and 1 and ${table.investigationScore} between 0 and 1 and ${table.finalScore} between 0 and 1 and ${table.uncertainty} between 0 and 1 and ${table.fallbackScore} between 0 and 1`),
  ],
);
export const listingPreferenceScoreHeads = sqliteTable(
  "listing_preference_score_heads",
  {
    listingId: text("listing_id").primaryKey().references(() => listingStubs.id, { onDelete: "cascade" }),
    scoreKind: text("score_kind", { enum: ["deterministic", "learned"] as const }).notNull(),
    deterministicProfileVersionId: text("deterministic_profile_version_id").references(() => profileVersions.id),
    activationEventIdentity: text("activation_event_identity").references(() => preferenceModelActivationEvents.eventIdentity),
    learnedScoreRowIdentity: text("learned_score_row_identity").references(() => learnedListingScores.rowIdentity),
    snapshotIdentity: text("snapshot_identity").notNull(),
    scoringInputHash: text("scoring_input_hash").notNull(),
    scoreHeadIdentity: text("score_head_identity").notNull(),
    score: real("score").notNull(),
    generation: integer("generation").notNull().default(1),
    derivationVersion: text("derivation_version").notNull(),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_score_head_snapshot_idx").on(table.snapshotIdentity, table.scoringInputHash, table.listingId),
    check("listing_score_head_kind_check", sql`${table.scoreKind} in ('deterministic', 'learned')`),
    check("listing_score_head_value_check", sql`${table.score} between 0 and 100 and ${table.generation} >= 1`),
  ],
);
export const preferenceV2ActiveScoreHeads = sqliteTable(
  "preference_v2_active_score_heads",
  {
    listingId: text("listing_id").primaryKey().references(() => listingStubs.id, { onDelete: "cascade" }),
    shadowScoreId: text("shadow_score_id").notNull().unique(),
    modelVersion: text("model_version").notNull(),
    featureVersion: text("feature_version").notNull(),
    runtimeIdentity: text("runtime_identity").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    scoringInputHash: text("scoring_input_hash").notNull(),
    baselineScore: real("baseline_score").notNull(),
    intrinsicScore: real("intrinsic_score").notNull(),
    observedPreferenceScore: real("observed_preference_score").notNull(),
    actionabilityScore: real("actionability_score").notNull(),
    investigationScore: real("investigation_score").notNull(),
    finalScore: real("final_score").notNull(),
    uncertainty: real("uncertainty").notNull(),
    generationVectorHash: text("generation_vector_hash").notNull(),
    databaseBoundary: text("database_boundary").notNull(),
    dataVersion: integer("data_version").notNull(),
    headIdentity: text("head_identity").notNull(),
    generation: integer("generation").notNull().default(1),
    derivationVersion: text("derivation_version").notNull(),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    foreignKey({
      columns: [table.shadowScoreId, table.listingId],
      foreignColumns: [preferenceShadowScoresV2.shadowScoreId, preferenceShadowScoresV2.listingId],
      name: "preference_v2_active_head_shadow_listing_fk",
    }),
    index("preference_v2_active_head_contract_idx").on(
      table.modelVersion,
      table.featureVersion,
      table.runtimeIdentity,
      table.listingId,
    ),
    index("preference_v2_active_head_snapshot_idx").on(
      table.snapshotId,
      table.snapshotHash,
      table.scoringInputHash,
      table.listingId,
    ),
    check("preference_v2_active_head_score_check", sql`${table.baselineScore} between 0 and 1 and ${table.intrinsicScore} between 0 and 1 and ${table.observedPreferenceScore} between 0 and 1 and ${table.actionabilityScore} between 0 and 1 and ${table.investigationScore} between 0 and 1 and ${table.finalScore} between 0 and 1 and ${table.uncertainty} between 0 and 1`),
    check("preference_v2_active_head_boundary_check", sql`${table.dataVersion} >= 0 and ${table.generation} >= 1`),
  ],
);
export const preferenceV2ScoreCoverageReceipts = sqliteTable(
  "preference_v2_score_coverage_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    schemaIdentity: text("schema_identity").notNull(),
    activationEventIdentity: text("activation_event_identity").references(() => preferenceModelActivationEvents.eventIdentity),
    modelArtifactIdentity: text("model_artifact_identity").notNull(),
    modelConfigurationIdentity: text("model_configuration_identity").notNull(),
    modelVersion: text("model_version").notNull(),
    featureVersion: text("feature_version").notNull(),
    implementationIdentity: text("implementation_identity").notNull(),
    runtimeIdentity: text("runtime_identity").notNull(),
    requiredRuntimeIdentitiesJson: text("required_runtime_identities_json").notNull(),
    profileVersionId: text("profile_version_id").notNull().references(() => profileVersions.id),
    profilePriorHash: text("profile_prior_hash").notNull(),
    activeOriginCacheKey: text("active_origin_cache_key").notNull(),
    routeProviderName: text("route_provider_name").notNull(),
    routeEstimatorVersion: text("route_estimator_version").notNull(),
    routeNormalizationVersion: text("route_normalization_version").notNull(),
    routeDatasetIdentity: text("route_dataset_identity").notNull(),
    ownershipGeneration: integer("ownership_generation").notNull(),
    sourceCurrentVectorHash: text("source_current_vector_hash").notNull(),
    detailLocationGeneration: integer("detail_location_generation").notNull(),
    enrichmentTargetIdentity: text("enrichment_target_identity").notNull(),
    enrichmentHeadGeneration: integer("enrichment_head_generation").notNull(),
    physicalAssetGeneration: integer("physical_asset_generation").notNull(),
    auctionEventGeneration: integer("auction_event_generation").notNull(),
    semanticFamilyGeneration: integer("semantic_family_generation").notNull(),
    voteGeneration: integer("vote_generation").notNull(),
    cohortGeneration: integer("cohort_generation").notNull(),
    activeHistoryGeneration: integer("active_history_generation").notNull(),
    presentationPolicyGeneration: integer("presentation_policy_generation").notNull(),
    generationVectorJson: text("generation_vector_json").notNull(),
    generationVectorHash: text("generation_vector_hash").notNull(),
    eligibleListingCount: integer("eligible_listing_count").notNull(),
    eligibleListingIdsHash: text("eligible_listing_ids_hash").notNull(),
    scoreCoverageCount: integer("score_coverage_count").notNull(),
    scoreCoverageHash: text("score_coverage_hash").notNull(),
    scoreHeadCount: integer("score_head_count").notNull(),
    scoreHeadHash: text("score_head_hash").notNull(),
    scoreQueueGeneration: integer("score_queue_generation").notNull(),
    scoreQueueHash: text("score_queue_hash").notNull(),
    scoreQueueEmpty: integer("score_queue_empty", { mode: "boolean" }).notNull(),
    databaseBoundaryBefore: text("database_boundary_before").notNull(),
    databaseBoundaryAfter: text("database_boundary_after").notNull(),
    dataVersionBefore: integer("data_version_before"),
    dataVersionAfter: integer("data_version_after"),
    priorReceiptId: text("prior_receipt_id"),
    completedAt: text("completed_at").notNull(),
    derivationVersion: text("derivation_version").notNull(),
  },
  (table) => [
    index("preference_v2_coverage_completed_idx").on(table.completedAt, table.receiptId),
    check("preference_v2_coverage_runtime_json_check", sql`json_valid(${table.requiredRuntimeIdentitiesJson}) and json_type(${table.requiredRuntimeIdentitiesJson}) = 'object'`),
    check("preference_v2_coverage_generation_json_check", sql`json_valid(${table.generationVectorJson}) and json_type(${table.generationVectorJson}) in ('object', 'array')`),
    check("preference_v2_coverage_boundary_check", sql`${table.databaseBoundaryBefore} = ${table.databaseBoundaryAfter}`),
  ],
);
export const preferenceV2ScoreCoverageHead = sqliteTable(
  "preference_v2_score_coverage_head",
  {
    singleton: integer("singleton").primaryKey().default(1),
    receiptId: text("receipt_id").notNull().references(() => preferenceV2ScoreCoverageReceipts.receiptId),
    generationVectorHash: text("generation_vector_hash").notNull(),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    check("preference_v2_coverage_head_singleton_check", sql`${table.singleton} = 1`),
  ],
);
export const sourceReviewReleaseProofs = sqliteTable(
  "source_review_release_proofs",
  {
    proofId: text("proof_id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => auctionSources.id),
    coverageMode: text("coverage_mode", { enum: sourceCoverageModes }).notNull(),
    generationVectorHash: text("generation_vector_hash").notNull(),
    releaseInputHash: text("release_input_hash").notNull(),
    releaseGeneration: integer("release_generation").notNull(),
    acceptedCount: integer("accepted_count").notNull(),
    preparedCount: integer("prepared_count").notNull(),
    incompleteCount: integer("incomplete_count").notNull(),
    releasedCount: integer("released_count").notNull(),
    outcome: text("outcome", { enum: ["released", "withheld", "invalidated"] as const }).notNull(),
    invalidationReasonCode: text("invalidation_reason_code"),
    priorProofId: text("prior_proof_id"),
    completedAt: text("completed_at").notNull(),
    derivationVersion: text("derivation_version").notNull(),
  },
  (table) => [
    index("source_release_proofs_source_idx").on(table.sourceId, table.releaseGeneration, table.completedAt),
    check("source_release_proof_coverage_check", sql`${table.coverageMode} in ('complete_current', 'discovery_frontier')`),
    check("source_release_proof_outcome_check", sql`${table.outcome} in ('released', 'withheld', 'invalidated')`),
  ],
);
export const sourceReviewReleaseState = sqliteTable(
  "source_review_release_state",
  {
    sourceId: text("source_id").primaryKey().references(() => auctionSources.id),
    coverageMode: text("coverage_mode", { enum: sourceCoverageModes }).notNull(),
    generationVectorHash: text("generation_vector_hash").notNull(),
    releaseInputHash: text("release_input_hash").notNull(),
    releaseGeneration: integer("release_generation").notNull(),
    acceptedCount: integer("accepted_count").notNull().default(0),
    preparedCount: integer("prepared_count").notNull().default(0),
    incompleteCount: integer("incomplete_count").notNull().default(0),
    releasedCount: integer("released_count").notNull().default(0),
    state: text("state", { enum: ["dirty", "withheld", "released"] as const }).notNull(),
    releaseProofId: text("release_proof_id").references(() => sourceReviewReleaseProofs.proofId),
    cacheVectorHash: text("cache_vector_hash").notNull(),
    invalidationReasonCode: text("invalidation_reason_code"),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("source_release_dirty_idx").on(table.state, table.updatedAt, table.sourceId),
    check("source_release_state_coverage_check", sql`${table.coverageMode} in ('complete_current', 'discovery_frontier')`),
    check("source_release_state_state_check", sql`${table.state} in ('dirty', 'withheld', 'released')`),
  ],
);
export const sourceAccessState = sqliteTable(
  "source_access_state",
  {
    sourceId: text("source_id").notNull().references(() => auctionSources.id),
    laneKey: text("lane_key").notNull(),
    state: text("state", { enum: sourceAccessStates }).notNull(),
    reasonCode: text("reason_code"),
    failureFingerprint: text("failure_fingerprint"),
    nextEligibleAt: text("next_eligible_at"),
    lastObservedAt: text("last_observed_at"),
    currentInputHash: text("current_input_hash").notNull(),
    currentInputRevision: integer("current_input_revision").notNull().default(1),
    currentInputAttemptCount: integer("current_input_attempt_count").notNull().default(0),
    manualResetAt: text("manual_reset_at"),
    manualResetReason: text("manual_reset_reason"),
    manualResetActor: text("manual_reset_actor"),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.laneKey] }),
    index("source_access_eligibility_idx").on(table.state, table.nextEligibleAt, table.sourceId, table.laneKey),
    check("source_access_state_check", sql`${table.state} in ('ready', 'cooldown', 'manual_reset_required')`),
    check("source_access_attempt_check", sql`${table.currentInputRevision} >= 1 and ${table.currentInputAttemptCount} >= 0`),
  ],
);
export const sourceAcquisitionReservations = sqliteTable(
  "source_acquisition_reservations",
  {
    reservationId: text("reservation_id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => auctionSources.id),
    requestRole: text("request_role").notNull(),
    requestIdentity: text("request_identity").notNull(),
    pageOrPartitionIdentity: text("page_or_partition_identity"),
    priorCheckpointIdentity: text("prior_checkpoint_identity"),
    adapterVersion: text("adapter_version").notNull(),
    proofVersion: text("proof_version").notNull(),
    laneKey: text("lane_key").notNull(),
    expectedGeneration: integer("expected_generation").notNull(),
    inputHash: text("input_hash").notNull(),
    inputRevision: integer("input_revision").notNull(),
    requestBudget: integer("request_budget").notNull(),
    requestsConsumed: integer("requests_consumed").notNull().default(0),
    leaseOwner: text("lease_owner").notNull(),
    expiresAt: text("expires_at").notNull(),
    state: text("state", { enum: ["reserved", "acquired", "committed", "stale", "failed", "expired"] as const }).notNull().default("reserved"),
    failureCode: text("failure_code"),
    failureFingerprint: text("failure_fingerprint"),
    createdAt: text("created_at").notNull().default(nowUtc),
    acquiredAt: text("acquired_at"),
    committedAt: text("committed_at"),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("source_acquisition_ready_idx").on(table.state, table.expiresAt, table.sourceId, table.laneKey, table.createdAt),
    index("source_acquisition_input_idx").on(table.sourceId, table.requestRole, table.inputHash, table.inputRevision, table.createdAt),
    check("source_acquisition_reservation_state_check", sql`${table.state} in ('reserved', 'acquired', 'committed', 'stale', 'failed', 'expired')`),
    check("source_acquisition_reservation_count_check", sql`${table.expectedGeneration} >= 1 and ${table.inputRevision} >= 1 and ${table.requestBudget} between 1 and 10000 and ${table.requestsConsumed} between 0 and ${table.requestBudget}`),
  ],
);
export const sourceAcquiredBundles = sqliteTable(
  "source_acquired_bundles",
  {
    bundleIdentity: text("bundle_identity").primaryKey(),
    reservationId: text("reservation_id").notNull().references(() => sourceAcquisitionReservations.reservationId),
    sourceId: text("source_id").notNull().references(() => auctionSources.id),
    requestIdentity: text("request_identity").notNull(),
    responseHash: text("response_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    contentType: text("content_type").notNull(),
    contentEncoding: text("content_encoding"),
    byteLength: integer("byte_length").notNull(),
    bodyStorageKey: text("body_storage_key"),
    parserVersion: text("parser_version").notNull(),
    validationVersion: text("validation_version").notNull(),
    validatedMetadataJson: text("validated_metadata_json").notNull(),
    state: text("state", { enum: ["acquired", "validated", "committed", "discarded"] as const }).notNull(),
    acquiredAt: text("acquired_at").notNull(),
    validatedAt: text("validated_at"),
    committedAt: text("committed_at"),
    discardedAt: text("discarded_at"),
  },
  (table) => [
    uniqueIndex("source_acquired_bundle_reservation_idx").on(table.reservationId),
    index("source_acquired_bundle_state_idx").on(table.state, table.sourceId, table.acquiredAt),
    check("source_acquired_bundle_state_check", sql`${table.state} in ('acquired', 'validated', 'committed', 'discarded')`),
    check("source_acquired_bundle_size_check", sql`${table.byteLength} between 0 and 268435456`),
    check("source_acquired_bundle_metadata_check", sql`length(${table.validatedMetadataJson}) <= 65536 and json_valid(${table.validatedMetadataJson}) and json_type(${table.validatedMetadataJson}) = 'object'`),
  ],
);
export const imageContentBlobs = sqliteTable(
  "image_content_blobs",
  {
    contentHash: text("content_hash").primaryKey(),
    hashAlgorithm: text("hash_algorithm", { enum: ["sha256"] as const }).notNull().default("sha256"),
    mimeType: text("mime_type", { enum: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const }).notNull(),
    byteLength: integer("byte_length").notNull(),
    storageKey: text("storage_key").notNull(),
    validationVersion: text("validation_version").notNull(),
    validationHash: text("validation_hash").notNull(),
    pixelWidth: integer("pixel_width"),
    pixelHeight: integer("pixel_height"),
    lifecycleState: text("lifecycle_state", { enum: ["active", "missing", "deleted"] as const }).notNull().default("active"),
    firstAcquiredAt: text("first_acquired_at").notNull().default(nowUtc),
    lastVerifiedAt: text("last_verified_at").notNull().default(nowUtc),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("image_content_storage_key_idx").on(table.storageKey),
    index("image_content_lifecycle_idx").on(table.lifecycleState, table.lastVerifiedAt, table.contentHash),
    check("image_content_blob_hash_check", sql`${table.hashAlgorithm} = 'sha256' and length(${table.contentHash}) = 71 and substr(${table.contentHash}, 1, 7) = 'sha256:' and substr(${table.contentHash}, 8) not glob '*[^0-9a-f]*'`),
    check("image_content_blob_mime_check", sql`${table.mimeType} in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif')`),
    check("image_content_blob_size_check", sql`${table.byteLength} between 1 and 52428800 and (${table.pixelWidth} is null or ${table.pixelWidth} >= 1) and (${table.pixelHeight} is null or ${table.pixelHeight} >= 1)`),
  ],
);
export const listingImageContentLinks = sqliteTable(
  "listing_image_content_links",
  {
    linkIdentity: text("link_identity").primaryKey(),
    listingId: text("listing_id").notNull().references(() => listingStubs.id, { onDelete: "cascade" }),
    listingImageId: text("listing_image_id").notNull().references(() => listingImages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull().references(() => imageContentBlobs.contentHash),
    sourceImageIdentityHash: text("source_image_identity_hash").notNull(),
    sourcePosition: integer("source_position").notNull(),
    representativePrimary: integer("representative_primary", { mode: "boolean" }).notNull().default(false),
    acquisitionMethod: text("acquisition_method", { enum: ["browser", "direct", "resolved_endpoint", "content_reuse"] as const }).notNull(),
    acquisitionProvenanceHash: text("acquisition_provenance_hash").notNull(),
    sourceInputHash: text("source_input_hash").notNull(),
    linkedAt: text("linked_at").notNull().default(nowUtc),
  },
  (table) => [
    uniqueIndex("listing_image_content_exact_idx").on(table.listingImageId, table.sourceInputHash, table.contentHash),
    index("listing_image_content_listing_idx").on(table.listingId, table.representativePrimary, table.sourcePosition, table.linkIdentity),
    index("listing_image_content_blob_idx").on(table.contentHash, table.listingId, table.listingImageId),
    check("listing_image_content_position_check", sql`${table.sourcePosition} >= 0`),
    check("listing_image_content_primary_check", sql`${table.representativePrimary} in (0, 1)`),
  ],
);
export const listingImageContentHeads = sqliteTable(
  "listing_image_content_heads",
  {
    listingImageId: text("listing_image_id").primaryKey().references(() => listingImages.id, { onDelete: "cascade" }),
    listingId: text("listing_id").notNull().references(() => listingStubs.id, { onDelete: "cascade" }),
    linkIdentity: text("link_identity").notNull().references(() => listingImageContentLinks.linkIdentity),
    contentHash: text("content_hash").notNull().references(() => imageContentBlobs.contentHash),
    sourceInputHash: text("source_input_hash").notNull(),
    representativePrimary: integer("representative_primary", { mode: "boolean" }).notNull().default(false),
    generation: integer("generation").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(nowUtc),
  },
  (table) => [
    index("listing_image_content_head_listing_idx").on(table.listingId, table.representativePrimary, table.listingImageId),
    index("listing_image_content_head_blob_idx").on(table.contentHash, table.listingImageId),
    check("listing_image_content_head_primary_check", sql`${table.representativePrimary} in (0, 1)`),
    check("listing_image_content_head_generation_check", sql`${table.generation} >= 1`),
  ],
);
export type AuctionSourceRow = typeof auctionSources.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;
export type DiscoveryRunRow = typeof discoveryRuns.$inferSelect;
export type EnrichmentRunRow = typeof enrichmentRuns.$inferSelect;
export type PipelineRunLeaseRow = typeof pipelineRunLease.$inferSelect;
export type ListingStubRow = typeof listingStubs.$inferSelect;
export type SourceCurrentListingRow = typeof sourceCurrentListings.$inferSelect;
export type SourceInventoryPublicationRow =
  typeof sourceInventoryPublications.$inferSelect;
export type SourceInventoryPublicationHeadRow =
  typeof sourceInventoryPublicationHeads.$inferSelect;
export type SourceInventoryObservationRow = typeof sourceInventoryObservations.$inferSelect;
export type SourceOriginPriorityObservationRow =
  typeof sourceOriginPriorityObservations.$inferSelect;
export type ListingDetailRow = typeof listingDetails.$inferSelect;
export type UpstreamLotRepresentativeRow =
  typeof upstreamLotRepresentatives.$inferSelect;
export type ListingUpstreamProvenanceRow =
  typeof listingUpstreamProvenance.$inferSelect;
export type ListingUpstreamAliasObservationRow =
  typeof listingUpstreamAliasObservations.$inferSelect;
export type ListingDetailObservationRow = typeof listingDetailObservations.$inferSelect;
export type ListingActionDeadlineRow = typeof listingActionDeadlines.$inferSelect;
export type ListingRecoveryStatusRow = typeof listingRecoveryStatus.$inferSelect;
export type ListingDetailTerminalStatusRow =
  typeof listingDetailTerminalStatus.$inferSelect;
export type ListingImageRow = typeof listingImages.$inferSelect;
export type ListingVoteRow = typeof listingVotes.$inferSelect;
export type ListingLotFeedbackRow = typeof listingLotFeedback.$inferSelect;
export type ProfileVersionRow = typeof profileVersions.$inferSelect;
export type ProfileSignalFeedbackRow = typeof profileSignalFeedback.$inferSelect;
export type ProfileVersionSignalFeedbackRow = typeof profileVersionSignalFeedback.$inferSelect;
export type AiArtifactRow = typeof aiArtifacts.$inferSelect;
export type EmbeddingRow = typeof embeddings.$inferSelect;
export type PreferenceModelActivationEventRow =
  typeof preferenceModelActivationEvents.$inferSelect;
export type LearnedListingScoreRow = typeof learnedListingScores.$inferSelect;
export type PipelineGenerationStateRow = typeof pipelineGenerationState.$inferSelect;
export type ListingOperationalOwnershipRow = typeof listingOperationalOwnership.$inferSelect;
export type ListingCurrentPipelineStateRow = typeof listingCurrentPipelineState.$inferSelect;
export type PipelineWorkItemRow = typeof pipelineWorkItems.$inferSelect;
export type PipelineRebuildStateRow = typeof pipelineRebuildState.$inferSelect;
export type PipelineAuditReceiptRow = typeof pipelineAuditReceipts.$inferSelect;
export type PipelineExecutionEvidenceRow = typeof pipelineExecutionEvidence.$inferSelect;
export type PipelineComponentExecutionLinkRow =
  typeof pipelineComponentExecutionLinks.$inferSelect;
export type ListingEnrichmentHeadRow = typeof listingEnrichmentHeads.$inferSelect;
export type ListingPreferenceScoreHeadRow = typeof listingPreferenceScoreHeads.$inferSelect;
export type PreferenceShadowScoreV2Row = typeof preferenceShadowScoresV2.$inferSelect;
export type PreferenceV2ActiveScoreHeadRow = typeof preferenceV2ActiveScoreHeads.$inferSelect;
export type PreferenceV2ScoreCoverageReceiptRow =
  typeof preferenceV2ScoreCoverageReceipts.$inferSelect;
export type SourceReviewReleaseProofRow = typeof sourceReviewReleaseProofs.$inferSelect;
export type SourceReviewReleaseStateRow = typeof sourceReviewReleaseState.$inferSelect;
export type SourceAccessStateRow = typeof sourceAccessState.$inferSelect;
export type SourceAcquisitionReservationRow =
  typeof sourceAcquisitionReservations.$inferSelect;
export type SourceAcquiredBundleRow = typeof sourceAcquiredBundles.$inferSelect;
export type ImageContentBlobRow = typeof imageContentBlobs.$inferSelect;
export type ListingImageContentLinkRow = typeof listingImageContentLinks.$inferSelect;
export type ListingImageContentHeadRow = typeof listingImageContentHeads.$inferSelect;
