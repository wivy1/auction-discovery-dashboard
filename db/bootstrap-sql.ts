/** Fresh public schema. Future changes must migrate this public version. */
export const DATABASE_SCHEMA_VERSION = 45;
export const CREATE_SCHEMA_METADATA_SQL = `
  CREATE TABLE IF NOT EXISTS _auction_discovery_public_schema (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 0),
    applied_at TEXT NOT NULL
  )
`;
export const READ_SCHEMA_VERSION_SQL = `
  SELECT version
  FROM _auction_discovery_public_schema
  WHERE singleton = 1
  LIMIT 1
`;
export const PUBLIC_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS source_acquisition_publications (
    proof_id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL UNIQUE,
    bundle_identity TEXT NOT NULL,
    resulting_inventory_run_id TEXT NOT NULL,
    resulting_union_count INTEGER NOT NULL CHECK (resulting_union_count >= 0),
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_acquisition_state (
    source_id TEXT PRIMARY KEY NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auction_sources (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      permission_status TEXT NOT NULL DEFAULT 'review_required',
      pickup_location_visibility TEXT NOT NULL DEFAULT 'mixed',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT auction_sources_permission_status_check
        CHECK (permission_status IN ('allowed', 'review_required', 'disabled')),
      CONSTRAINT auction_sources_location_visibility_check
        CHECK (pickup_location_visibility IN ('listing', 'detail', 'mixed'))
    )`,
  `CREATE TABLE IF NOT EXISTS discovery_runs (
      id TEXT PRIMARY KEY NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      origin_postal_code TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      listings_discovered INTEGER NOT NULL DEFAULT 0,
      listings_new INTEGER NOT NULL DEFAULT 0,
      listings_accepted INTEGER NOT NULL DEFAULT 0,
      listings_excluded INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      CONSTRAINT discovery_runs_trigger_check
        CHECK (trigger IN ('manual', 'scheduled')),
      CONSTRAINT discovery_runs_status_check
        CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled'))
    )`,
  `CREATE TABLE IF NOT EXISTS source_runs (
      id TEXT PRIMARY KEY NOT NULL,
      discovery_run_id TEXT NOT NULL
        REFERENCES discovery_runs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      stubs_discovered INTEGER NOT NULL DEFAULT 0,
      skipped_already_seen INTEGER NOT NULL DEFAULT 0,
      details_fetched INTEGER NOT NULL DEFAULT 0,
      listings_accepted INTEGER NOT NULL DEFAULT 0,
      listings_excluded INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      CONSTRAINT source_runs_status_check
        CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled'))
    )`,
  `CREATE TABLE IF NOT EXISTS listing_stubs (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      source_listing_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT,
      lot_number TEXT,
      visible_city TEXT,
      visible_state TEXT,
      visible_postal_code TEXT,
      visible_country_code TEXT,
      location_evidence_source TEXT,
      thumbnail_url TEXT,
      first_seen_run_id TEXT REFERENCES discovery_runs(id),
      discovered_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS source_current_listings (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      inventory_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
      observed_at TEXT NOT NULL
    , review_candidate INTEGER NOT NULL DEFAULT 1 CONSTRAINT source_current_listings_review_candidate_check CHECK (review_candidate IN (0, 1)))`,
  `CREATE TABLE IF NOT EXISTS source_inventory_observations (
      run_id TEXT NOT NULL REFERENCES discovery_runs(id),
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, listing_id)
    )`,
  `CREATE TABLE IF NOT EXISTS source_inventory_traversals (
      traversal_id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL UNIQUE
        REFERENCES auction_sources(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      expected_pages INTEGER NOT NULL,
      expected_listings INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT source_inventory_traversals_expected_pages_check
        CHECK (expected_pages >= 1),
      CONSTRAINT source_inventory_traversals_expected_listings_check
        CHECK (expected_listings >= 0)
    )`,
  `CREATE TABLE IF NOT EXISTS source_inventory_traversal_pages (
      traversal_id TEXT NOT NULL
        REFERENCES source_inventory_traversals(traversal_id) ON DELETE CASCADE,
      page_key TEXT NOT NULL,
      completed_at TEXT,
      observed_count INTEGER NOT NULL DEFAULT 0,
      inventory_member INTEGER NOT NULL,
      review_candidate INTEGER NOT NULL,
      PRIMARY KEY (traversal_id, page_key),
      CONSTRAINT source_inventory_traversal_pages_observed_count_check
        CHECK (observed_count >= 0),
      CONSTRAINT source_inventory_traversal_pages_inventory_member_check
        CHECK (inventory_member IN (0, 1)),
      CONSTRAINT source_inventory_traversal_pages_review_candidate_check
        CHECK (review_candidate IN (0, 1))
    )`,
  `CREATE TABLE IF NOT EXISTS source_inventory_traversal_listings (
      traversal_id TEXT NOT NULL
        REFERENCES source_inventory_traversals(traversal_id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES auction_sources(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      inventory_member INTEGER NOT NULL DEFAULT 0,
      review_candidate INTEGER NOT NULL DEFAULT 0, partition_key TEXT NOT NULL DEFAULT 'legacy'
      CHECK (length(partition_key) BETWEEN 1 AND 256), fact_hash TEXT
      CHECK (
        fact_hash IS NULL
        OR (
          length(fact_hash) = 24
          AND substr(fact_hash, 1, 8) = 'fnv1a64:'
          AND substr(fact_hash, 9) NOT GLOB '*[^0-9a-f]*'
        )
      ),
      PRIMARY KEY (traversal_id, listing_id),
      CONSTRAINT source_inventory_traversal_listings_inventory_member_check
        CHECK (inventory_member IN (0, 1)),
      CONSTRAINT source_inventory_traversal_listings_review_candidate_check
        CHECK (review_candidate IN (0, 1))
    )`,
  `CREATE TABLE IF NOT EXISTS dashboard_new_listings (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      first_seen_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
      added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
  `CREATE TABLE IF NOT EXISTS listing_details (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      title_at_scrape TEXT NOT NULL,
      category_at_scrape TEXT,
      lot_number_at_scrape TEXT,
      raw_description TEXT NOT NULL,
      clean_description TEXT NOT NULL,
      price_amount_minor INTEGER,
      price_currency TEXT,
      price_display_text TEXT,
      auction_ends_at TEXT,
      seller TEXT,
      pickup_city TEXT,
      pickup_state TEXT,
      pickup_postal_code TEXT,
      pickup_country_code TEXT,
      pickup_evidence_source TEXT,
      scraped_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      CONSTRAINT listing_details_price_amount_check
        CHECK (price_amount_minor IS NULL OR price_amount_minor >= 0)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_images (
      id TEXT PRIMARY KEY NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      source_url TEXT NOT NULL,
      thumbnail_url TEXT,
      download_status TEXT NOT NULL DEFAULT 'deferred',
      local_path TEXT,
      content_hash TEXT,
      width INTEGER,
      height INTEGER,
      downloaded_at TEXT,
      download_error TEXT, acquisition_method TEXT CONSTRAINT listing_images_acquisition_method_check CHECK (acquisition_method IS NULL OR acquisition_method IN ('browser', 'direct', 'resolved_endpoint')), attempt_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT listing_images_attempt_count_check CHECK (attempt_count >= 0), last_attempted_at TEXT, download_error_code TEXT,
      CONSTRAINT listing_images_position_check CHECK (position >= 0),
      CONSTRAINT listing_images_download_status_check
        CHECK (download_status IN ('deferred', 'pending', 'downloaded', 'failed')),
      CONSTRAINT listing_images_dimensions_check
        CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0))
    )`,
  `CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY NOT NULL,
      cache_key TEXT NOT NULL,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      country_code TEXT NOT NULL DEFAULT 'US',
      display_name TEXT,
      latitude REAL,
      longitude REAL,
      resolution_status TEXT NOT NULL DEFAULT 'pending',
      geocode_provider TEXT,
      geocoded_at TEXT,
      geocode_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT locations_coordinates_check
        CHECK (
          (latitude IS NULL AND longitude IS NULL)
          OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
        ),
      CONSTRAINT locations_resolution_status_check
        CHECK (resolution_status IN ('pending', 'resolved', 'unknown', 'failed'))
    )`,
  `CREATE TABLE IF NOT EXISTS route_cache (
      id TEXT PRIMARY KEY NOT NULL,
      origin_cache_key TEXT NOT NULL,
      destination_location_id TEXT NOT NULL
        REFERENCES locations(id) ON DELETE CASCADE,
      provider_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      drive_seconds INTEGER,
      distance_meters INTEGER,
      drive_bucket TEXT NOT NULL DEFAULT 'exclude',
      is_approximate INTEGER NOT NULL DEFAULT 0,
      calculated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_code TEXT,
      CONSTRAINT route_cache_bucket_check
        CHECK (drive_bucket IN ('under_2h', 'under_4h', 'under_8h', 'exclude')),
      CONSTRAINT route_cache_drive_seconds_check
        CHECK (drive_seconds IS NULL OR drive_seconds >= 0)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_routes (
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id) ON DELETE CASCADE,
      route_cache_id TEXT NOT NULL REFERENCES route_cache(id) ON DELETE CASCADE,
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (listing_id, route_cache_id)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_votes (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_votes_value_check
        CHECK (value IN ('interested', 'not_interested'))
    )`,
  `CREATE TABLE IF NOT EXISTS interest_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
  `CREATE TABLE IF NOT EXISTS profile_versions (
      id TEXT PRIMARY KEY NOT NULL,
      profile_id TEXT NOT NULL REFERENCES interest_profiles(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      algorithm_version TEXT NOT NULL,
      human_summary TEXT NOT NULL,
      interested_concepts_json TEXT NOT NULL DEFAULT '[]',
      not_interested_concepts_json TEXT NOT NULL DEFAULT '[]',
      interested_support_count INTEGER NOT NULL DEFAULT 0,
      not_interested_support_count INTEGER NOT NULL DEFAULT 0,
      based_on_votes_through TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT profile_versions_version_check CHECK (version > 0),
      CONSTRAINT profile_versions_support_counts_check
        CHECK (interested_support_count >= 0 AND not_interested_support_count >= 0)
    )`,
  `CREATE TABLE IF NOT EXISTS profile_version_votes (
      profile_version_id TEXT NOT NULL
        REFERENCES profile_versions(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      PRIMARY KEY (profile_version_id, listing_id),
      CONSTRAINT profile_version_votes_value_check
        CHECK (value IN ('interested', 'not_interested'))
    )`,
  `CREATE TABLE IF NOT EXISTS ai_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      task TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      output_text TEXT,
      output_json TEXT,
      output_hash TEXT,
      generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT ai_artifacts_subject_type_check
        CHECK (subject_type IN ('listing', 'profile_version')),
      CONSTRAINT ai_artifacts_task_check
        CHECK (
          task IN (
            'listing_extraction',
            'listing_summary',
            'semantic_document',
            'recommendation_explanation',
            'profile_summary'
          )
        ),
      CONSTRAINT ai_artifacts_output_check
        CHECK (output_text IS NOT NULL OR output_json IS NOT NULL)
    )`,
  `CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT embeddings_dimensions_check CHECK (dimensions > 0),
      CONSTRAINT embeddings_subject_type_check
        CHECK (subject_type IN ('listing', 'profile_version')),
      CONSTRAINT embeddings_kind_check
        CHECK (
          kind IN (
            'listing_semantic_document',
            'profile_positive_centroid',
            'profile_negative_centroid'
          )
        )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_scores (
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id) ON DELETE CASCADE,
      profile_version_id TEXT NOT NULL
        REFERENCES profile_versions(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      positive_similarity REAL,
      negative_similarity REAL,
      exploration_weight REAL NOT NULL DEFAULT 0,
      explanation_artifact_id TEXT REFERENCES ai_artifacts(id),
      scored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (listing_id, profile_version_id),
      CONSTRAINT listing_scores_exploration_weight_check
        CHECK (exploration_weight BETWEEN 0 AND 1)
    )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
      singleton INTEGER PRIMARY KEY NOT NULL,
      origin_postal_code TEXT NOT NULL,
      origin_country TEXT NOT NULL DEFAULT 'US',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT app_settings_singleton_check CHECK (singleton = 1),
      CONSTRAINT app_settings_origin_postal_check
        CHECK (length(origin_postal_code) = 5 AND origin_postal_code NOT GLOB '*[^0-9]*'),
      CONSTRAINT app_settings_origin_country_check CHECK (origin_country = 'US')
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_run_lease (
      singleton INTEGER PRIMARY KEY NOT NULL,
      run_kind TEXT NOT NULL,
      run_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      CONSTRAINT pipeline_run_lease_singleton_check CHECK (singleton = 1),
      CONSTRAINT pipeline_run_lease_kind_check
        CHECK (run_kind IN ('discovery', 'enrichment'))
    )`,
  `CREATE TABLE IF NOT EXISTS listing_lot_feedback (
      id TEXT PRIMARY KEY NOT NULL,
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'operator_dashboard',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_lot_feedback_decision_check
        CHECK (decision IN ('lot', 'not_lot', 'automatic')),
      CONSTRAINT listing_lot_feedback_source_check
        CHECK (source = 'operator_dashboard')
    )`,
  `CREATE TABLE IF NOT EXISTS profile_signal_feedback (
      id TEXT PRIMARY KEY NOT NULL,
      profile_id TEXT NOT NULL
        REFERENCES interest_profiles(id) ON DELETE CASCADE,
      concept TEXT NOT NULL,
      normalized_concept TEXT NOT NULL,
      polarity TEXT NOT NULL,
      action TEXT NOT NULL,
      source_profile_version_id TEXT NOT NULL
        REFERENCES profile_versions(id),
      source TEXT NOT NULL DEFAULT 'operator_dashboard',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT profile_signal_feedback_concept_check
        CHECK (length(concept) BETWEEN 1 AND 200),
      CONSTRAINT profile_signal_feedback_normalized_check
        CHECK (length(normalized_concept) BETWEEN 1 AND 200),
      CONSTRAINT profile_signal_feedback_polarity_check
        CHECK (polarity IN ('positive', 'negative')),
      CONSTRAINT profile_signal_feedback_action_check
        CHECK (action IN ('removed', 'restored')),
      CONSTRAINT profile_signal_feedback_source_check
        CHECK (source = 'operator_dashboard')
    )`,
  `CREATE TABLE IF NOT EXISTS profile_version_signal_feedback (
      profile_version_id TEXT NOT NULL
        REFERENCES profile_versions(id) ON DELETE CASCADE,
      feedback_id TEXT NOT NULL
        REFERENCES profile_signal_feedback(id),
      PRIMARY KEY (profile_version_id, feedback_id)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_detail_observations (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      auction_ends_at TEXT,
      source_url TEXT NOT NULL,
      detail_content_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_detail_observations_title_check
        CHECK (length(trim(title)) > 0),
      CONSTRAINT listing_detail_observations_hash_check
        CHECK (
          length(detail_content_hash) = 24
          AND substr(detail_content_hash, 1, 8) = 'fnv1a64:'
          AND substr(detail_content_hash, 9) NOT GLOB '*[^0-9a-f]*'
        )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_recovery_status (
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      origin_cache_key TEXT NOT NULL,
      state TEXT NOT NULL,
      stage TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_attempted_at TEXT NOT NULL,
      last_error_code TEXT,
      PRIMARY KEY (listing_id, origin_cache_key),
      CONSTRAINT listing_recovery_status_state_check
        CHECK (state IN ('retryable', 'terminal')),
      CONSTRAINT listing_recovery_status_stage_check
        CHECK (stage IN ('scope', 'prefilter', 'detail', 'route', 'image', 'pipeline')),
      CONSTRAINT listing_recovery_status_attempt_check
        CHECK (attempt_count >= 1)
    )`,
  `CREATE TABLE IF NOT EXISTS source_inventory_publications (
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      inventory_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
      listing_count INTEGER NOT NULL,
      published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), collection_counts_json TEXT NOT NULL DEFAULT '[]'
      CHECK (
        json_valid(collection_counts_json)
        AND json_type(collection_counts_json) = 'array'
      ),
      PRIMARY KEY (source_id, inventory_run_id),
      CONSTRAINT source_inventory_publications_counts_check
        CHECK (listing_count >= 0)
    )`,
  `CREATE TABLE IF NOT EXISTS source_inventory_publication_heads (
      source_id TEXT PRIMARY KEY NOT NULL REFERENCES auction_sources(id),
      inventory_run_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (source_id, inventory_run_id)
        REFERENCES source_inventory_publications (source_id, inventory_run_id)
    )`,
  `CREATE TABLE IF NOT EXISTS upstream_lot_representatives (
      platform TEXT NOT NULL,
      host TEXT NOT NULL,
      event_or_catalog_id TEXT NOT NULL,
      lot_id TEXT NOT NULL,
      owner_listing_id TEXT NOT NULL UNIQUE
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (platform, host, event_or_catalog_id, lot_id),
      CONSTRAINT upstream_lot_representatives_identity_check
        CHECK (
          length(platform) BETWEEN 1 AND 100
          AND length(host) BETWEEN 1 AND 253
          AND length(event_or_catalog_id) BETWEEN 1 AND 512
          AND length(lot_id) BETWEEN 1 AND 512
        ),
      CONSTRAINT upstream_lot_representatives_host_check
        CHECK (host = lower(host) AND instr(host, '/') = 0 AND instr(host, ':') = 0)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_upstream_provenance (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      host TEXT NOT NULL,
      event_or_catalog_id TEXT NOT NULL,
      lot_id TEXT NOT NULL,
      event_name TEXT,
      event_url TEXT,
      observed_aliases_json TEXT NOT NULL DEFAULT '[]',
      observed_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, publisher_event_json TEXT
      CHECK (
        publisher_event_json IS NULL
        OR (
          json_valid(publisher_event_json)
          AND json_type(publisher_event_json) = 'object'
        )
      ),
      FOREIGN KEY (platform, host, event_or_catalog_id, lot_id)
        REFERENCES upstream_lot_representatives (
          platform, host, event_or_catalog_id, lot_id
        ),
      CONSTRAINT listing_upstream_provenance_identity_check
        CHECK (
          length(platform) BETWEEN 1 AND 100
          AND length(host) BETWEEN 1 AND 253
          AND length(event_or_catalog_id) BETWEEN 1 AND 512
          AND length(lot_id) BETWEEN 1 AND 512
        ),
      CONSTRAINT listing_upstream_provenance_host_check
        CHECK (host = lower(host) AND instr(host, '/') = 0 AND instr(host, ':') = 0),
      CONSTRAINT listing_upstream_provenance_event_check
        CHECK (
          (event_name IS NULL OR length(event_name) BETWEEN 1 AND 1000)
          AND (event_url IS NULL OR event_url LIKE 'https://%')
        ),
      CONSTRAINT listing_upstream_provenance_aliases_check
        CHECK (json_valid(observed_aliases_json) AND json_type(observed_aliases_json) = 'array'),
      CONSTRAINT listing_upstream_provenance_hash_check
        CHECK (
          length(content_hash) = 24
          AND substr(content_hash, 1, 8) = 'fnv1a64:'
          AND substr(content_hash, 9) NOT GLOB '*[^0-9a-f]*'
        )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_upstream_alias_observations (
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id) ON DELETE CASCADE,
      observed_canonical_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      host TEXT NOT NULL,
      event_or_catalog_id TEXT NOT NULL,
      lot_id TEXT NOT NULL,
      event_name TEXT,
      event_url TEXT,
      observed_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (listing_id, observed_canonical_url),
      CONSTRAINT listing_upstream_alias_observations_identity_check
        CHECK (
          length(platform) BETWEEN 1 AND 100
          AND length(host) BETWEEN 1 AND 253
          AND length(event_or_catalog_id) BETWEEN 1 AND 512
          AND length(lot_id) BETWEEN 1 AND 512
        ),
      CONSTRAINT listing_upstream_alias_observations_urls_check
        CHECK (
          host = lower(host)
          AND observed_canonical_url LIKE 'https://%'
          AND (event_url IS NULL OR event_url LIKE 'https://%')
        ),
      CONSTRAINT listing_upstream_alias_observations_hash_check
        CHECK (
          length(content_hash) = 24
          AND substr(content_hash, 1, 8) = 'fnv1a64:'
          AND substr(content_hash, 9) NOT GLOB '*[^0-9a-f]*'
        )
    )`,
  `CREATE TABLE IF NOT EXISTS source_origin_priority_observations (
      run_id TEXT NOT NULL REFERENCES discovery_runs(id),
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      origin_cache_key TEXT NOT NULL,
      origin_postal_code TEXT NOT NULL,
      radius_miles INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (run_id, listing_id, origin_cache_key),
      CONSTRAINT source_origin_priority_origin_check
        CHECK (origin_postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]'),
      CONSTRAINT source_origin_priority_radius_check
        CHECK (radius_miles BETWEEN 1 AND 1000),
      CONSTRAINT source_origin_priority_cache_key_check
        CHECK (length(origin_cache_key) BETWEEN 1 AND 512),
      CONSTRAINT source_origin_priority_content_hash_check
        CHECK (length(content_hash) BETWEEN 1 AND 256)
    )`,
  `CREATE TABLE IF NOT EXISTS "listing_detail_terminal_status" (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      error_code TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_attempted_at TEXT NOT NULL,
      CONSTRAINT listing_detail_terminal_status_error_check
        CHECK (error_code IN ('detail_access_restricted', 'detail_location_conflict')),
      CONSTRAINT listing_detail_terminal_status_attempt_check
        CHECK (attempt_count >= 1)
    )`,
  `CREATE TABLE IF NOT EXISTS source_inventory_acquisition_attempts (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL UNIQUE
        REFERENCES auction_sources(id) ON DELETE CASCADE,
      traversal_id TEXT UNIQUE
        REFERENCES source_inventory_traversals(traversal_id) ON DELETE CASCADE,
      reserved_request_units INTEGER NOT NULL,
      max_request_units INTEGER NOT NULL,
      active_plan_fingerprint TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT source_inventory_acquisition_attempts_reserved_check
        CHECK (
          reserved_request_units >= 0
          AND reserved_request_units <= max_request_units
        ),
      CONSTRAINT source_inventory_acquisition_attempts_max_check
        CHECK (max_request_units >= 1),
      CONSTRAINT source_inventory_acquisition_attempts_plan_check
        CHECK (
          active_plan_fingerprint IS NULL
          OR (
            length(active_plan_fingerprint) = 64
            AND active_plan_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_action_deadlines (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      deadline_at TEXT NOT NULL,
      basis TEXT NOT NULL,
      source_text TEXT NOT NULL,
      source_url TEXT NOT NULL,
      detail_content_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_action_deadlines_timestamp_check CHECK (
        deadline_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(deadline_at) IS NOT NULL
      ),
      CONSTRAINT listing_action_deadlines_basis_check
        CHECK (basis = 'live_auction_start'),
      CONSTRAINT listing_action_deadlines_source_text_check
        CHECK (length(trim(source_text)) BETWEEN 1 AND 200),
      CONSTRAINT listing_action_deadlines_source_url_check
        CHECK (source_url GLOB 'https://*'),
      CONSTRAINT listing_action_deadlines_hash_check CHECK (
        length(detail_content_hash) = 24
        AND substr(detail_content_hash, 1, 8) = 'fnv1a64:'
        AND substr(detail_content_hash, 9) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_model_activation_events (
      event_identity TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      sequence INTEGER NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      event_authority TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      previous_event_identity TEXT
        REFERENCES preference_model_activation_events(event_identity),
      recorded_at TEXT NOT NULL,
      protocol_identity TEXT NOT NULL,
      implementation_identity TEXT NOT NULL,
      work_root_identity TEXT NOT NULL,
      snapshot_evidence_identity TEXT NOT NULL,
      manifest_identity TEXT NOT NULL,
      candidate_guard_identity TEXT NOT NULL,
      test_result_guard_identity TEXT NOT NULL,
      evaluation_result_identity TEXT NOT NULL,
      terminal_orchestration_receipt_identity TEXT NOT NULL,
      retrospective_shadow_result_identity TEXT NOT NULL,
      current_shadow_receipt_identity TEXT NOT NULL,
      disabled_exercise_shadow_receipt_identity TEXT NOT NULL,
      current_cohort_snapshot_identity TEXT NOT NULL,
      selected_family TEXT NOT NULL,
      selected_configuration_id TEXT NOT NULL,
      candidate_artifact_relative_path TEXT NOT NULL,
      candidate_artifact_hash TEXT NOT NULL,
      canonical_fitted_state_hash TEXT NOT NULL,
      runtime_identity TEXT NOT NULL,
      deterministic_profile_version_id TEXT NOT NULL
        REFERENCES profile_versions(id),
      profile_prior_hash TEXT NOT NULL,
      accepted_baseline_profile_identity TEXT NOT NULL,
      profile_feedback_snapshot_identity TEXT NOT NULL,
      decision_evidence_hash TEXT NOT NULL,
      CONSTRAINT preference_model_activation_schema_check CHECK (
        schema_version = 'm21-preference-model-activation-event-v1'
      ),
      CONSTRAINT preference_model_activation_sequence_check CHECK (sequence >= 1),
      CONSTRAINT preference_model_activation_event_type_check CHECK (
        event_type IN ('promote', 'disable')
      ),
      CONSTRAINT preference_model_activation_authority_reason_check CHECK (
        (event_type = 'promote' AND event_authority = 'operator'
          AND reason_code = 'operator_promote')
        OR (event_type = 'disable' AND event_authority = 'operator'
          AND reason_code = 'operator_disable')
        OR (event_type = 'disable' AND event_authority = 'automatic_fail_closed'
          AND reason_code IN (
            'artifact_or_implementation_drift',
            'profile_or_input_drift',
            'provider_or_resource_failure',
            'incomplete_scoring_run'
          ))
      ),
      CONSTRAINT preference_model_activation_artifact_path_check CHECK (
        candidate_artifact_relative_path =
          'artifacts/preference-candidate-v1.joblib'
      ),
      CONSTRAINT preference_model_activation_timestamp_check CHECK (
        recorded_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(recorded_at) IS NOT NULL
      ),
      CONSTRAINT preference_model_activation_text_check CHECK (
        length(trim(selected_family)) BETWEEN 1 AND 200
        AND length(trim(selected_configuration_id)) BETWEEN 1 AND 200
        AND length(trim(deterministic_profile_version_id)) BETWEEN 1 AND 200
      ),
      CONSTRAINT preference_model_activation_hashes_check CHECK (
        length(event_identity) = 71 AND substr(event_identity, 1, 7) = 'sha256:'
        AND event_identity NOT GLOB 'sha256:*[^0-9a-f]*'
        AND (previous_event_identity IS NULL OR (
          length(previous_event_identity) = 71
          AND substr(previous_event_identity, 1, 7) = 'sha256:'
          AND previous_event_identity NOT GLOB 'sha256:*[^0-9a-f]*'
        ))
        AND length(protocol_identity) = 71
        AND length(implementation_identity) = 71
        AND length(work_root_identity) = 71
        AND length(snapshot_evidence_identity) = 71
        AND length(manifest_identity) = 71
        AND length(candidate_guard_identity) = 71
        AND length(test_result_guard_identity) = 71
        AND length(evaluation_result_identity) = 71
        AND length(terminal_orchestration_receipt_identity) = 71
        AND length(retrospective_shadow_result_identity) = 71
        AND length(current_shadow_receipt_identity) = 71
        AND length(disabled_exercise_shadow_receipt_identity) = 71
        AND length(current_cohort_snapshot_identity) = 71
        AND length(candidate_artifact_hash) = 71
        AND length(canonical_fitted_state_hash) = 71
        AND length(runtime_identity) = 71
        AND length(profile_prior_hash) = 71
        AND length(accepted_baseline_profile_identity) = 71
        AND length(profile_feedback_snapshot_identity) = 71
        AND length(decision_evidence_hash) = 71
      )
    )`,
  `CREATE TABLE IF NOT EXISTS learned_listing_scores (
      row_identity TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      activation_event_identity TEXT NOT NULL
        REFERENCES preference_model_activation_events(event_identity),
      protocol_identity TEXT NOT NULL,
      implementation_identity TEXT NOT NULL,
      candidate_artifact_hash TEXT NOT NULL,
      evaluation_result_identity TEXT NOT NULL,
      selected_family TEXT NOT NULL,
      selected_configuration_id TEXT NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      deterministic_profile_version_id TEXT NOT NULL
        REFERENCES profile_versions(id),
      profile_prior_hash TEXT NOT NULL,
      accepted_baseline_profile_identity TEXT NOT NULL,
      profile_feedback_snapshot_identity TEXT NOT NULL,
      clean_description_hash TEXT NOT NULL,
      extraction_artifact_id TEXT NOT NULL REFERENCES ai_artifacts(id),
      extraction_output_hash TEXT NOT NULL,
      semantic_artifact_id TEXT NOT NULL REFERENCES ai_artifacts(id),
      semantic_output_hash TEXT NOT NULL,
      embedding_id TEXT NOT NULL REFERENCES embeddings(id),
      embedding_input_hash TEXT NOT NULL,
      embedding_vector_hash TEXT NOT NULL,
      scoring_input_hash TEXT NOT NULL,
      baseline_probability REAL NOT NULL,
      candidate_probability REAL NOT NULL,
      score REAL NOT NULL,
      explanation TEXT NOT NULL,
      explanation_hash TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      CONSTRAINT learned_listing_scores_schema_check CHECK (
        schema_version = 'm21-learned-listing-score-v1'
      ),
      CONSTRAINT learned_listing_scores_probability_check CHECK (
        baseline_probability BETWEEN 0 AND 1
        AND candidate_probability BETWEEN 0 AND 1
        AND score BETWEEN 0 AND 100
      ),
      CONSTRAINT learned_listing_scores_text_check CHECK (
        length(trim(selected_family)) BETWEEN 1 AND 200
        AND length(trim(selected_configuration_id)) BETWEEN 1 AND 200
        AND length(trim(explanation)) BETWEEN 1 AND 1000
        AND explanation = trim(explanation)
      ),
      CONSTRAINT learned_listing_scores_timestamp_check CHECK (
        scored_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(scored_at) IS NOT NULL
      ),
      CONSTRAINT learned_listing_scores_hashes_check CHECK (
        length(row_identity) = 71 AND substr(row_identity, 1, 7) = 'sha256:'
        AND row_identity NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(activation_event_identity) = 71
        AND length(protocol_identity) = 71
        AND length(implementation_identity) = 71
        AND length(candidate_artifact_hash) = 71
        AND length(evaluation_result_identity) = 71
        AND length(profile_prior_hash) = 71
        AND length(accepted_baseline_profile_identity) = 71
        AND length(profile_feedback_snapshot_identity) = 71
        AND length(clean_description_hash) = 71
        AND length(extraction_output_hash) = 71
        AND length(semantic_output_hash) = 71
        AND length(embedding_input_hash) = 71
        AND length(embedding_vector_hash) = 71
        AND length(scoring_input_hash) = 71
        AND length(explanation_hash) = 71
      )
    )`,
  `CREATE TABLE IF NOT EXISTS adhoc_review_cohorts (
      id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'building',
      refresh_boundary TEXT NOT NULL,
      origin_cache_key TEXT NOT NULL,
      route_provider_name TEXT NOT NULL,
      selection_seed TEXT NOT NULL,
      selection_version TEXT NOT NULL,
      requested_target INTEGER NOT NULL,
      selected_count INTEGER NOT NULL DEFAULT 0,
      ordinary_accepted_count INTEGER NOT NULL DEFAULT 0,
      distance_exempt_count INTEGER NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL,
      head_vector_hash TEXT NOT NULL,
      base_cohort_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      ready_at TEXT,
      CONSTRAINT adhoc_review_cohorts_schema_check CHECK (
        schema_version = 'adhoc-review-cohort-v1'
      ),
      CONSTRAINT adhoc_review_cohorts_state_check CHECK (
        state IN ('building', 'ready')
      ),
      CONSTRAINT adhoc_review_cohorts_counts_check CHECK (
        requested_target BETWEEN 1 AND 5000
        AND selected_count BETWEEN 0 AND 5000
        AND ordinary_accepted_count BETWEEN 0 AND selected_count
        AND distance_exempt_count = selected_count - ordinary_accepted_count
        AND source_count BETWEEN 1 AND 100
      ),
      CONSTRAINT adhoc_review_cohorts_ready_check CHECK (
        (state = 'building' AND ready_at IS NULL)
        OR (state = 'ready' AND ready_at IS NOT NULL AND selected_count >= 1)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS adhoc_review_cohort_sources (
      cohort_id TEXT NOT NULL REFERENCES adhoc_review_cohorts(id),
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      inventory_run_id TEXT NOT NULL,
      listing_count INTEGER NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (cohort_id, source_id),
      UNIQUE (cohort_id, source_id, inventory_run_id),
      FOREIGN KEY (source_id, inventory_run_id)
        REFERENCES source_inventory_publications(source_id, inventory_run_id),
      CONSTRAINT adhoc_review_cohort_sources_count_check
        CHECK (listing_count >= 0)
    )`,
  `CREATE TABLE IF NOT EXISTS adhoc_review_cohort_memberships (
      cohort_id TEXT NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      source_id TEXT NOT NULL,
      inventory_run_id TEXT NOT NULL,
      basis TEXT NOT NULL,
      category_stratum TEXT NOT NULL,
      state_stratum TEXT NOT NULL,
      stable_selection_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      selected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (cohort_id, listing_id),
      UNIQUE (cohort_id, ordinal),
      FOREIGN KEY (cohort_id, source_id, inventory_run_id)
        REFERENCES adhoc_review_cohort_sources(
          cohort_id, source_id, inventory_run_id
        ),
      CONSTRAINT adhoc_review_cohort_memberships_basis_check CHECK (
        basis IN ('ordinary_accepted', 'distance_exempt')
      ),
      CONSTRAINT adhoc_review_cohort_memberships_ordinal_check CHECK (
        ordinal BETWEEN 1 AND 5000
      )
    )`,
  `CREATE TABLE IF NOT EXISTS physical_asset_clusters (
      physical_asset_cluster_id TEXT PRIMARY KEY NOT NULL,
      cluster_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      manual_review_state TEXT NOT NULL DEFAULT 'unreviewed',
      notes TEXT,
      CONSTRAINT physical_asset_clusters_id_check CHECK (
        length(physical_asset_cluster_id) = 71
        AND substr(physical_asset_cluster_id, 1, 7) = 'sha256:'
        AND physical_asset_cluster_id NOT GLOB 'sha256:*[^0-9a-f]*'
      ),
      CONSTRAINT physical_asset_clusters_review_check CHECK (
        manual_review_state IN (
          'unreviewed', 'sampled_confirmed', 'sampled_false_merge',
          'manual_confirmed', 'manual_split_required'
        )
      )
    )`,
  `CREATE TABLE IF NOT EXISTS physical_asset_cluster_edges (
      edge_id TEXT PRIMARY KEY NOT NULL,
      physical_asset_cluster_id TEXT NOT NULL
        REFERENCES physical_asset_clusters(physical_asset_cluster_id),
      left_listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      right_listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      edge_reason TEXT NOT NULL,
      edge_confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (algorithm_version, left_listing_id, right_listing_id, edge_reason),
      CONSTRAINT physical_asset_cluster_edges_order_check CHECK (
        left_listing_id < right_listing_id
      ),
      CONSTRAINT physical_asset_cluster_edges_reason_check CHECK (
        edge_reason IN (
          'exact_owner_alias',
          'exact_source_listing_revision',
          'exact_canonical_url',
          'exact_upstream_publisher_lot',
          'exact_manufacturer_model_serial',
          'exact_primary_image_context',
          'perceptual_image_context',
          'normalized_title_context',
          'manual_must_link'
        )
      ),
      CONSTRAINT physical_asset_cluster_edges_confidence_check CHECK (
        edge_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT physical_asset_cluster_edges_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS physical_asset_cluster_members (
      physical_asset_cluster_id TEXT NOT NULL
        REFERENCES physical_asset_clusters(physical_asset_cluster_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      edge_reason TEXT NOT NULL,
      edge_confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (physical_asset_cluster_id, listing_id),
      UNIQUE (algorithm_version, listing_id),
      CONSTRAINT physical_asset_cluster_members_reason_check CHECK (
        edge_reason IN (
          'singleton',
          'exact_owner_alias',
          'exact_source_listing_revision',
          'exact_canonical_url',
          'exact_upstream_publisher_lot',
          'exact_manufacturer_model_serial',
          'exact_primary_image_context',
          'perceptual_image_context',
          'normalized_title_context',
          'manual_must_link'
        )
      ),
      CONSTRAINT physical_asset_cluster_members_confidence_check CHECK (
        edge_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT physical_asset_cluster_members_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS physical_asset_cluster_overrides (
      override_id TEXT PRIMARY KEY NOT NULL,
      left_listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      right_listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (left_listing_id, right_listing_id, created_at),
      CONSTRAINT physical_asset_cluster_overrides_order_check CHECK (
        left_listing_id < right_listing_id
      ),
      CONSTRAINT physical_asset_cluster_overrides_decision_check CHECK (
        decision IN ('must_link', 'cannot_link')
      ),
      CONSTRAINT physical_asset_cluster_overrides_reason_check CHECK (
        length(trim(reason)) BETWEEN 1 AND 1000 AND reason = trim(reason)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS auction_event_blocks (
      auction_event_block_id TEXT PRIMARY KEY NOT NULL,
      block_version TEXT NOT NULL,
      source_id TEXT REFERENCES auction_sources(id),
      authoritative_event_key TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT auction_event_blocks_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS auction_event_block_members (
      auction_event_block_id TEXT NOT NULL
        REFERENCES auction_event_blocks(auction_event_block_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      evidence_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (auction_event_block_id, listing_id),
      UNIQUE (algorithm_version, listing_id),
      CONSTRAINT auction_event_block_members_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS semantic_families (
      semantic_family_id TEXT PRIMARY KEY NOT NULL,
      family_version TEXT NOT NULL,
      industry_domain TEXT NOT NULL,
      primary_asset_class TEXT NOT NULL,
      canonical_manufacturer TEXT NOT NULL,
      assignment_method TEXT NOT NULL,
      clustering_parameters_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT semantic_families_method_check CHECK (
        assignment_method IN ('deterministic_key', 'embedding_fallback')
      ),
      CONSTRAINT semantic_families_parameters_check CHECK (
        json_valid(clustering_parameters_json)
        AND json_type(clustering_parameters_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS semantic_family_members (
      semantic_family_id TEXT NOT NULL
        REFERENCES semantic_families(semantic_family_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      assignment_method TEXT NOT NULL,
      assignment_confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (semantic_family_id, listing_id),
      UNIQUE (algorithm_version, listing_id),
      CONSTRAINT semantic_family_members_method_check CHECK (
        assignment_method IN ('deterministic_key', 'embedding_fallback')
      ),
      CONSTRAINT semantic_family_members_confidence_check CHECK (
        assignment_confidence BETWEEN 0 AND 1
      ),
      CONSTRAINT semantic_family_members_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_feature_snapshots (
      snapshot_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      legacy_vote_id TEXT,
      future_feedback_id TEXT,
      label_timestamp TEXT NOT NULL,
      source_observation_timestamp TEXT,
      factual_detail_timestamp TEXT,
      image_set_timestamp TEXT,
      displayed_facts_json TEXT NOT NULL,
      direct_source_features_json TEXT NOT NULL,
      extraction_artifact_id TEXT REFERENCES ai_artifacts(id),
      semantic_artifact_id TEXT REFERENCES ai_artifacts(id),
      embedding_id TEXT REFERENCES embeddings(id),
      visual_artifact_id TEXT,
      point_in_time_status TEXT NOT NULL,
      missing_reasons_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      feature_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_feature_snapshots_schema_check CHECK (
        schema_version = 'preference-feature-snapshot-v1'
      ),
      CONSTRAINT preference_feature_snapshots_label_check CHECK (
        (legacy_vote_id IS NOT NULL AND future_feedback_id IS NULL)
        OR (legacy_vote_id IS NULL AND future_feedback_id IS NOT NULL)
      ),
      CONSTRAINT preference_feature_snapshots_status_check CHECK (
        point_in_time_status IN (
          'complete', 'content_only', 'operational_incomplete', 'unrecoverable'
        )
      ),
      CONSTRAINT preference_feature_snapshots_json_check CHECK (
        json_valid(displayed_facts_json)
        AND json_type(displayed_facts_json) = 'object'
        AND json_valid(direct_source_features_json)
        AND json_type(direct_source_features_json) = 'object'
        AND json_valid(missing_reasons_json)
        AND json_type(missing_reasons_json) = 'array'
        AND json_valid(provenance_json)
        AND json_type(provenance_json) = 'object'
      ),
      CONSTRAINT preference_feature_snapshots_hash_check CHECK (
        length(snapshot_id) = 71
        AND substr(snapshot_id, 1, 7) = 'sha256:'
        AND snapshot_id NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(feature_payload_hash) = 71
        AND substr(feature_payload_hash, 1, 7) = 'sha256:'
        AND feature_payload_hash NOT GLOB 'sha256:*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_historical_examples (
      example_identity TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      snapshot_id TEXT NOT NULL
        REFERENCES preference_feature_snapshots(snapshot_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      original_vote_id TEXT,
      original_binary_label TEXT NOT NULL,
      vote_created_at TEXT NOT NULL,
      vote_updated_at TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      source_listing_id TEXT NOT NULL,
      physical_asset_cluster_id TEXT
        REFERENCES physical_asset_clusters(physical_asset_cluster_id),
      physical_asset_nullable_reason TEXT,
      auction_event_block_id TEXT
        REFERENCES auction_event_blocks(auction_event_block_id),
      auction_event_nullable_reason TEXT,
      semantic_family_id TEXT
        REFERENCES semantic_families(semantic_family_id),
      semantic_family_nullable_reason TEXT,
      review_session_id TEXT,
      review_slate_id TEXT,
      historical_exposure_reason TEXT NOT NULL,
      former_split_provenance_json TEXT NOT NULL,
      feature_provenance_json TEXT NOT NULL,
      corpus_manifest_identity TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_historical_examples_schema_check CHECK (
        schema_version = 'preference-historical-example-v1'
      ),
      CONSTRAINT preference_historical_examples_label_check CHECK (
        original_binary_label IN ('interested', 'not_interested')
      ),
      CONSTRAINT preference_historical_examples_exposure_check CHECK (
        review_session_id IS NULL
        AND review_slate_id IS NULL
        AND historical_exposure_reason = 'pre_v2_telemetry_unavailable'
      ),
      CONSTRAINT preference_historical_examples_identity_reason_check CHECK (
        (physical_asset_cluster_id IS NOT NULL
          OR physical_asset_nullable_reason IS NOT NULL)
        AND (auction_event_block_id IS NOT NULL
          OR auction_event_nullable_reason IS NOT NULL)
        AND (semantic_family_id IS NOT NULL
          OR semantic_family_nullable_reason IS NOT NULL)
      ),
      CONSTRAINT preference_historical_examples_json_check CHECK (
        json_valid(former_split_provenance_json)
        AND json_type(former_split_provenance_json) = 'object'
        AND json_valid(feature_provenance_json)
        AND json_type(feature_provenance_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_feedback_reason_codes_v2 (
      registry_version TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      applicable_feedback_state TEXT NOT NULL,
      display_label TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (registry_version, reason_code, applicable_feedback_state),
      CONSTRAINT preference_feedback_reason_codes_v2_version_check CHECK (
        length(trim(registry_version)) BETWEEN 1 AND 200
        AND registry_version = trim(registry_version)
      ),
      CONSTRAINT preference_feedback_reason_codes_v2_code_check CHECK (
        length(reason_code) BETWEEN 1 AND 100
        AND reason_code = lower(reason_code)
        AND reason_code NOT GLOB '*[^a-z0-9_]*'
      ),
      CONSTRAINT preference_feedback_reason_codes_v2_state_check CHECK (
        applicable_feedback_state IN (
          'not_interesting_item',
          'interesting_item_bad_listing',
          'interesting_listing',
          'needs_more_information'
        )
      ),
      CONSTRAINT preference_feedback_reason_codes_v2_text_check CHECK (
        length(trim(display_label)) BETWEEN 1 AND 200
        AND length(trim(description)) BETWEEN 1 AND 1000
      )
    )`,
  `CREATE TABLE IF NOT EXISTS review_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      started_at TEXT NOT NULL,
      queue_name TEXT NOT NULL,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      logging_policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT review_sessions_schema_check CHECK (
        schema_version = 'preference-v2-review-session-v1'
      ),
      CONSTRAINT review_sessions_queue_check CHECK (
        queue_name IN ('best_matches', 'teach_the_model', 'unfiltered_new')
      ),
      CONSTRAINT review_sessions_timestamp_check CHECK (
        julianday(started_at) IS NOT NULL
      ),
      CONSTRAINT review_sessions_identity_check CHECK (
        length(trim(session_id)) BETWEEN 1 AND 200
        AND length(trim(client_id)) BETWEEN 1 AND 200
        AND length(trim(user_id)) BETWEEN 1 AND 200
        AND length(trim(logging_policy_version)) BETWEEN 1 AND 200
      )
    )`,
  `CREATE TABLE IF NOT EXISTS review_session_end_events (
      end_event_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL UNIQUE REFERENCES review_sessions(session_id),
      ended_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT review_session_end_events_outcome_check CHECK (
        outcome IN ('completed', 'abandoned', 'interrupted')
      ),
      CONSTRAINT review_session_end_events_timestamp_check CHECK (
        julianday(ended_at) IS NOT NULL
      )
    )`,
  `CREATE TABLE IF NOT EXISTS review_slates (
      slate_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES review_sessions(session_id),
      generated_at TEXT NOT NULL,
      candidate_set_hash TEXT NOT NULL,
      candidate_count INTEGER NOT NULL,
      ranking_policy_version TEXT NOT NULL,
      baseline_model_version TEXT NOT NULL,
      baseline_feature_version TEXT NOT NULL,
      candidate_model_version TEXT NOT NULL,
      candidate_feature_version TEXT NOT NULL,
      exploration_rate REAL NOT NULL,
      randomization_seed TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT review_slates_schema_check CHECK (
        schema_version = 'preference-v2-review-slate-v1'
      ),
      CONSTRAINT review_slates_count_check CHECK (
        candidate_count BETWEEN 1 AND 5000
      ),
      CONSTRAINT review_slates_probability_check CHECK (
        exploration_rate BETWEEN 0 AND 1
      ),
      CONSTRAINT review_slates_hash_check CHECK (
        length(candidate_set_hash) = 71
        AND substr(candidate_set_hash, 1, 7) = 'sha256:'
        AND substr(candidate_set_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      CONSTRAINT review_slates_timestamp_check CHECK (
        julianday(generated_at) IS NOT NULL
      ),
      CONSTRAINT review_slates_text_check CHECK (
        length(trim(ranking_policy_version)) BETWEEN 1 AND 200
        AND length(trim(baseline_model_version)) BETWEEN 1 AND 200
        AND length(trim(baseline_feature_version)) BETWEEN 1 AND 200
        AND length(trim(candidate_model_version)) BETWEEN 1 AND 200
        AND length(trim(candidate_feature_version)) BETWEEN 1 AND 200
        AND length(trim(randomization_seed)) BETWEEN 1 AND 500
      )
    )`,
  `CREATE TABLE IF NOT EXISTS review_slate_candidates (
      slate_candidate_id TEXT PRIMARY KEY NOT NULL,
      slate_id TEXT NOT NULL REFERENCES review_slates(slate_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      physical_asset_cluster_id TEXT NOT NULL
        REFERENCES physical_asset_clusters(physical_asset_cluster_id),
      auction_event_block_id TEXT NOT NULL
        REFERENCES auction_event_blocks(auction_event_block_id),
      semantic_family_id TEXT NOT NULL
        REFERENCES semantic_families(semantic_family_id),
      position INTEGER NOT NULL,
      candidate_set_hash TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      baseline_score REAL NOT NULL,
      candidate_score REAL NOT NULL,
      intrinsic_score REAL NOT NULL,
      observed_preference_score REAL NOT NULL,
      actionability_score REAL NOT NULL,
      investigation_score REAL NOT NULL,
      uncertainty_score REAL NOT NULL,
      selection_probability REAL NOT NULL,
      entry_reason TEXT NOT NULL,
      exploration_bucket TEXT NOT NULL,
      displayed_snapshot_id TEXT NOT NULL,
      displayed_snapshot_hash TEXT NOT NULL,
      displayed_snapshot_at TEXT NOT NULL,
      displayed_price_amount_minor INTEGER,
      displayed_price_currency TEXT,
      displayed_location TEXT,
      displayed_condition TEXT,
      displayed_time_remaining_seconds INTEGER,
      displayed_auction_ends_at TEXT,
      displayed_facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (slate_id, listing_id),
      UNIQUE (slate_id, position),
      CONSTRAINT review_slate_candidates_position_check CHECK (position >= 1),
      CONSTRAINT review_slate_candidates_score_check CHECK (
        baseline_score BETWEEN 0 AND 1
        AND candidate_score BETWEEN 0 AND 1
        AND intrinsic_score BETWEEN 0 AND 1
        AND observed_preference_score BETWEEN 0 AND 1
        AND actionability_score BETWEEN 0 AND 1
        AND investigation_score BETWEEN 0 AND 1
        AND uncertainty_score BETWEEN 0 AND 1
      ),
      CONSTRAINT review_slate_candidates_propensity_check CHECK (
        selection_probability > 0 AND selection_probability <= 1
      ),
      CONSTRAINT review_slate_candidates_entry_reason_check CHECK (
        entry_reason IN (
          'best_match_exploitation',
          'model_disagreement',
          'decision_boundary_uncertainty',
          'underrepresented_domain',
          'information_gain',
          'sparse_text_or_image_led',
          'sparse_text_led',
          'unfiltered_new'
        )
      ),
      CONSTRAINT review_slate_candidates_bucket_check CHECK (
        exploration_bucket IN (
          'exploitation', 'controlled_exploration',
          'teach_the_model', 'unfiltered_new'
        )
      ),
      CONSTRAINT review_slate_candidates_hash_check CHECK (
        length(candidate_set_hash) = 71
        AND substr(candidate_set_hash, 1, 7) = 'sha256:'
        AND substr(candidate_set_hash, 8) NOT GLOB '*[^0-9a-f]*'
        AND length(displayed_snapshot_hash) = 71
        AND substr(displayed_snapshot_hash, 1, 7) = 'sha256:'
        AND substr(displayed_snapshot_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      CONSTRAINT review_slate_candidates_snapshot_check CHECK (
        length(trim(displayed_snapshot_id)) BETWEEN 1 AND 500
        AND julianday(displayed_snapshot_at) IS NOT NULL
        AND json_valid(displayed_facts_json)
        AND json_type(displayed_facts_json) = 'object'
        AND json_type(displayed_facts_json, '$.price_amount_minor') IS NOT NULL
        AND json_type(displayed_facts_json, '$.price_currency') IS NOT NULL
        AND json_type(displayed_facts_json, '$.location') IS NOT NULL
        AND json_type(displayed_facts_json, '$.condition') IS NOT NULL
        AND json_type(displayed_facts_json, '$.time_remaining_seconds') IS NOT NULL
        AND json_type(displayed_facts_json, '$.auction_ends_at') IS NOT NULL
        AND json_extract(displayed_facts_json, '$.price_amount_minor')
          IS displayed_price_amount_minor
        AND json_extract(displayed_facts_json, '$.price_currency')
          IS displayed_price_currency
        AND json_extract(displayed_facts_json, '$.location') IS displayed_location
        AND json_extract(displayed_facts_json, '$.condition') IS displayed_condition
        AND json_extract(displayed_facts_json, '$.time_remaining_seconds')
          IS displayed_time_remaining_seconds
        AND json_extract(displayed_facts_json, '$.auction_ends_at')
          IS displayed_auction_ends_at
      ),
      CONSTRAINT review_slate_candidates_fact_bounds_check CHECK (
        (displayed_price_amount_minor IS NULL OR displayed_price_amount_minor >= 0)
        AND (displayed_time_remaining_seconds IS NULL
          OR displayed_time_remaining_seconds >= 0)
        AND (displayed_auction_ends_at IS NULL
          OR julianday(displayed_auction_ends_at) IS NOT NULL)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS review_slate_freezes (
      slate_id TEXT PRIMARY KEY NOT NULL REFERENCES review_slates(slate_id),
      candidate_set_hash TEXT NOT NULL,
      observed_candidate_count INTEGER NOT NULL,
      frozen_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
  `CREATE TABLE IF NOT EXISTS listing_impressions (
      impression_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      slate_candidate_id TEXT NOT NULL UNIQUE
        REFERENCES review_slate_candidates(slate_candidate_id),
      slate_id TEXT NOT NULL REFERENCES review_slates(slate_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      physical_asset_cluster_id TEXT NOT NULL
        REFERENCES physical_asset_clusters(physical_asset_cluster_id),
      auction_event_block_id TEXT NOT NULL
        REFERENCES auction_event_blocks(auction_event_block_id),
      semantic_family_id TEXT NOT NULL
        REFERENCES semantic_families(semantic_family_id),
      position INTEGER NOT NULL,
      candidate_set_hash TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      baseline_score REAL NOT NULL,
      candidate_score REAL NOT NULL,
      intrinsic_score REAL NOT NULL,
      observed_preference_score REAL NOT NULL,
      actionability_score REAL NOT NULL,
      investigation_score REAL NOT NULL,
      uncertainty_score REAL NOT NULL,
      selection_probability REAL NOT NULL,
      entry_reason TEXT NOT NULL,
      exploration_bucket TEXT NOT NULL,
      displayed_snapshot_id TEXT NOT NULL,
      displayed_snapshot_hash TEXT NOT NULL,
      displayed_snapshot_at TEXT NOT NULL,
      displayed_price_amount_minor INTEGER,
      displayed_price_currency TEXT,
      displayed_location TEXT,
      displayed_condition TEXT,
      displayed_time_remaining_seconds INTEGER,
      displayed_auction_ends_at TEXT,
      displayed_facts_json TEXT NOT NULL,
      displayed_at TEXT NOT NULL,
      visible_ms INTEGER NOT NULL,
      opened_at TEXT,
      details_opened_at TEXT,
      image_viewed_at TEXT,
      recorded_at TEXT NOT NULL,
      UNIQUE (slate_id, listing_id),
      UNIQUE (slate_id, position),
      CONSTRAINT listing_impressions_schema_check CHECK (
        schema_version = 'preference-v2-listing-impression-v1'
      ),
      CONSTRAINT listing_impressions_visible_check CHECK (visible_ms >= 1),
      CONSTRAINT listing_impressions_score_check CHECK (
        baseline_score BETWEEN 0 AND 1
        AND candidate_score BETWEEN 0 AND 1
        AND intrinsic_score BETWEEN 0 AND 1
        AND observed_preference_score BETWEEN 0 AND 1
        AND actionability_score BETWEEN 0 AND 1
        AND investigation_score BETWEEN 0 AND 1
        AND uncertainty_score BETWEEN 0 AND 1
        AND selection_probability > 0 AND selection_probability <= 1
      ),
      CONSTRAINT listing_impressions_json_check CHECK (
        json_valid(displayed_facts_json)
        AND json_type(displayed_facts_json) = 'object'
        AND json_type(displayed_facts_json, '$.price_amount_minor') IS NOT NULL
        AND json_type(displayed_facts_json, '$.price_currency') IS NOT NULL
        AND json_type(displayed_facts_json, '$.location') IS NOT NULL
        AND json_type(displayed_facts_json, '$.condition') IS NOT NULL
        AND json_type(displayed_facts_json, '$.time_remaining_seconds') IS NOT NULL
        AND json_type(displayed_facts_json, '$.auction_ends_at') IS NOT NULL
        AND json_extract(displayed_facts_json, '$.price_amount_minor')
          IS displayed_price_amount_minor
        AND json_extract(displayed_facts_json, '$.price_currency')
          IS displayed_price_currency
        AND json_extract(displayed_facts_json, '$.location') IS displayed_location
        AND json_extract(displayed_facts_json, '$.condition') IS displayed_condition
        AND json_extract(displayed_facts_json, '$.time_remaining_seconds')
          IS displayed_time_remaining_seconds
        AND json_extract(displayed_facts_json, '$.auction_ends_at')
          IS displayed_auction_ends_at
      ),
      CONSTRAINT listing_impressions_fact_bounds_check CHECK (
        (displayed_price_amount_minor IS NULL OR displayed_price_amount_minor >= 0)
        AND (displayed_time_remaining_seconds IS NULL
          OR displayed_time_remaining_seconds >= 0)
        AND (displayed_auction_ends_at IS NULL
          OR julianday(displayed_auction_ends_at) IS NOT NULL)
      ),
      CONSTRAINT listing_impressions_actual_display_check CHECK (
        julianday(displayed_at) IS NOT NULL
        AND displayed_snapshot_at <= displayed_at
        AND recorded_at >= displayed_at
        AND (opened_at IS NULL OR opened_at >= displayed_at)
        AND (details_opened_at IS NULL OR details_opened_at >= displayed_at)
        AND (image_viewed_at IS NULL OR image_viewed_at >= displayed_at)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_feedback_v2 (
      feedback_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      impression_id TEXT NOT NULL UNIQUE REFERENCES listing_impressions(impression_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      feedback_state TEXT NOT NULL,
      strength INTEGER,
      action TEXT,
      action_at TEXT,
      reason_registry_version TEXT,
      reason_code TEXT,
      feedback_at TEXT NOT NULL,
      time_to_feedback_ms INTEGER NOT NULL,
      feature_snapshot_id TEXT NOT NULL,
      feature_snapshot_hash TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      feedback_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (reason_registry_version, reason_code, feedback_state)
        REFERENCES preference_feedback_reason_codes_v2 (
          registry_version, reason_code, applicable_feedback_state
        ),
      CONSTRAINT preference_feedback_v2_schema_check CHECK (
        schema_version = 'preference-feedback-v2'
      ),
      CONSTRAINT preference_feedback_v2_state_check CHECK (
        feedback_state IN (
          'not_interesting_item',
          'interesting_item_bad_listing',
          'interesting_listing',
          'needs_more_information'
        )
      ),
      CONSTRAINT preference_feedback_v2_strength_check CHECK (
        strength IS NULL OR strength IN (1, 2, 3)
      ),
      CONSTRAINT preference_feedback_v2_action_check CHECK (
        action IS NULL OR action IN ('inspect', 'watch', 'pursue')
      ),
      CONSTRAINT preference_feedback_v2_action_time_check CHECK (
        (action IS NULL AND action_at IS NULL)
        OR (action IS NOT NULL AND action_at IS NOT NULL AND action_at <= feedback_at)
      ),
      CONSTRAINT preference_feedback_v2_reason_check CHECK (
        (reason_registry_version IS NULL AND reason_code IS NULL)
        OR (reason_registry_version IS NOT NULL AND reason_code IS NOT NULL)
      ),
      CONSTRAINT preference_feedback_v2_time_check CHECK (
        julianday(feedback_at) IS NOT NULL AND time_to_feedback_ms >= 0
      ),
      CONSTRAINT preference_feedback_v2_hash_check CHECK (
        length(feature_snapshot_hash) = 71
        AND substr(feature_snapshot_hash, 1, 7) = 'sha256:'
        AND substr(feature_snapshot_hash, 8) NOT GLOB '*[^0-9a-f]*'
        AND length(feedback_payload_hash) = 71
        AND substr(feedback_payload_hash, 1, 7) = 'sha256:'
        AND substr(feedback_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_pairwise_comparisons_v2 (
      comparison_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      slate_id TEXT NOT NULL REFERENCES review_slates(slate_id),
      left_impression_id TEXT NOT NULL REFERENCES listing_impressions(impression_id),
      right_impression_id TEXT NOT NULL REFERENCES listing_impressions(impression_id),
      result TEXT NOT NULL,
      comparison_at TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      comparison_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (left_impression_id, right_impression_id),
      CONSTRAINT preference_pairwise_comparisons_v2_schema_check CHECK (
        schema_version = 'preference-pairwise-comparison-v2'
      ),
      CONSTRAINT preference_pairwise_comparisons_v2_order_check CHECK (
        left_impression_id < right_impression_id
      ),
      CONSTRAINT preference_pairwise_comparisons_v2_result_check CHECK (
        result IN ('left', 'right', 'equal', 'neither')
      ),
      CONSTRAINT preference_pairwise_comparisons_v2_hash_check CHECK (
        length(comparison_payload_hash) = 71
        AND substr(comparison_payload_hash, 1, 7) = 'sha256:'
        AND substr(comparison_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_shadow_scores_v2 (
      shadow_score_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      physical_asset_cluster_id TEXT NOT NULL
        REFERENCES physical_asset_clusters(physical_asset_cluster_id),
      auction_event_block_id TEXT NOT NULL
        REFERENCES auction_event_blocks(auction_event_block_id),
      semantic_family_id TEXT NOT NULL
        REFERENCES semantic_families(semantic_family_id),
      baseline_score REAL NOT NULL,
      intrinsic_score REAL NOT NULL,
      observed_preference_score REAL NOT NULL,
      actionability_score REAL NOT NULL,
      investigation_score REAL NOT NULL,
      final_score REAL NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      uncertainty REAL NOT NULL,
      explanation_text TEXT NOT NULL,
      explanation_json TEXT NOT NULL,
      fallback_model_version TEXT NOT NULL,
      fallback_score REAL NOT NULL,
      fallback_explanation TEXT NOT NULL,
      promotion_state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (listing_id, model_version, feature_version, snapshot_id),
      CONSTRAINT preference_shadow_scores_v2_schema_check CHECK (
        schema_version = 'preference-shadow-score-v2'
      ),
      CONSTRAINT preference_shadow_scores_v2_score_check CHECK (
        baseline_score BETWEEN 0 AND 1
        AND intrinsic_score BETWEEN 0 AND 1
        AND observed_preference_score BETWEEN 0 AND 1
        AND actionability_score BETWEEN 0 AND 1
        AND investigation_score BETWEEN 0 AND 1
        AND final_score BETWEEN 0 AND 1
        AND uncertainty BETWEEN 0 AND 1
        AND fallback_score BETWEEN 0 AND 1
      ),
      CONSTRAINT preference_shadow_scores_v2_state_check CHECK (
        promotion_state = 'shadow_only_pending_prospective'
      ),
      CONSTRAINT preference_shadow_scores_v2_hash_check CHECK (
        length(snapshot_hash) = 71
        AND substr(snapshot_hash, 1, 7) = 'sha256:'
        AND substr(snapshot_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      CONSTRAINT preference_shadow_scores_v2_explanation_check CHECK (
        length(trim(explanation_text)) BETWEEN 1 AND 4000
        AND length(trim(fallback_explanation)) BETWEEN 1 AND 4000
        AND json_valid(explanation_json)
        AND json_type(explanation_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_prospective_freezes_v2 (
      freeze_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      protocol_version TEXT NOT NULL,
      baseline_model_version TEXT NOT NULL,
      baseline_feature_version TEXT NOT NULL,
      candidate_model_version TEXT NOT NULL,
      candidate_feature_version TEXT NOT NULL,
      candidate_artifact_hash TEXT NOT NULL,
      retrospective_cutoff_at TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      prospective_not_before TEXT NOT NULL,
      minimum_unique_physical_listings INTEGER NOT NULL,
      minimum_unique_positive_clusters INTEGER NOT NULL,
      minimum_completed_slates_of_25 INTEGER NOT NULL,
      minimum_supported_slices INTEGER NOT NULL,
      minimum_positives_per_supported_slice INTEGER NOT NULL,
      minimum_relative_lift REAL NOT NULL,
      minimum_extra_positive_discoveries_per_25 REAL NOT NULL,
      maximum_supported_slice_recall50_loss REAL NOT NULL,
      bootstrap_lower95_must_exceed_zero INTEGER NOT NULL,
      operator_approval_required INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_prospective_freezes_v2_schema_check CHECK (
        schema_version = 'preference-prospective-freeze-v2'
        AND protocol_version = 'preference-v2-team-draft-v1'
      ),
      CONSTRAINT preference_prospective_freezes_v2_threshold_check CHECK (
        minimum_unique_physical_listings = 1500
        AND minimum_unique_positive_clusters = 75
        AND minimum_completed_slates_of_25 = 60
        AND minimum_supported_slices = 3
        AND minimum_positives_per_supported_slice = 5
        AND minimum_relative_lift = 0.15
        AND minimum_extra_positive_discoveries_per_25 = 1.5
        AND maximum_supported_slice_recall50_loss = 0.2
        AND bootstrap_lower95_must_exceed_zero = 1
        AND operator_approval_required = 1
      ),
      CONSTRAINT preference_prospective_freezes_v2_future_check CHECK (
        julianday(retrospective_cutoff_at) IS NOT NULL
        AND julianday(frozen_at) IS NOT NULL
        AND julianday(prospective_not_before) IS NOT NULL
        AND retrospective_cutoff_at <= frozen_at
        AND frozen_at <= prospective_not_before
      ),
      CONSTRAINT preference_prospective_freezes_v2_state_check CHECK (
        state = 'frozen_pending_future_evidence'
      ),
      CONSTRAINT preference_prospective_freezes_v2_hash_check CHECK (
        length(candidate_artifact_hash) = 71
        AND substr(candidate_artifact_hash, 1, 7) = 'sha256:'
        AND substr(candidate_artifact_hash, 8) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_prospective_assignments_v2 (
      assignment_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      freeze_id TEXT NOT NULL REFERENCES preference_prospective_freezes_v2(freeze_id),
      slate_id TEXT NOT NULL UNIQUE REFERENCES review_slates(slate_id),
      assignment_policy TEXT NOT NULL,
      first_team TEXT NOT NULL,
      assignment_probability REAL NOT NULL,
      randomization_seed TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_prospective_assignments_v2_schema_check CHECK (
        schema_version = 'preference-prospective-assignment-v2'
      ),
      CONSTRAINT preference_prospective_assignments_v2_policy_check CHECK (
        assignment_policy = 'team_draft'
        AND first_team IN ('baseline', 'candidate')
        AND assignment_probability = 0.5
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_prospective_evaluation_receipts_v2 (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      freeze_id TEXT NOT NULL REFERENCES preference_prospective_freezes_v2(freeze_id),
      evaluated_from TEXT NOT NULL,
      evaluated_through TEXT NOT NULL,
      unique_physical_listings_reviewed INTEGER NOT NULL,
      unique_positive_physical_clusters INTEGER NOT NULL,
      completed_slates_of_25 INTEGER NOT NULL,
      supported_slice_count INTEGER NOT NULL,
      minimum_positive_clusters_in_supported_slice INTEGER NOT NULL,
      relative_lift REAL,
      extra_positive_discoveries_per_25 REAL,
      maximum_supported_slice_recall50_loss REAL,
      event_bootstrap_lower95 REAL,
      result_state TEXT NOT NULL,
      prospective_evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_prospective_evaluation_receipts_v2_schema_check CHECK (
        schema_version = 'preference-prospective-evaluation-receipt-v2'
      ),
      CONSTRAINT preference_prospective_evaluation_receipts_v2_count_check CHECK (
        unique_physical_listings_reviewed >= 0
        AND unique_positive_physical_clusters >= 0
        AND completed_slates_of_25 >= 0
        AND supported_slice_count >= 0
        AND minimum_positive_clusters_in_supported_slice >= 0
      ),
      CONSTRAINT preference_prospective_evaluation_receipts_v2_metric_check CHECK (
        (relative_lift IS NULL OR relative_lift >= -1)
        AND (extra_positive_discoveries_per_25 IS NULL
          OR extra_positive_discoveries_per_25 >= -25)
        AND (maximum_supported_slice_recall50_loss IS NULL
          OR maximum_supported_slice_recall50_loss BETWEEN 0 AND 1)
        AND (event_bootstrap_lower95 IS NULL
          OR event_bootstrap_lower95 BETWEEN -1 AND 1)
      ),
      CONSTRAINT preference_prospective_evaluation_receipts_v2_state_check CHECK (
        result_state IN (
          'pending_future_evidence',
          'thresholds_met_pending_operator_approval'
        )
      ),
      CONSTRAINT preference_prospective_evaluation_receipts_v2_hash_check CHECK (
        length(prospective_evidence_hash) = 71
        AND substr(prospective_evidence_hash, 1, 7) = 'sha256:'
        AND substr(prospective_evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_prospective_operator_approvals_v2 (
      approval_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      receipt_id TEXT NOT NULL UNIQUE
        REFERENCES preference_prospective_evaluation_receipts_v2(receipt_id),
      operator_user_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      approval_evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_prospective_operator_approvals_v2_schema_check CHECK (
        schema_version = 'preference-prospective-operator-approval-v2'
      ),
      CONSTRAINT preference_prospective_operator_approvals_v2_decision_check CHECK (
        decision = 'explicitly_approve_promotion'
      ),
      CONSTRAINT preference_prospective_operator_approvals_v2_hash_check CHECK (
        length(approval_evidence_hash) = 71
        AND substr(approval_evidence_hash, 1, 7) = 'sha256:'
        AND substr(approval_evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_prospective_promotion_authorizations_v2 (
      authorization_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      freeze_id TEXT NOT NULL REFERENCES preference_prospective_freezes_v2(freeze_id),
      receipt_id TEXT NOT NULL UNIQUE
        REFERENCES preference_prospective_evaluation_receipts_v2(receipt_id),
      approval_id TEXT NOT NULL UNIQUE
        REFERENCES preference_prospective_operator_approvals_v2(approval_id),
      authorization_state TEXT NOT NULL,
      authorized_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_prospective_promotion_authorizations_v2_schema_check CHECK (
        schema_version = 'preference-prospective-promotion-authorization-v2'
      ),
      CONSTRAINT preference_prospective_promotion_authorizations_v2_state_check CHECK (
        authorization_state = 'authorized_for_separate_operator_promotion'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_interaction_events_v2 (
      interaction_event_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      impression_id TEXT NOT NULL REFERENCES listing_impressions(impression_id),
      slate_candidate_id TEXT NOT NULL
        REFERENCES review_slate_candidates(slate_candidate_id),
      slate_id TEXT NOT NULL REFERENCES review_slates(slate_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      candidate_set_hash TEXT NOT NULL,
      server_sequence INTEGER NOT NULL,
      interaction_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      server_recorded_at TEXT NOT NULL,
      interaction_payload_json TEXT NOT NULL,
      interaction_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (impression_id, server_sequence),
      CONSTRAINT preference_interaction_events_v2_schema_check CHECK (
        schema_version = 'preference-interaction-event-v2'
      ),
      CONSTRAINT preference_interaction_events_v2_sequence_check CHECK (
        server_sequence >= 1
      ),
      CONSTRAINT preference_interaction_events_v2_type_check CHECK (
        interaction_type IN (
          'listing_open', 'image_view', 'inspect', 'watch', 'pursue'
        )
      ),
      CONSTRAINT preference_interaction_events_v2_time_check CHECK (
        julianday(occurred_at) IS NOT NULL
        AND julianday(server_recorded_at) IS NOT NULL
        AND occurred_at GLOB '????-??-??T??:??:??.???Z'
        AND server_recorded_at GLOB '????-??-??T??:??:??.???Z'
        AND server_recorded_at >= occurred_at
      ),
      CONSTRAINT preference_interaction_events_v2_payload_check CHECK (
        json_valid(interaction_payload_json)
        AND json_type(interaction_payload_json) = 'object'
        AND json(interaction_payload_json) = interaction_payload_json
        AND 
  length(interaction_payload_hash) = 71
  AND substr(interaction_payload_hash, 1, 7) = 'sha256:'
  AND substr(interaction_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(candidate_set_hash) = 71
  AND substr(candidate_set_hash, 1, 7) = 'sha256:'
  AND substr(candidate_set_hash, 8) NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_interaction_events_v2_identity_check CHECK (
        
  length(interaction_event_id) = 71
  AND substr(interaction_event_id, 1, 7) = 'sha256:'
  AND substr(interaction_event_id, 8) NOT GLOB '*[^0-9a-f]*'

      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_pairwise_offer_cadence_receipts_v2 (
      cadence_receipt_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES review_sessions(session_id),
      user_id TEXT NOT NULL,
      offer_sequence INTEGER NOT NULL,
      prior_offer_id TEXT REFERENCES preference_pairwise_offers_v2(offer_id),
      ordinary_feedback_count_at_offer INTEGER NOT NULL,
      ordinary_feedback_count_since_prior_offer INTEGER NOT NULL,
      required_ordinary_feedback_interval INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      cadence_evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (user_id, offer_sequence),
      CONSTRAINT preference_pairwise_offer_cadence_v2_schema_check CHECK (
        schema_version = 'preference-pairwise-offer-cadence-v2'
      ),
      CONSTRAINT preference_pairwise_offer_cadence_v2_count_check CHECK (
        offer_sequence >= 1
        AND ordinary_feedback_count_at_offer >= 0
        AND ordinary_feedback_count_since_prior_offer >= 0
        AND required_ordinary_feedback_interval = 20
      ),
      CONSTRAINT preference_pairwise_offer_cadence_v2_time_check CHECK (
        julianday(observed_at) IS NOT NULL
        AND observed_at GLOB '????-??-??T??:??:??.???Z'
      ),
      CONSTRAINT preference_pairwise_offer_cadence_v2_hash_check CHECK (
        
  length(cadence_receipt_id) = 71
  AND substr(cadence_receipt_id, 1, 7) = 'sha256:'
  AND substr(cadence_receipt_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(cadence_evidence_hash) = 71
  AND substr(cadence_evidence_hash, 1, 7) = 'sha256:'
  AND substr(cadence_evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'

      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_pairwise_offers_v2 (
      offer_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      cadence_receipt_id TEXT NOT NULL UNIQUE
        REFERENCES preference_pairwise_offer_cadence_receipts_v2(cadence_receipt_id),
      slate_id TEXT NOT NULL UNIQUE REFERENCES review_slates(slate_id),
      left_slate_candidate_id TEXT NOT NULL
        REFERENCES review_slate_candidates(slate_candidate_id),
      right_slate_candidate_id TEXT NOT NULL
        REFERENCES review_slate_candidates(slate_candidate_id),
      candidate_set_hash TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      entry_reason TEXT NOT NULL,
      offer_probability REAL NOT NULL,
      offered_at TEXT NOT NULL,
      offer_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (left_slate_candidate_id, right_slate_candidate_id, offered_at),
      CONSTRAINT preference_pairwise_offers_v2_schema_check CHECK (
        schema_version = 'preference-pairwise-offer-v2'
      ),
      CONSTRAINT preference_pairwise_offers_v2_order_check CHECK (
        left_slate_candidate_id < right_slate_candidate_id
      ),
      CONSTRAINT preference_pairwise_offers_v2_policy_check CHECK (
        entry_reason = 'information_gain' AND offer_probability = 0.05
      ),
      CONSTRAINT preference_pairwise_offers_v2_time_check CHECK (
        julianday(offered_at) IS NOT NULL
        AND offered_at GLOB '????-??-??T??:??:??.???Z'
      ),
      CONSTRAINT preference_pairwise_offers_v2_hash_check CHECK (
        
  length(offer_id) = 82
  AND substr(offer_id, 1, 18) = 'pairwise-offer-v2:'
  AND substr(offer_id, 19) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(candidate_set_hash) = 71
  AND substr(candidate_set_hash, 1, 7) = 'sha256:'
  AND substr(candidate_set_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(offer_payload_hash) = 71
  AND substr(offer_payload_hash, 1, 7) = 'sha256:'
  AND substr(offer_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'

      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_pairwise_offer_responses_v2 (
      offer_id TEXT PRIMARY KEY NOT NULL
        REFERENCES preference_pairwise_offers_v2(offer_id),
      schema_version TEXT NOT NULL,
      comparison_id TEXT NOT NULL UNIQUE
        REFERENCES preference_pairwise_comparisons_v2(comparison_id),
      responded_at TEXT NOT NULL,
      response_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_pairwise_offer_responses_v2_schema_check CHECK (
        schema_version = 'preference-pairwise-offer-response-v2'
      ),
      CONSTRAINT preference_pairwise_offer_responses_v2_time_check CHECK (
        julianday(responded_at) IS NOT NULL
        AND responded_at GLOB '????-??-??T??:??:??.???Z'
      ),
      CONSTRAINT preference_pairwise_offer_responses_v2_hash_check CHECK (
        
  length(response_payload_hash) = 71
  AND substr(response_payload_hash, 1, 7) = 'sha256:'
  AND substr(response_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'

      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_slate_candidate_explanations_v2 (
      explanation_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      slate_candidate_id TEXT NOT NULL UNIQUE
        REFERENCES review_slate_candidates(slate_candidate_id),
      slate_id TEXT NOT NULL REFERENCES review_slates(slate_id),
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      candidate_set_hash TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      explanation_text TEXT NOT NULL,
      explanation_text_hash TEXT NOT NULL,
      explanation_payload_json TEXT NOT NULL,
      explanation_payload_hash TEXT NOT NULL,
      fallback_used INTEGER NOT NULL,
      fallback_reason TEXT NOT NULL,
      fallback_model_version TEXT,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_slate_candidate_explanations_v2_schema_check CHECK (
        schema_version = 'preference-slate-candidate-explanation-v2'
      ),
      CONSTRAINT preference_slate_candidate_explanations_v2_text_check CHECK (
        length(trim(explanation_text)) BETWEEN 1 AND 4000
        AND explanation_text = trim(explanation_text)
        AND json_valid(explanation_payload_json)
        AND json_type(explanation_payload_json) = 'object'
        AND json(explanation_payload_json) = explanation_payload_json
      ),
      CONSTRAINT preference_slate_candidate_explanations_v2_fallback_check CHECK (
        (
          fallback_used = 0
          AND fallback_reason = 'not_used'
          AND fallback_model_version IS NULL
        )
        OR (
          fallback_used = 1
          AND fallback_reason IN (
            'learned_score_unavailable',
            'unfiltered_new_deterministic_policy'
          )
          AND length(trim(fallback_model_version)) BETWEEN 1 AND 200
        )
      ),
      CONSTRAINT preference_slate_candidate_explanations_v2_time_check CHECK (
        julianday(recorded_at) IS NOT NULL
        AND recorded_at GLOB '????-??-??T??:??:??.???Z'
      ),
      CONSTRAINT preference_slate_candidate_explanations_v2_snapshot_check CHECK (
        length(snapshot_id) = 82
        AND substr(snapshot_id, 1, 18) = 'preference-v2-pit:'
        AND substr(snapshot_id, 19) NOT GLOB '*[^0-9a-f]*'
      ),
      CONSTRAINT preference_slate_candidate_explanations_v2_hash_check CHECK (
        
  length(explanation_id) = 71
  AND substr(explanation_id, 1, 7) = 'sha256:'
  AND substr(explanation_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(candidate_set_hash) = 71
  AND substr(candidate_set_hash, 1, 7) = 'sha256:'
  AND substr(candidate_set_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(snapshot_hash) = 71
  AND substr(snapshot_hash, 1, 7) = 'sha256:'
  AND substr(snapshot_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(explanation_text_hash) = 71
  AND substr(explanation_text_hash, 1, 7) = 'sha256:'
  AND substr(explanation_text_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(explanation_payload_hash) = 71
  AND substr(explanation_payload_hash, 1, 7) = 'sha256:'
  AND substr(explanation_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'

      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_identity_import_staging_physical_v2 (
      receipt_id TEXT NOT NULL,
      accepted_physical_asset_cluster_id TEXT NOT NULL,
      runtime_physical_asset_cluster_id TEXT NOT NULL,
      cluster_version TEXT NOT NULL,
      manual_review_state TEXT NOT NULL,
      notes TEXT,
      source_record_hash TEXT NOT NULL,
      PRIMARY KEY (receipt_id, runtime_physical_asset_cluster_id),
      CONSTRAINT preference_identity_import_staging_physical_v2_id_check CHECK (
        
  length(receipt_id) = 71
  AND substr(receipt_id, 1, 7) = 'sha256:'
  AND substr(receipt_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(accepted_physical_asset_cluster_id) = 79
  AND substr(accepted_physical_asset_cluster_id, 1, 15) = 'physical-asset:'
  AND substr(accepted_physical_asset_cluster_id, 16) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(runtime_physical_asset_cluster_id) = 71
  AND substr(runtime_physical_asset_cluster_id, 1, 7) = 'sha256:'
  AND substr(runtime_physical_asset_cluster_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND substr(accepted_physical_asset_cluster_id, 16) =
          substr(runtime_physical_asset_cluster_id, 8)
        AND 
  length(source_record_hash) = 71
  AND substr(source_record_hash, 1, 7) = 'sha256:'
  AND substr(source_record_hash, 8) NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_staging_physical_v2_version_check CHECK (
        cluster_version = 'preference-v2-physical-asset-cluster-v1'
      ),
      CONSTRAINT preference_identity_import_staging_physical_v2_review_check CHECK (
        manual_review_state IN (
          'unreviewed', 'sampled_confirmed', 'sampled_false_merge',
          'manual_confirmed', 'manual_split_required'
        )
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_identity_import_staging_events_v2 (
      receipt_id TEXT NOT NULL,
      auction_event_block_id TEXT NOT NULL,
      block_version TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      authoritative_event_key TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      source_record_hash TEXT NOT NULL,
      PRIMARY KEY (receipt_id, auction_event_block_id),
      CONSTRAINT preference_identity_import_staging_events_v2_id_check CHECK (
        
  length(receipt_id) = 71
  AND substr(receipt_id, 1, 7) = 'sha256:'
  AND substr(receipt_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(auction_event_block_id) = 78
  AND substr(auction_event_block_id, 1, 14) = 'auction-event:'
  AND substr(auction_event_block_id, 15) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(source_record_hash) = 71
  AND substr(source_record_hash, 1, 7) = 'sha256:'
  AND substr(source_record_hash, 8) NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_staging_events_v2_version_check CHECK (
        block_version = 'preference-v2-source-authoritative-auction-event-v1'
      ),
      CONSTRAINT preference_identity_import_staging_events_v2_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_identity_import_staging_families_v2 (
      receipt_id TEXT NOT NULL,
      semantic_family_id TEXT NOT NULL,
      family_version TEXT NOT NULL,
      industry_domain TEXT NOT NULL,
      primary_asset_class TEXT NOT NULL,
      canonical_manufacturer TEXT NOT NULL,
      assignment_method TEXT NOT NULL,
      clustering_parameters_json TEXT NOT NULL,
      source_record_hash TEXT NOT NULL,
      PRIMARY KEY (receipt_id, semantic_family_id),
      CONSTRAINT preference_identity_import_staging_families_v2_id_check CHECK (
        
  length(receipt_id) = 71
  AND substr(receipt_id, 1, 7) = 'sha256:'
  AND substr(receipt_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(semantic_family_id) = 80
  AND substr(semantic_family_id, 1, 16) = 'semantic-family:'
  AND substr(semantic_family_id, 17) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(source_record_hash) = 71
  AND substr(source_record_hash, 1, 7) = 'sha256:'
  AND substr(source_record_hash, 8) NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_staging_families_v2_version_check CHECK (
        family_version = 'preference-v2-semantic-family-v1'
        AND assignment_method IN ('deterministic_key', 'embedding_fallback')
      ),
      CONSTRAINT preference_identity_import_staging_families_v2_parameters_check CHECK (
        json_valid(clustering_parameters_json)
        AND json_type(clustering_parameters_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_identity_import_staging_members_v2 (
      receipt_id TEXT NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      assignment_ordinal INTEGER NOT NULL,
      accepted_physical_asset_cluster_id TEXT NOT NULL,
      runtime_physical_asset_cluster_id TEXT NOT NULL,
      auction_event_block_id TEXT NOT NULL,
      semantic_family_id TEXT NOT NULL,
      physical_member_edge_reason TEXT NOT NULL,
      semantic_assignment_method TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      PRIMARY KEY (receipt_id, listing_id),
      UNIQUE (receipt_id, assignment_ordinal),
      CONSTRAINT preference_identity_import_staging_members_v2_ordinal_check CHECK (
        assignment_ordinal >= 1
      ),
      CONSTRAINT preference_identity_import_staging_members_v2_id_check CHECK (
        
  length(receipt_id) = 71
  AND substr(receipt_id, 1, 7) = 'sha256:'
  AND substr(receipt_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(accepted_physical_asset_cluster_id) = 79
  AND substr(accepted_physical_asset_cluster_id, 1, 15) = 'physical-asset:'
  AND substr(accepted_physical_asset_cluster_id, 16) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(runtime_physical_asset_cluster_id) = 71
  AND substr(runtime_physical_asset_cluster_id, 1, 7) = 'sha256:'
  AND substr(runtime_physical_asset_cluster_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND substr(accepted_physical_asset_cluster_id, 16) =
          substr(runtime_physical_asset_cluster_id, 8)
        AND 
  length(auction_event_block_id) = 78
  AND substr(auction_event_block_id, 1, 14) = 'auction-event:'
  AND substr(auction_event_block_id, 15) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(semantic_family_id) = 80
  AND substr(semantic_family_id, 1, 16) = 'semantic-family:'
  AND substr(semantic_family_id, 17) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(evidence_hash) = 71
  AND substr(evidence_hash, 1, 7) = 'sha256:'
  AND substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_staging_members_v2_method_check CHECK (
        physical_member_edge_reason IN ('singleton', 'manual_must_link')
        AND semantic_assignment_method IN (
          'deterministic_key', 'embedding_fallback'
        )
      ),
      CONSTRAINT preference_identity_import_staging_members_v2_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_identity_import_receipts_v2 (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      receipt_kind TEXT NOT NULL,
      parent_receipt_id TEXT
        REFERENCES preference_identity_import_receipts_v2(receipt_id),
      source_generation_identity TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      namespace_map_version TEXT NOT NULL,
      assignments_source_path TEXT NOT NULL,
      assignments_source_hash TEXT NOT NULL,
      physical_clusters_source_path TEXT NOT NULL,
      physical_clusters_source_hash TEXT NOT NULL,
      auction_event_blocks_source_path TEXT NOT NULL,
      auction_event_blocks_source_hash TEXT NOT NULL,
      semantic_families_source_path TEXT NOT NULL,
      semantic_families_source_hash TEXT NOT NULL,
      verified_manifest_file_count INTEGER NOT NULL,
      verified_manifest_byte_count INTEGER NOT NULL,
      assignment_count INTEGER NOT NULL,
      physical_cluster_count INTEGER NOT NULL,
      auction_event_block_count INTEGER NOT NULL,
      semantic_family_count INTEGER NOT NULL,
      physical_member_count INTEGER NOT NULL,
      auction_event_member_count INTEGER NOT NULL,
      semantic_family_member_count INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      receipt_payload_json TEXT NOT NULL,
      receipt_payload_hash TEXT NOT NULL,
      UNIQUE (source_generation_identity, manifest_hash),
      CONSTRAINT preference_identity_import_receipts_v2_schema_check CHECK (
        schema_version = 'preference-v2-identity-import-receipt-v1'
      ),
      CONSTRAINT preference_identity_import_receipts_v2_kind_check CHECK (
        receipt_kind IN ('accepted_generation', 'incremental_explicit')
        AND (
          (receipt_kind = 'accepted_generation' AND parent_receipt_id IS NULL)
          OR
          (receipt_kind = 'incremental_explicit' AND parent_receipt_id IS NOT NULL)
        )
      ),
      CONSTRAINT preference_identity_import_receipts_v2_generation_check CHECK (
        
  length(source_generation_identity) = 64
  AND source_generation_identity NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_receipts_v2_hash_check CHECK (
        
  length(receipt_id) = 71
  AND substr(receipt_id, 1, 7) = 'sha256:'
  AND substr(receipt_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(manifest_hash) = 71
  AND substr(manifest_hash, 1, 7) = 'sha256:'
  AND substr(manifest_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(assignments_source_hash) = 71
  AND substr(assignments_source_hash, 1, 7) = 'sha256:'
  AND substr(assignments_source_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(physical_clusters_source_hash) = 71
  AND substr(physical_clusters_source_hash, 1, 7) = 'sha256:'
  AND substr(physical_clusters_source_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(auction_event_blocks_source_hash) = 71
  AND substr(auction_event_blocks_source_hash, 1, 7) = 'sha256:'
  AND substr(auction_event_blocks_source_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(semantic_families_source_hash) = 71
  AND substr(semantic_families_source_hash, 1, 7) = 'sha256:'
  AND substr(semantic_families_source_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(receipt_payload_hash) = 71
  AND substr(receipt_payload_hash, 1, 7) = 'sha256:'
  AND substr(receipt_payload_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND receipt_id = receipt_payload_hash
      ),
      CONSTRAINT preference_identity_import_receipts_v2_map_check CHECK (
        namespace_map_version = 'preference-v2-runtime-identity-namespace-map-v1'
      ),
      CONSTRAINT preference_identity_import_receipts_v2_path_check CHECK (
        length(assignments_source_path) BETWEEN 1 AND 500
        AND assignments_source_path = trim(assignments_source_path)
        AND length(physical_clusters_source_path) BETWEEN 1 AND 500
        AND physical_clusters_source_path = trim(physical_clusters_source_path)
        AND length(auction_event_blocks_source_path) BETWEEN 1 AND 500
        AND auction_event_blocks_source_path = trim(auction_event_blocks_source_path)
        AND length(semantic_families_source_path) BETWEEN 1 AND 500
        AND semantic_families_source_path = trim(semantic_families_source_path)
      ),
      CONSTRAINT preference_identity_import_receipts_v2_count_check CHECK (
        verified_manifest_file_count >= 4
        AND verified_manifest_byte_count >= 1
        AND assignment_count >= 1
        AND physical_cluster_count BETWEEN 1 AND assignment_count
        AND auction_event_block_count BETWEEN 1 AND assignment_count
        AND semantic_family_count BETWEEN 1 AND assignment_count
        AND physical_member_count = assignment_count
        AND auction_event_member_count = assignment_count
        AND semantic_family_member_count = assignment_count
      ),
      CONSTRAINT preference_identity_import_receipts_v2_time_check CHECK (
        julianday(imported_at) IS NOT NULL
        AND imported_at GLOB '????-??-??T??:??:??.???Z'
      ),
      CONSTRAINT preference_identity_import_receipts_v2_payload_check CHECK (
        json_valid(receipt_payload_json)
        AND json_type(receipt_payload_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_identity_import_members_v2 (
      receipt_id TEXT NOT NULL,
      listing_id TEXT NOT NULL REFERENCES listing_stubs(id),
      assignment_ordinal INTEGER NOT NULL,
      receipt_kind TEXT NOT NULL,
      source_generation_identity TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      namespace_map_version TEXT NOT NULL,
      accepted_physical_asset_cluster_id TEXT NOT NULL,
      runtime_physical_asset_cluster_id TEXT NOT NULL,
      accepted_auction_event_block_id TEXT NOT NULL,
      runtime_auction_event_block_id TEXT NOT NULL,
      accepted_semantic_family_id TEXT NOT NULL,
      runtime_semantic_family_id TEXT NOT NULL,
      physical_algorithm_version TEXT NOT NULL,
      auction_event_algorithm_version TEXT NOT NULL,
      semantic_family_algorithm_version TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (receipt_id, listing_id),
      UNIQUE (receipt_id, assignment_ordinal),
      UNIQUE (listing_id),
      FOREIGN KEY (receipt_id)
        REFERENCES preference_identity_import_receipts_v2(receipt_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT preference_identity_import_members_v2_ordinal_check CHECK (
        assignment_ordinal >= 1
      ),
      CONSTRAINT preference_identity_import_members_v2_kind_check CHECK (
        receipt_kind IN ('accepted_generation', 'incremental_explicit')
      ),
      CONSTRAINT preference_identity_import_members_v2_generation_check CHECK (
        
  length(source_generation_identity) = 64
  AND source_generation_identity NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_members_v2_map_check CHECK (
        namespace_map_version = 'preference-v2-runtime-identity-namespace-map-v1'
        AND 
  length(accepted_physical_asset_cluster_id) = 79
  AND substr(accepted_physical_asset_cluster_id, 1, 15) = 'physical-asset:'
  AND substr(accepted_physical_asset_cluster_id, 16) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(runtime_physical_asset_cluster_id) = 71
  AND substr(runtime_physical_asset_cluster_id, 1, 7) = 'sha256:'
  AND substr(runtime_physical_asset_cluster_id, 8) NOT GLOB '*[^0-9a-f]*'

        AND substr(accepted_physical_asset_cluster_id, 16) =
          substr(runtime_physical_asset_cluster_id, 8)
        AND 
  length(accepted_auction_event_block_id) = 78
  AND substr(accepted_auction_event_block_id, 1, 14) = 'auction-event:'
  AND substr(accepted_auction_event_block_id, 15) NOT GLOB '*[^0-9a-f]*'

        AND runtime_auction_event_block_id = accepted_auction_event_block_id
        AND 
  length(accepted_semantic_family_id) = 80
  AND substr(accepted_semantic_family_id, 1, 16) = 'semantic-family:'
  AND substr(accepted_semantic_family_id, 17) NOT GLOB '*[^0-9a-f]*'

        AND runtime_semantic_family_id = accepted_semantic_family_id
      ),
      CONSTRAINT preference_identity_import_members_v2_version_check CHECK (
        physical_algorithm_version = 'preference-v2-physical-asset-cluster-v1'
        AND auction_event_algorithm_version =
          'preference-v2-source-authoritative-auction-event-v1'
        AND semantic_family_algorithm_version =
          'preference-v2-semantic-family-v1'
      ),
      CONSTRAINT preference_identity_import_members_v2_hash_check CHECK (
        
  length(manifest_hash) = 71
  AND substr(manifest_hash, 1, 7) = 'sha256:'
  AND substr(manifest_hash, 8) NOT GLOB '*[^0-9a-f]*'

        AND 
  length(evidence_hash) = 71
  AND substr(evidence_hash, 1, 7) = 'sha256:'
  AND substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'

      ),
      CONSTRAINT preference_identity_import_members_v2_evidence_check CHECK (
        json_valid(evidence_json) AND json_type(evidence_json) = 'object'
      )
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_generation_state (
      domain TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      fingerprint TEXT NOT NULL,
      derivation_version TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (domain, scope_type, scope_id),
      CONSTRAINT pipeline_generation_scope_type_check
        CHECK (scope_type IN ('listing', 'source', 'group', 'global')),
      CONSTRAINT pipeline_generation_value_check CHECK (generation >= 1),
      CONSTRAINT pipeline_generation_identity_check CHECK (
        length(domain) BETWEEN 1 AND 128
        AND length(scope_id) BETWEEN 1 AND 512
        AND length(fingerprint) BETWEEN 1 AND 512
        AND length(derivation_version) BETWEEN 1 AND 256
      )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_operational_ownership (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      actionable_owner_listing_id TEXT REFERENCES listing_stubs(id),
      actionable_owner_source_id TEXT REFERENCES auction_sources(id),
      owner_state TEXT NOT NULL,
      owner_basis TEXT NOT NULL,
      owner_proof_hash TEXT,
      shared_group_identity TEXT,
      upstream_tuple_identity TEXT,
      counterpart_state TEXT NOT NULL,
      counterpart_owner_listing_id TEXT REFERENCES listing_stubs(id),
      counterpart_owner_source_id TEXT REFERENCES auction_sources(id),
      counterpart_absence_proof_hash TEXT,
      ownership_input_hash TEXT NOT NULL,
      derivation_version TEXT NOT NULL,
      update_generation INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_operational_owner_state_check CHECK (
        owner_state IN (
          'native_primary', 'publisher_primary', 'shared_alias',
          'upstream_representative', 'unresolved', 'other'
        )
      ),
      CONSTRAINT listing_operational_counterpart_state_check CHECK (
        counterpart_state IN ('present', 'absent_with_complete_proof', 'unknown')
      ),
      CONSTRAINT listing_operational_owner_shape_check CHECK (
        (owner_state = 'unresolved'
          AND actionable_owner_listing_id IS NULL
          AND actionable_owner_source_id IS NULL)
        OR
        (owner_state <> 'unresolved'
          AND actionable_owner_listing_id IS NOT NULL
          AND actionable_owner_source_id IS NOT NULL)
      ),
      CONSTRAINT listing_operational_counterpart_shape_check CHECK (
        (counterpart_state = 'present'
          AND counterpart_owner_listing_id IS NOT NULL
          AND counterpart_owner_source_id IS NOT NULL)
        OR
        (counterpart_state = 'absent_with_complete_proof'
          AND counterpart_owner_listing_id IS NULL
          AND counterpart_owner_source_id IS NULL
          AND counterpart_absence_proof_hash IS NOT NULL)
        OR
        (counterpart_state = 'unknown'
          AND counterpart_owner_listing_id IS NULL
          AND counterpart_owner_source_id IS NULL)
      ),
      CONSTRAINT listing_operational_generation_check CHECK (update_generation >= 1)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_current_pipeline_state (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      source_current INTEGER NOT NULL DEFAULT 0,
      active_inventory_run_id TEXT REFERENCES discovery_runs(id),
      source_publication_generation INTEGER,
      source_coverage_mode TEXT,
      review_candidate INTEGER NOT NULL DEFAULT 0,
      category_scope TEXT,
      ownership_input_hash TEXT,
      accepted_detail_identity TEXT,
      accepted_detail_hash TEXT,
      effective_location_input_hash TEXT,
      route_cache_identity TEXT,
      route_assignment_identity TEXT,
      route_input_hash TEXT,
      route_terminal_identity TEXT,
      factual_supplement_state TEXT NOT NULL DEFAULT 'unknown',
      factual_supplement_input_hash TEXT,
      source_image_identity_hash TEXT,
      local_primary_state TEXT NOT NULL DEFAULT 'unknown',
      image_input_hash TEXT,
      enrichment_head_identity TEXT,
      enrichment_input_hash TEXT,
      score_head_identity TEXT,
      score_snapshot_identity TEXT,
      score_input_hash TEXT,
      source_release_input_hash TEXT,
      projection_work_input_hash TEXT,
      detail_work_input_hash TEXT,
      action_deadline_work_input_hash TEXT,
      owner_work_input_hash TEXT,
      factual_work_input_hash TEXT,
      image_work_input_hash TEXT,
      proximity_work_input_hash TEXT,
      enrichment_text_work_input_hash TEXT,
      enrichment_embedding_work_input_hash TEXT,
      preference_score_work_input_hash TEXT,
      source_release_work_input_hash TEXT,
      relevant_generation_vector_hash TEXT NOT NULL,
      projection_derivation_version TEXT NOT NULL,
      update_generation INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_current_boolean_check CHECK (
        source_current IN (0, 1) AND review_candidate IN (0, 1)
      ),
      CONSTRAINT listing_current_coverage_check CHECK (
        source_coverage_mode IS NULL
        OR source_coverage_mode IN ('complete_current', 'discovery_frontier')
      ),
      CONSTRAINT listing_current_factual_state_check CHECK (
        factual_supplement_state IN ('unknown', 'pending', 'ready', 'terminal', 'failed')
      ),
      CONSTRAINT listing_current_primary_state_check CHECK (
        local_primary_state IN ('unknown', 'deferred', 'pending', 'ready', 'terminal', 'failed')
      ),
      CONSTRAINT listing_current_generation_check CHECK (
        update_generation >= 1
        AND (source_publication_generation IS NULL OR source_publication_generation >= 1)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_work_items (
      stage TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      listing_id TEXT REFERENCES listing_stubs(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES auction_sources(id),
      subject_payload_json TEXT,
      lane_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      reason_code TEXT NOT NULL,
      available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      input_attempt_count INTEGER NOT NULL DEFAULT 0,
      lifetime_attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      claimed_input_hash TEXT,
      claimed_revision INTEGER,
      progress_cursor TEXT,
      progress_generation INTEGER,
      progress_rows INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_claimed_at TEXT,
      last_completed_at TEXT,
      PRIMARY KEY (stage, subject_type, subject_id),
      CONSTRAINT pipeline_work_stage_check CHECK (
        stage IN (
          'projection_listing_refresh', 'projection_source_refresh',
          'projection_group_refresh', 'projection_global_refresh',
          'detail', 'action_deadline', 'owner_refresh',
          'factual_supplement', 'image_evidence', 'primary_image',
          'proximity', 'enrichment_text', 'enrichment_embedding',
          'preference_v2_score', 'source_release',
          'source_acquisition_readiness'
        )
      ),
      CONSTRAINT pipeline_work_subject_type_check
        CHECK (subject_type IN ('listing', 'source', 'group', 'global')),
      CONSTRAINT pipeline_work_subject_shape_check CHECK (
        (subject_type = 'listing' AND listing_id = subject_id)
        OR (subject_type = 'source' AND source_id = subject_id AND listing_id IS NULL)
        OR (subject_type = 'group' AND listing_id IS NULL)
        OR (subject_type = 'global' AND listing_id IS NULL AND source_id IS NULL)
      ),
      CONSTRAINT pipeline_work_payload_check CHECK (
        subject_payload_json IS NULL
        OR (
          length(subject_payload_json) <= 16384
          AND json_valid(subject_payload_json)
          AND json_type(subject_payload_json) IN ('object', 'array')
        )
      ),
      CONSTRAINT pipeline_work_revision_check CHECK (
        revision >= 1
        AND input_attempt_count >= 0
        AND lifetime_attempt_count >= input_attempt_count
        AND progress_rows >= 0
        AND (progress_generation IS NULL OR progress_generation >= 1)
      ),
      CONSTRAINT pipeline_work_claim_check CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL
          AND claimed_input_hash IS NULL AND claimed_revision IS NULL)
        OR
        (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
          AND claimed_input_hash IS NOT NULL AND claimed_revision IS NOT NULL
          AND claimed_revision >= 1)
      ),
      CONSTRAINT pipeline_work_error_detail_check CHECK (
        last_error_fingerprint IS NULL OR length(last_error_fingerprint) <= 512
      )
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_rebuild_state (
      rebuild_id TEXT PRIMARY KEY NOT NULL,
      domain TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      state TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      derivation_version TEXT NOT NULL,
      target_generation_vector_json TEXT NOT NULL,
      target_generation_vector_hash TEXT NOT NULL,
      ending_generation_vector_json TEXT,
      ending_generation_vector_hash TEXT,
      cursor_listing_id TEXT,
      rows_processed INTEGER NOT NULL DEFAULT 0,
      batches_processed INTEGER NOT NULL DEFAULT 0,
      copied_database_identity TEXT,
      error_code TEXT,
      error_fingerprint TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      CONSTRAINT pipeline_rebuild_scope_check
        CHECK (scope_type IN ('listing', 'source', 'group', 'global')),
      CONSTRAINT pipeline_rebuild_state_check
        CHECK (state IN ('pending', 'running', 'completed', 'superseded', 'failed')),
      CONSTRAINT pipeline_rebuild_json_check CHECK (
        json_valid(target_generation_vector_json)
        AND json_type(target_generation_vector_json) IN ('object', 'array')
        AND (ending_generation_vector_json IS NULL
          OR (json_valid(ending_generation_vector_json)
            AND json_type(ending_generation_vector_json) IN ('object', 'array')))
      ),
      CONSTRAINT pipeline_rebuild_count_check CHECK (
        schema_version >= 39 AND rows_processed >= 0 AND batches_processed >= 0
      )
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_audit_receipts (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      receipt_kind TEXT NOT NULL,
      feature_name TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      derivation_version TEXT NOT NULL,
      before_generation_vector_hash TEXT NOT NULL,
      after_generation_vector_hash TEXT NOT NULL,
      canonical_count INTEGER NOT NULL,
      canonical_ordered_hash TEXT NOT NULL,
      projection_count INTEGER NOT NULL,
      projection_ordered_hash TEXT NOT NULL,
      queue_count INTEGER NOT NULL,
      queue_ordered_hash TEXT NOT NULL,
      mismatch_count INTEGER NOT NULL,
      differing_ids_hash TEXT,
      copied_database_identity TEXT,
      shadow_pass_count INTEGER NOT NULL DEFAULT 0,
      readiness_granted INTEGER NOT NULL DEFAULT 0,
      prior_receipt_id TEXT REFERENCES pipeline_audit_receipts(receipt_id),
      completed_at TEXT NOT NULL,
      CONSTRAINT pipeline_audit_kind_check CHECK (
        receipt_kind IN ('rebuild', 'full_audit', 'shadow_pass', 'readiness', 'mismatch')
      ),
      CONSTRAINT pipeline_audit_count_check CHECK (
        schema_version >= 39
        AND canonical_count >= 0
        AND projection_count >= 0
        AND queue_count >= 0
        AND mismatch_count >= 0
        AND shadow_pass_count >= 0
        AND readiness_granted IN (0, 1)
      ),
      CONSTRAINT pipeline_audit_readiness_check CHECK (
        readiness_granted = 0
        OR (
          receipt_kind = 'readiness'
          AND mismatch_count = 0
          AND before_generation_vector_hash = after_generation_vector_hash
          AND canonical_count = projection_count
          AND canonical_ordered_hash = projection_ordered_hash
          AND shadow_pass_count >= 3
        )
      )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_enrichment_heads (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      provenance_target_identity TEXT NOT NULL,
      enrichment_input_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      extraction_artifact_id TEXT REFERENCES ai_artifacts(id),
      extraction_output_hash TEXT,
      semantic_artifact_id TEXT REFERENCES ai_artifacts(id),
      semantic_output_hash TEXT,
      embedding_id TEXT REFERENCES embeddings(id),
      embedding_input_hash TEXT,
      embedding_vector_hash TEXT,
      head_identity TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      derivation_version TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_enrichment_head_state_check CHECK (
        state IN ('pending_text', 'text_ready', 'pending_embedding', 'complete', 'terminal')
      ),
      CONSTRAINT listing_enrichment_head_shape_check CHECK (
        (state = 'pending_text'
          AND extraction_artifact_id IS NULL
          AND semantic_artifact_id IS NULL
          AND embedding_id IS NULL)
        OR
        (state IN ('text_ready', 'pending_embedding')
          AND extraction_artifact_id IS NOT NULL
          AND extraction_output_hash IS NOT NULL
          AND semantic_artifact_id IS NOT NULL
          AND semantic_output_hash IS NOT NULL
          AND embedding_id IS NULL)
        OR
        (state = 'complete'
          AND extraction_artifact_id IS NOT NULL
          AND extraction_output_hash IS NOT NULL
          AND semantic_artifact_id IS NOT NULL
          AND semantic_output_hash IS NOT NULL
          AND embedding_id IS NOT NULL
          AND embedding_input_hash IS NOT NULL
          AND embedding_vector_hash IS NOT NULL)
        OR state = 'terminal'
      ),
      CONSTRAINT listing_enrichment_generation_check CHECK (generation >= 1)
    )`,
  `CREATE TABLE IF NOT EXISTS listing_preference_score_heads (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      score_kind TEXT NOT NULL,
      deterministic_profile_version_id TEXT
        REFERENCES profile_versions(id),
      activation_event_identity TEXT
        REFERENCES preference_model_activation_events(event_identity),
      learned_score_row_identity TEXT
        REFERENCES learned_listing_scores(row_identity),
      snapshot_identity TEXT NOT NULL,
      scoring_input_hash TEXT NOT NULL,
      score_head_identity TEXT NOT NULL,
      score REAL NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      derivation_version TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_score_head_kind_check
        CHECK (score_kind IN ('deterministic', 'learned')),
      CONSTRAINT listing_score_head_shape_check CHECK (
        (score_kind = 'deterministic'
          AND deterministic_profile_version_id IS NOT NULL
          AND activation_event_identity IS NULL
          AND learned_score_row_identity IS NULL)
        OR
        (score_kind = 'learned'
          AND deterministic_profile_version_id IS NOT NULL
          AND activation_event_identity IS NOT NULL
          AND learned_score_row_identity IS NOT NULL)
      ),
      CONSTRAINT listing_score_head_value_check CHECK (
        score BETWEEN 0 AND 100 AND generation >= 1
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_v2_score_coverage_receipts (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      schema_identity TEXT NOT NULL,
      activation_event_identity TEXT
        REFERENCES preference_model_activation_events(event_identity),
      model_artifact_identity TEXT NOT NULL,
      model_configuration_identity TEXT NOT NULL,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      implementation_identity TEXT NOT NULL,
      runtime_identity TEXT NOT NULL,
      required_runtime_identities_json TEXT NOT NULL,
      profile_version_id TEXT NOT NULL REFERENCES profile_versions(id),
      profile_prior_hash TEXT NOT NULL,
      active_origin_cache_key TEXT NOT NULL,
      route_provider_name TEXT NOT NULL,
      route_estimator_version TEXT NOT NULL,
      route_normalization_version TEXT NOT NULL,
      route_dataset_identity TEXT NOT NULL,
      ownership_generation INTEGER NOT NULL,
      source_current_vector_hash TEXT NOT NULL,
      detail_location_generation INTEGER NOT NULL,
      enrichment_target_identity TEXT NOT NULL,
      enrichment_head_generation INTEGER NOT NULL,
      physical_asset_generation INTEGER NOT NULL,
      auction_event_generation INTEGER NOT NULL,
      semantic_family_generation INTEGER NOT NULL,
      vote_generation INTEGER NOT NULL,
      cohort_generation INTEGER NOT NULL,
      active_history_generation INTEGER NOT NULL,
      presentation_policy_generation INTEGER NOT NULL,
      generation_vector_json TEXT NOT NULL,
      generation_vector_hash TEXT NOT NULL,
      eligible_listing_count INTEGER NOT NULL,
      eligible_listing_ids_hash TEXT NOT NULL,
      score_coverage_count INTEGER NOT NULL,
      score_coverage_hash TEXT NOT NULL,
      score_head_count INTEGER NOT NULL,
      score_head_hash TEXT NOT NULL,
      score_queue_generation INTEGER NOT NULL,
      score_queue_hash TEXT NOT NULL,
      score_queue_empty INTEGER NOT NULL,
      database_boundary_before TEXT NOT NULL,
      database_boundary_after TEXT NOT NULL,
      data_version_before INTEGER,
      data_version_after INTEGER,
      prior_receipt_id TEXT
        REFERENCES preference_v2_score_coverage_receipts(receipt_id),
      completed_at TEXT NOT NULL,
      derivation_version TEXT NOT NULL,
      CONSTRAINT preference_v2_coverage_runtime_json_check CHECK (
        json_valid(required_runtime_identities_json)
        AND json_type(required_runtime_identities_json) = 'object'
      ),
      CONSTRAINT preference_v2_coverage_generation_json_check CHECK (
        json_valid(generation_vector_json)
        AND json_type(generation_vector_json) IN ('object', 'array')
      ),
      CONSTRAINT preference_v2_coverage_counts_check CHECK (
        ownership_generation >= 1
        AND detail_location_generation >= 1
        AND enrichment_head_generation >= 1
        AND physical_asset_generation >= 1
        AND auction_event_generation >= 1
        AND semantic_family_generation >= 1
        AND vote_generation >= 1
        AND cohort_generation >= 1
        AND active_history_generation >= 1
        AND presentation_policy_generation >= 1
        AND eligible_listing_count >= 0
        AND score_coverage_count = eligible_listing_count
        AND score_head_count = eligible_listing_count
        AND score_queue_generation >= 1
        AND score_queue_empty = 1
      ),
      CONSTRAINT preference_v2_coverage_boundary_check CHECK (
        database_boundary_before = database_boundary_after
      )
    )`,
  `CREATE TABLE IF NOT EXISTS preference_v2_score_coverage_head (
      singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
      receipt_id TEXT NOT NULL
        REFERENCES preference_v2_score_coverage_receipts(receipt_id),
      generation_vector_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT preference_v2_coverage_head_singleton_check CHECK (singleton = 1)
    )`,
  `CREATE TABLE IF NOT EXISTS source_review_release_proofs (
      proof_id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      coverage_mode TEXT NOT NULL,
      generation_vector_hash TEXT NOT NULL,
      release_input_hash TEXT NOT NULL,
      release_generation INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      prepared_count INTEGER NOT NULL,
      incomplete_count INTEGER NOT NULL,
      released_count INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      invalidation_reason_code TEXT,
      prior_proof_id TEXT REFERENCES source_review_release_proofs(proof_id),
      completed_at TEXT NOT NULL,
      derivation_version TEXT NOT NULL,
      CONSTRAINT source_release_proof_coverage_check
        CHECK (coverage_mode IN ('complete_current', 'discovery_frontier')),
      CONSTRAINT source_release_proof_outcome_check
        CHECK (outcome IN ('released', 'withheld', 'invalidated')),
      CONSTRAINT source_release_proof_counts_check CHECK (
        release_generation >= 1
        AND accepted_count >= 0
        AND prepared_count >= 0
        AND incomplete_count >= 0
        AND released_count >= 0
        AND prepared_count + incomplete_count = accepted_count
        AND (
          (outcome = 'released'
            AND incomplete_count = 0
            AND released_count = accepted_count)
          OR
          (outcome <> 'released' AND released_count = 0)
        )
      )
    )`,
  `CREATE TABLE IF NOT EXISTS source_review_release_state (
      source_id TEXT PRIMARY KEY NOT NULL REFERENCES auction_sources(id),
      coverage_mode TEXT NOT NULL,
      generation_vector_hash TEXT NOT NULL,
      release_input_hash TEXT NOT NULL,
      release_generation INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      prepared_count INTEGER NOT NULL DEFAULT 0,
      incomplete_count INTEGER NOT NULL DEFAULT 0,
      released_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      release_proof_id TEXT REFERENCES source_review_release_proofs(proof_id),
      cache_vector_hash TEXT NOT NULL,
      invalidation_reason_code TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT source_release_state_coverage_check
        CHECK (coverage_mode IN ('complete_current', 'discovery_frontier')),
      CONSTRAINT source_release_state_state_check
        CHECK (state IN ('dirty', 'withheld', 'released')),
      CONSTRAINT source_release_state_counts_check CHECK (
        release_generation >= 1
        AND accepted_count >= 0
        AND prepared_count >= 0
        AND incomplete_count >= 0
        AND released_count >= 0
        AND prepared_count + incomplete_count = accepted_count
        AND ((state = 'released' AND incomplete_count = 0
          AND released_count = accepted_count AND release_proof_id IS NOT NULL)
          OR (state <> 'released' AND released_count = 0))
      )
    )`,
  `CREATE TABLE IF NOT EXISTS source_access_state (
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      lane_key TEXT NOT NULL,
      state TEXT NOT NULL,
      reason_code TEXT,
      failure_fingerprint TEXT,
      next_eligible_at TEXT,
      last_observed_at TEXT,
      current_input_hash TEXT NOT NULL,
      current_input_revision INTEGER NOT NULL DEFAULT 1,
      current_input_attempt_count INTEGER NOT NULL DEFAULT 0,
      manual_reset_at TEXT,
      manual_reset_reason TEXT,
      manual_reset_actor TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (source_id, lane_key),
      CONSTRAINT source_access_state_check
        CHECK (state IN ('ready', 'cooldown', 'manual_reset_required')),
      CONSTRAINT source_access_shape_check CHECK (
        (state = 'ready' AND next_eligible_at IS NULL)
        OR (state = 'cooldown' AND next_eligible_at IS NOT NULL
          AND reason_code IS NOT NULL AND failure_fingerprint IS NOT NULL)
        OR (state = 'manual_reset_required' AND next_eligible_at IS NULL
          AND reason_code IS NOT NULL AND failure_fingerprint IS NOT NULL)
      ),
      CONSTRAINT source_access_attempt_check CHECK (
        current_input_revision >= 1 AND current_input_attempt_count >= 0
      ),
      CONSTRAINT source_access_manual_reason_check CHECK (
        manual_reset_reason IS NULL
        OR length(trim(manual_reset_reason)) BETWEEN 1 AND 512
      )
    )`,
  `CREATE TABLE IF NOT EXISTS source_acquisition_reservations (
      reservation_id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      request_role TEXT NOT NULL,
      request_identity TEXT NOT NULL,
      page_or_partition_identity TEXT,
      prior_checkpoint_identity TEXT,
      adapter_version TEXT NOT NULL,
      proof_version TEXT NOT NULL,
      lane_key TEXT NOT NULL,
      expected_generation INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      input_revision INTEGER NOT NULL,
      request_budget INTEGER NOT NULL,
      requests_consumed INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'reserved',
      failure_code TEXT,
      failure_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      acquired_at TEXT,
      committed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT source_acquisition_reservation_state_check CHECK (
        state IN ('reserved', 'acquired', 'committed', 'stale', 'failed', 'expired')
      ),
      CONSTRAINT source_acquisition_reservation_count_check CHECK (
        expected_generation >= 1
        AND input_revision >= 1
        AND request_budget BETWEEN 1 AND 10000
        AND requests_consumed BETWEEN 0 AND request_budget
      ),
      CONSTRAINT source_acquisition_reservation_terminal_check CHECK (
        (state = 'acquired' AND acquired_at IS NOT NULL)
        OR (state = 'committed' AND acquired_at IS NOT NULL AND committed_at IS NOT NULL)
        OR state IN ('reserved', 'stale', 'failed', 'expired')
      )
    )`,
  `CREATE TABLE IF NOT EXISTS source_acquired_bundles (
      bundle_identity TEXT PRIMARY KEY NOT NULL,
      reservation_id TEXT NOT NULL
        REFERENCES source_acquisition_reservations(reservation_id),
      source_id TEXT NOT NULL REFERENCES auction_sources(id),
      request_identity TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content_encoding TEXT,
      byte_length INTEGER NOT NULL,
      body_storage_key TEXT,
      parser_version TEXT NOT NULL,
      validation_version TEXT NOT NULL,
      validated_metadata_json TEXT NOT NULL,
      state TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      validated_at TEXT,
      committed_at TEXT,
      discarded_at TEXT,
      CONSTRAINT source_acquired_bundle_state_check CHECK (
        state IN ('acquired', 'validated', 'committed', 'discarded')
      ),
      CONSTRAINT source_acquired_bundle_size_check CHECK (
        byte_length BETWEEN 0 AND 268435456
      ),
      CONSTRAINT source_acquired_bundle_metadata_check CHECK (
        length(validated_metadata_json) <= 65536
        AND json_valid(validated_metadata_json)
        AND json_type(validated_metadata_json) = 'object'
      ),
      CONSTRAINT source_acquired_bundle_timestamps_check CHECK (
        (state = 'acquired')
        OR (state = 'validated' AND validated_at IS NOT NULL)
        OR (state = 'committed' AND validated_at IS NOT NULL AND committed_at IS NOT NULL)
        OR (state = 'discarded' AND discarded_at IS NOT NULL)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS image_content_blobs (
      content_hash TEXT PRIMARY KEY NOT NULL,
      hash_algorithm TEXT NOT NULL DEFAULT 'sha256',
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      validation_version TEXT NOT NULL,
      validation_hash TEXT NOT NULL,
      pixel_width INTEGER,
      pixel_height INTEGER,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      first_acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT,
      CONSTRAINT image_content_blob_hash_check CHECK (
        hash_algorithm = 'sha256'
        AND length(content_hash) = 71
        AND substr(content_hash, 1, 7) = 'sha256:'
        AND substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      CONSTRAINT image_content_blob_mime_check CHECK (
        mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif')
      ),
      CONSTRAINT image_content_blob_size_check CHECK (
        byte_length BETWEEN 1 AND 52428800
        AND (pixel_width IS NULL OR pixel_width >= 1)
        AND (pixel_height IS NULL OR pixel_height >= 1)
      ),
      CONSTRAINT image_content_blob_state_check CHECK (
        lifecycle_state IN ('active', 'missing', 'deleted')
        AND ((lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
          OR (lifecycle_state <> 'deleted' AND deleted_at IS NULL))
      )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_image_content_links (
      link_identity TEXT PRIMARY KEY NOT NULL,
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      listing_image_id TEXT NOT NULL
        REFERENCES listing_images(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL
        REFERENCES image_content_blobs(content_hash),
      source_image_identity_hash TEXT NOT NULL,
      source_position INTEGER NOT NULL,
      representative_primary INTEGER NOT NULL DEFAULT 0,
      acquisition_method TEXT NOT NULL,
      acquisition_provenance_hash TEXT NOT NULL,
      source_input_hash TEXT NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_image_content_position_check CHECK (source_position >= 0),
      CONSTRAINT listing_image_content_primary_check CHECK (representative_primary IN (0, 1)),
      CONSTRAINT listing_image_content_method_check CHECK (
        acquisition_method IN ('browser', 'direct', 'resolved_endpoint', 'content_reuse')
      )
    )`,
  `CREATE TABLE IF NOT EXISTS listing_image_content_heads (
      listing_image_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_images(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      link_identity TEXT NOT NULL
        REFERENCES listing_image_content_links(link_identity),
      content_hash TEXT NOT NULL
        REFERENCES image_content_blobs(content_hash),
      source_input_hash TEXT NOT NULL,
      representative_primary INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CONSTRAINT listing_image_content_head_primary_check
        CHECK (representative_primary IN (0, 1)),
      CONSTRAINT listing_image_content_head_generation_check CHECK (generation >= 1)
    )`,
  `CREATE TABLE IF NOT EXISTS preference_v2_active_score_heads (
      listing_id TEXT PRIMARY KEY NOT NULL
        REFERENCES listing_stubs(id) ON DELETE CASCADE,
      shadow_score_id TEXT NOT NULL UNIQUE,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      runtime_identity TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      scoring_input_hash TEXT NOT NULL,
      baseline_score REAL NOT NULL,
      intrinsic_score REAL NOT NULL,
      observed_preference_score REAL NOT NULL,
      actionability_score REAL NOT NULL,
      investigation_score REAL NOT NULL,
      final_score REAL NOT NULL,
      uncertainty REAL NOT NULL,
      generation_vector_hash TEXT NOT NULL,
      database_boundary TEXT NOT NULL,
      data_version INTEGER NOT NULL,
      head_identity TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      derivation_version TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (shadow_score_id, listing_id)
        REFERENCES preference_shadow_scores_v2(shadow_score_id, listing_id),
      CONSTRAINT preference_v2_active_head_score_check CHECK (
        baseline_score BETWEEN 0 AND 1
        AND intrinsic_score BETWEEN 0 AND 1
        AND observed_preference_score BETWEEN 0 AND 1
        AND actionability_score BETWEEN 0 AND 1
        AND investigation_score BETWEEN 0 AND 1
        AND final_score BETWEEN 0 AND 1
        AND uncertainty BETWEEN 0 AND 1
      ),
      CONSTRAINT preference_v2_active_head_hash_check CHECK (
        length(snapshot_hash) = 71
        AND substr(snapshot_hash, 1, 7) = 'sha256:'
        AND snapshot_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(scoring_input_hash) = 71
        AND substr(scoring_input_hash, 1, 7) = 'sha256:'
        AND scoring_input_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(generation_vector_hash) = 71
        AND substr(generation_vector_hash, 1, 7) = 'sha256:'
        AND generation_vector_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(head_identity) = 71
        AND substr(head_identity, 1, 7) = 'sha256:'
        AND head_identity NOT GLOB 'sha256:*[^0-9a-f]*'
      ),
      CONSTRAINT preference_v2_active_head_boundary_check CHECK (
        length(trim(model_version)) BETWEEN 1 AND 256
        AND length(trim(feature_version)) BETWEEN 1 AND 256
        AND length(trim(runtime_identity)) BETWEEN 1 AND 512
        AND length(trim(snapshot_id)) BETWEEN 1 AND 512
        AND length(trim(database_boundary)) BETWEEN 1 AND 512
        AND data_version >= 0
        AND generation >= 1
      )
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_component_execution_links (
      link_identity TEXT PRIMARY KEY NOT NULL,
      component_name TEXT NOT NULL,
      shadow_receipt_id TEXT NOT NULL
        REFERENCES pipeline_audit_receipts(receipt_id),
      execution_receipt_id TEXT NOT NULL
        REFERENCES pipeline_execution_evidence(execution_receipt_id),
      derivation_version TEXT NOT NULL,
      generation_vector_hash TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      CONSTRAINT pipeline_component_execution_component_check CHECK (
        component_name IN (
          'preparationScheduler',
          'unifiedSourceScheduler'
        )
      ),
      CONSTRAINT pipeline_component_execution_hash_check CHECK (
        length(generation_vector_hash) = 71
        AND substr(generation_vector_hash, 1, 7) = 'sha256:'
        AND generation_vector_hash NOT GLOB 'sha256:*[^0-9a-f]*'
      ),
      CONSTRAINT pipeline_component_execution_identity_check CHECK (
        length(trim(link_identity)) BETWEEN 1 AND 128
        AND length(trim(derivation_version)) BETWEEN 1 AND 256
      )
    )`,
  `CREATE TABLE IF NOT EXISTS enrichment_runs (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      origin_postal_code TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      requested_limit INTEGER NOT NULL,
      effective_limit INTEGER NOT NULL,
      pending_at_start INTEGER NOT NULL DEFAULT 0,
      attempted INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      remaining INTEGER NOT NULL DEFAULT 0,
      text_provider_name TEXT NOT NULL,
      text_model_name TEXT NOT NULL,
      extraction_prompt_version TEXT NOT NULL,
      semantic_document_version TEXT NOT NULL,
      embedding_provider_name TEXT NOT NULL,
      embedding_model_name TEXT NOT NULL,
      profile_votes_used INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      CONSTRAINT enrichment_runs_status_check
        CHECK (status IN ('running', 'completed', 'partial', 'failed', 'stopped')),
      CONSTRAINT enrichment_runs_limits_check
        CHECK (requested_limit BETWEEN 0 AND 10 AND effective_limit BETWEEN 0 AND 10),
      CONSTRAINT enrichment_runs_counts_check
        CHECK (
          pending_at_start >= 0 AND attempted >= 0 AND completed_count >= 0
          AND failures >= 0 AND remaining >= 0 AND profile_votes_used >= 0
          AND completed_count <= attempted AND failures <= 1
        )
    )`,
  `CREATE TABLE IF NOT EXISTS pipeline_execution_evidence (
      execution_receipt_id TEXT PRIMARY KEY NOT NULL,
      evidence_kind TEXT NOT NULL,
      evidence_schema_version TEXT NOT NULL,
      derivation_version TEXT NOT NULL,
      evidence_identity_hash TEXT NOT NULL,
      execution_identity_hash TEXT NOT NULL UNIQUE,
      invocation_identity_hash TEXT NOT NULL,
      input_generation_vector_hash TEXT NOT NULL,
      input_boundary_hash TEXT NOT NULL,
      output_boundary_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      CONSTRAINT pipeline_execution_evidence_kind_check CHECK (
        evidence_kind IN (
          'unified_source_scheduler',
          'preparation_scheduler'
        )
      ),
      CONSTRAINT pipeline_execution_evidence_schema_check CHECK (
        evidence_schema_version =
          'auction-discovery-runtime-execution-evidence-v2'
      ),
      CONSTRAINT pipeline_execution_evidence_hash_check CHECK (
        length(evidence_identity_hash) = 71
        AND substr(evidence_identity_hash, 1, 7) = 'sha256:'
        AND evidence_identity_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(execution_identity_hash) = 71
        AND substr(execution_identity_hash, 1, 7) = 'sha256:'
        AND execution_identity_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(invocation_identity_hash) = 71
        AND substr(invocation_identity_hash, 1, 7) = 'sha256:'
        AND invocation_identity_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(input_generation_vector_hash) = 71
        AND substr(input_generation_vector_hash, 1, 7) = 'sha256:'
        AND input_generation_vector_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(input_boundary_hash) = 71
        AND substr(input_boundary_hash, 1, 7) = 'sha256:'
        AND input_boundary_hash NOT GLOB 'sha256:*[^0-9a-f]*'
        AND length(output_boundary_hash) = 71
        AND substr(output_boundary_hash, 1, 7) = 'sha256:'
        AND output_boundary_hash NOT GLOB 'sha256:*[^0-9a-f]*'
      ),
      CONSTRAINT pipeline_execution_evidence_json_check CHECK (
        json_valid(evidence_json)
        AND json_type(evidence_json) = 'object'
        AND length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 65536
      ),
      CONSTRAINT pipeline_execution_evidence_identity_check CHECK (
        length(trim(execution_receipt_id)) BETWEEN 1 AND 128
        AND length(trim(derivation_version)) BETWEEN 1 AND 256
      )
    )`,
  `CREATE INDEX IF NOT EXISTS discovery_runs_started_at_idx ON discovery_runs (started_at)`,
  `CREATE INDEX IF NOT EXISTS discovery_runs_status_idx ON discovery_runs (status)`,
  `CREATE INDEX IF NOT EXISTS source_runs_status_idx ON source_runs (status)`,
  `CREATE INDEX IF NOT EXISTS listing_stubs_discovered_at_idx ON listing_stubs (discovered_at)`,
  `CREATE INDEX IF NOT EXISTS listing_stubs_content_hash_idx ON listing_stubs (content_hash)`,
  `CREATE INDEX IF NOT EXISTS source_current_listings_source_idx ON source_current_listings (source_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS source_inventory_observations_source_run_idx ON source_inventory_observations (source_id, run_id)`,
  `CREATE INDEX IF NOT EXISTS listing_details_ends_at_idx ON listing_details (auction_ends_at)`,
  `CREATE INDEX IF NOT EXISTS listing_details_pickup_postal_idx ON listing_details (pickup_postal_code)`,
  `CREATE INDEX IF NOT EXISTS locations_postal_code_idx ON locations (postal_code)`,
  `CREATE INDEX IF NOT EXISTS route_cache_bucket_idx ON route_cache (drive_bucket)`,
  `CREATE INDEX IF NOT EXISTS listing_votes_value_idx ON listing_votes (value)`,
  `CREATE INDEX IF NOT EXISTS ai_artifacts_subject_idx ON ai_artifacts (subject_type, subject_id)`,
  `CREATE INDEX IF NOT EXISTS embeddings_subject_idx ON embeddings (subject_type, subject_id)`,
  `CREATE INDEX IF NOT EXISTS listing_scores_score_idx ON listing_scores (score)`,
  `CREATE INDEX IF NOT EXISTS listing_images_repair_queue_idx ON listing_images (is_primary, download_status, attempt_count, last_attempted_at)`,
  `CREATE INDEX IF NOT EXISTS listing_lot_feedback_history_idx ON listing_lot_feedback (listing_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS profile_signal_feedback_history_idx ON profile_signal_feedback (profile_id, polarity, normalized_concept, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS profile_version_signal_feedback_feedback_idx ON profile_version_signal_feedback (feedback_id)`,
  `CREATE INDEX IF NOT EXISTS listing_recovery_status_queue_idx
    ON listing_recovery_status (origin_cache_key, state, last_attempted_at)`,
  `CREATE INDEX IF NOT EXISTS ai_artifacts_provenance_idx ON ai_artifacts (subject_type, subject_id, task, provider_name, model_name, prompt_version, input_hash, generated_at)`,
  `CREATE INDEX IF NOT EXISTS embeddings_provenance_idx ON embeddings (subject_type, subject_id, kind, provider_name, model_name, input_hash, generated_at)`,
  `CREATE INDEX IF NOT EXISTS source_inventory_publications_run_idx
    ON source_inventory_publications (inventory_run_id)`,
  `CREATE INDEX IF NOT EXISTS listing_upstream_provenance_identity_idx
    ON listing_upstream_provenance (
      platform, host, event_or_catalog_id, lot_id
    )`,
  `CREATE INDEX IF NOT EXISTS listing_upstream_alias_observations_identity_idx
    ON listing_upstream_alias_observations (
      platform, host, event_or_catalog_id, lot_id
    )`,
  `CREATE INDEX IF NOT EXISTS source_origin_priority_observations_lookup_idx
    ON source_origin_priority_observations (
      source_id, origin_cache_key, observed_at, listing_id
    )`,
  `CREATE INDEX IF NOT EXISTS learned_listing_scores_active_listing_idx
    ON learned_listing_scores (
      activation_event_identity, listing_id, scored_at, row_identity
    )`,
  `CREATE INDEX IF NOT EXISTS adhoc_review_cohort_sources_run_idx
    ON adhoc_review_cohort_sources (cohort_id, inventory_run_id)`,
  `CREATE INDEX IF NOT EXISTS adhoc_review_cohort_memberships_source_idx
    ON adhoc_review_cohort_memberships (cohort_id, source_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS physical_asset_cluster_edges_cluster_idx
    ON physical_asset_cluster_edges (
      physical_asset_cluster_id, left_listing_id, right_listing_id
    )`,
  `CREATE INDEX IF NOT EXISTS physical_asset_cluster_members_listing_idx
    ON physical_asset_cluster_members (listing_id, algorithm_version)`,
  `CREATE INDEX IF NOT EXISTS auction_event_block_members_listing_idx
    ON auction_event_block_members (listing_id, algorithm_version)`,
  `CREATE INDEX IF NOT EXISTS semantic_family_members_listing_idx
    ON semantic_family_members (listing_id, algorithm_version)`,
  `CREATE INDEX IF NOT EXISTS preference_feature_snapshots_listing_label_idx
    ON preference_feature_snapshots (listing_id, label_timestamp, snapshot_id)`,
  `CREATE INDEX IF NOT EXISTS preference_historical_examples_cluster_idx
    ON preference_historical_examples (
      physical_asset_cluster_id, vote_updated_at, listing_id
    )`,
  `CREATE INDEX IF NOT EXISTS preference_interaction_events_v2_impression_idx
    ON preference_interaction_events_v2 (
      impression_id, server_sequence, interaction_type
    )`,
  `CREATE INDEX IF NOT EXISTS preference_pairwise_offers_v2_cadence_idx
    ON preference_pairwise_offers_v2 (cadence_receipt_id, offered_at)`,
  `CREATE INDEX IF NOT EXISTS preference_identity_import_members_v2_receipt_idx
    ON preference_identity_import_members_v2 (receipt_id, assignment_ordinal)`,
  `CREATE INDEX IF NOT EXISTS pipeline_generation_scope_idx
    ON pipeline_generation_state (scope_type, scope_id, domain)`,
  `CREATE INDEX IF NOT EXISTS listing_operational_owner_idx
    ON listing_operational_ownership
      (actionable_owner_listing_id, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_operational_source_idx
    ON listing_operational_ownership (source_id, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_operational_group_idx
    ON listing_operational_ownership (shared_group_identity, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_operational_tuple_idx
    ON listing_operational_ownership (upstream_tuple_identity, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_current_source_idx
    ON listing_current_pipeline_state
      (source_id, source_current, review_candidate, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_current_source_fanout_idx
    ON listing_current_pipeline_state (source_id, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_current_proximity_idx
    ON listing_current_pipeline_state
      (source_current, proximity_work_input_hash, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_current_release_idx
    ON listing_current_pipeline_state
      (source_id, source_release_input_hash, listing_id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_work_ready_idx
    ON pipeline_work_items
      (stage, available_at, priority DESC, updated_at, subject_id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_work_lane_ready_idx
    ON pipeline_work_items
      (stage, lane_key, available_at, priority DESC, subject_id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_work_lease_expiry_idx
    ON pipeline_work_items (lease_expires_at, stage)`,
  `CREATE INDEX IF NOT EXISTS pipeline_work_source_idx
    ON pipeline_work_items (source_id, stage, subject_id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_work_listing_idx
    ON pipeline_work_items (listing_id, stage)`,
  `CREATE INDEX IF NOT EXISTS pipeline_rebuild_active_idx
    ON pipeline_rebuild_state (domain, scope_type, scope_id, state, updated_at)`,
  `CREATE INDEX IF NOT EXISTS pipeline_audit_feature_idx
    ON pipeline_audit_receipts
      (feature_name, readiness_granted, completed_at DESC, receipt_id)`,
  `CREATE INDEX IF NOT EXISTS listing_enrichment_state_idx
    ON listing_enrichment_heads (state, updated_at, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_enrichment_input_idx
    ON listing_enrichment_heads (enrichment_input_hash, listing_id)`,
  `CREATE INDEX IF NOT EXISTS listing_score_head_snapshot_idx
    ON listing_preference_score_heads
      (snapshot_identity, scoring_input_hash, listing_id)`,
  `CREATE INDEX IF NOT EXISTS preference_v2_coverage_completed_idx
    ON preference_v2_score_coverage_receipts
      (completed_at DESC, receipt_id)`,
  `CREATE INDEX IF NOT EXISTS source_release_proofs_source_idx
    ON source_review_release_proofs
      (source_id, release_generation DESC, completed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS source_release_dirty_idx
    ON source_review_release_state (state, updated_at, source_id)`,
  `CREATE INDEX IF NOT EXISTS source_access_eligibility_idx
    ON source_access_state (state, next_eligible_at, source_id, lane_key)`,
  `CREATE INDEX IF NOT EXISTS source_acquisition_ready_idx
    ON source_acquisition_reservations
      (state, expires_at, source_id, lane_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS source_acquisition_input_idx
    ON source_acquisition_reservations
      (source_id, request_role, input_hash, input_revision, created_at)`,
  `CREATE INDEX IF NOT EXISTS source_acquired_bundle_state_idx
    ON source_acquired_bundles (state, source_id, acquired_at)`,
  `CREATE INDEX IF NOT EXISTS image_content_lifecycle_idx
    ON image_content_blobs (lifecycle_state, last_verified_at, content_hash)`,
  `CREATE INDEX IF NOT EXISTS listing_image_content_listing_idx
    ON listing_image_content_links
      (listing_id, representative_primary DESC, source_position, link_identity)`,
  `CREATE INDEX IF NOT EXISTS listing_image_content_blob_idx
    ON listing_image_content_links (content_hash, listing_id, listing_image_id)`,
  `CREATE INDEX IF NOT EXISTS listing_image_content_head_listing_idx
    ON listing_image_content_heads
      (listing_id, representative_primary DESC, listing_image_id)`,
  `CREATE INDEX IF NOT EXISTS listing_image_content_head_blob_idx
    ON listing_image_content_heads (content_hash, listing_image_id)`,
  `CREATE INDEX IF NOT EXISTS preference_v2_active_head_contract_idx
    ON preference_v2_active_score_heads
      (model_version, feature_version, runtime_identity, listing_id)`,
  `CREATE INDEX IF NOT EXISTS preference_v2_active_head_snapshot_idx
    ON preference_v2_active_score_heads
      (snapshot_id, snapshot_hash, scoring_input_hash, listing_id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_execution_evidence_latest_idx
    ON pipeline_execution_evidence
      (evidence_kind, completed_at DESC, execution_receipt_id DESC)`,
  `CREATE INDEX IF NOT EXISTS pipeline_execution_evidence_derivation_idx
    ON pipeline_execution_evidence
      (evidence_kind, derivation_version, input_generation_vector_hash,
        completed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS pipeline_component_execution_shadow_idx
    ON pipeline_component_execution_links
      (shadow_receipt_id, component_name, execution_receipt_id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_component_execution_receipt_idx
    ON pipeline_component_execution_links
      (execution_receipt_id, component_name, shadow_receipt_id)`,
  `CREATE INDEX IF NOT EXISTS enrichment_runs_started_at_idx ON enrichment_runs (started_at)`,
  `CREATE INDEX IF NOT EXISTS enrichment_runs_status_idx ON enrichment_runs (status)`,
  `CREATE TRIGGER IF NOT EXISTS listing_details_immutable_update
    BEFORE UPDATE ON listing_details
    BEGIN
      SELECT RAISE(ABORT, 'listing_details rows are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_details_immutable_delete
    BEFORE DELETE ON listing_details
    BEGIN
      SELECT RAISE(ABORT, 'listing_details rows are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_stubs_immutable_update
    BEFORE UPDATE ON listing_stubs
    BEGIN
      SELECT RAISE(ABORT, 'listing stubs are immutable after first sighting');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_images_source_fields_immutable
    BEFORE UPDATE ON listing_images
    WHEN NEW.listing_id IS NOT OLD.listing_id
      OR NEW.position IS NOT OLD.position
      OR NEW.is_primary IS NOT OLD.is_primary
      OR NEW.source_url IS NOT OLD.source_url
      OR NEW.thumbnail_url IS NOT OLD.thumbnail_url
    BEGIN
      SELECT RAISE(ABORT, 'listing image source metadata is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS profile_versions_immutable_update
    BEFORE UPDATE ON profile_versions
    BEGIN
      SELECT RAISE(ABORT, 'profile versions are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS ai_artifacts_immutable_update
    BEFORE UPDATE ON ai_artifacts
    BEGIN
      SELECT RAISE(ABORT, 'AI artifacts are immutable provenance records');
    END`,
  `CREATE TRIGGER IF NOT EXISTS embeddings_immutable_update
    BEFORE UPDATE ON embeddings
    BEGIN
      SELECT RAISE(ABORT, 'embeddings are immutable provenance records');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_lot_feedback_immutable_update
    BEFORE UPDATE ON listing_lot_feedback
    BEGIN
      SELECT RAISE(ABORT, 'lot feedback is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_lot_feedback_immutable_delete
    BEFORE DELETE ON listing_lot_feedback
    BEGIN
      SELECT RAISE(ABORT, 'lot feedback is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS profile_signal_feedback_immutable_update
    BEFORE UPDATE ON profile_signal_feedback
    BEGIN
      SELECT RAISE(ABORT, 'profile signal feedback is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS profile_signal_feedback_immutable_delete
    BEFORE DELETE ON profile_signal_feedback
    BEGIN
      SELECT RAISE(ABORT, 'profile signal feedback is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS profile_version_signal_feedback_immutable_update
    BEFORE UPDATE ON profile_version_signal_feedback
    BEGIN
      SELECT RAISE(ABORT, 'profile signal feedback snapshots are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS profile_version_signal_feedback_immutable_delete
    BEFORE DELETE ON profile_version_signal_feedback
    BEGIN
      SELECT RAISE(ABORT, 'profile signal feedback snapshots are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_detail_observations_immutable_update
    BEFORE UPDATE ON listing_detail_observations
    BEGIN
      SELECT RAISE(ABORT, 'listing detail observations are immutable first-observed records');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_detail_observations_immutable_delete
    BEFORE DELETE ON listing_detail_observations
    BEGIN
      SELECT RAISE(ABORT, 'listing detail observations are immutable first-observed records');
    END`,
  `CREATE TRIGGER IF NOT EXISTS source_inventory_publications_immutable_update
    BEFORE UPDATE ON source_inventory_publications
    BEGIN
      SELECT RAISE(ABORT, 'source inventory publications are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS source_inventory_publications_immutable_delete
    BEFORE DELETE ON source_inventory_publications
    BEGIN
      SELECT RAISE(ABORT, 'source inventory publications are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_upstream_provenance_immutable_update
    BEFORE UPDATE ON listing_upstream_provenance
    BEGIN
      SELECT RAISE(ABORT, 'listing upstream provenance is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_upstream_provenance_immutable_delete
    BEFORE DELETE ON listing_upstream_provenance
    BEGIN
      SELECT RAISE(ABORT, 'listing upstream provenance is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_upstream_alias_observations_immutable_update
    BEFORE UPDATE ON listing_upstream_alias_observations
    BEGIN
      SELECT RAISE(ABORT, 'listing upstream alias observations are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_upstream_alias_observations_immutable_delete
    BEFORE DELETE ON listing_upstream_alias_observations
    BEGIN
      SELECT RAISE(ABORT, 'listing upstream alias observations are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS source_inventory_traversal_listings_fact_hash_guard
    BEFORE UPDATE OF fact_hash
    ON source_inventory_traversal_listings
    WHEN OLD.fact_hash IS NOT NULL
      AND (
        NEW.fact_hash IS NULL
        OR OLD.fact_hash <> NEW.fact_hash
      )
    BEGIN
      SELECT RAISE(
        ABORT,
        'source inventory traversal listing fact hash conflicts'
      );
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_action_deadlines_immutable_update
    BEFORE UPDATE ON listing_action_deadlines
    BEGIN
      SELECT RAISE(
        ABORT,
        'listing action deadlines are immutable first-observed records'
      );
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_action_deadlines_immutable_delete
    BEFORE DELETE ON listing_action_deadlines
    BEGIN
      SELECT RAISE(
        ABORT,
        'listing action deadlines are immutable first-observed records'
      );
    END`,
  `CREATE TRIGGER IF NOT EXISTS source_inventory_publications_conflict_guard
    BEFORE INSERT ON source_inventory_publications
    WHEN EXISTS (
      SELECT 1 FROM source_inventory_publications existing
      WHERE existing.source_id = NEW.source_id
        AND existing.inventory_run_id = NEW.inventory_run_id
        AND (
          existing.listing_count <> NEW.listing_count
          OR existing.collection_counts_json <> NEW.collection_counts_json
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'source inventory publication proof conflicts with immutable evidence');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_model_activation_chain_guard
    BEFORE INSERT ON preference_model_activation_events
    WHEN
      NEW.sequence <> COALESCE((
        SELECT MAX(sequence) FROM preference_model_activation_events
      ), 0) + 1
      OR (NEW.sequence = 1 AND NEW.previous_event_identity IS NOT NULL)
      OR (NEW.sequence > 1 AND NEW.previous_event_identity IS NOT (
        SELECT event_identity FROM preference_model_activation_events
        ORDER BY sequence DESC LIMIT 1
      ))
      OR (NOT EXISTS (SELECT 1 FROM preference_model_activation_events)
        AND NEW.event_type <> 'promote')
      OR EXISTS (
        SELECT 1 FROM preference_model_activation_events latest
        WHERE latest.sequence = (
          SELECT MAX(sequence) FROM preference_model_activation_events
        ) AND latest.event_type = NEW.event_type
      )
    BEGIN
      SELECT RAISE(ABORT, 'preference model activation chain is invalid');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_model_disable_evidence_guard
    BEFORE INSERT ON preference_model_activation_events
    WHEN NEW.event_type = 'disable' AND EXISTS (
      SELECT 1 FROM preference_model_activation_events previous
      WHERE previous.event_identity = NEW.previous_event_identity
        AND (
          previous.protocol_identity IS NOT NEW.protocol_identity
          OR previous.implementation_identity IS NOT NEW.implementation_identity
          OR previous.work_root_identity IS NOT NEW.work_root_identity
          OR previous.snapshot_evidence_identity IS NOT NEW.snapshot_evidence_identity
          OR previous.manifest_identity IS NOT NEW.manifest_identity
          OR previous.candidate_guard_identity IS NOT NEW.candidate_guard_identity
          OR previous.test_result_guard_identity IS NOT NEW.test_result_guard_identity
          OR previous.evaluation_result_identity IS NOT NEW.evaluation_result_identity
          OR previous.terminal_orchestration_receipt_identity IS NOT NEW.terminal_orchestration_receipt_identity
          OR previous.retrospective_shadow_result_identity IS NOT NEW.retrospective_shadow_result_identity
          OR previous.current_shadow_receipt_identity IS NOT NEW.current_shadow_receipt_identity
          OR previous.disabled_exercise_shadow_receipt_identity IS NOT NEW.disabled_exercise_shadow_receipt_identity
          OR previous.current_cohort_snapshot_identity IS NOT NEW.current_cohort_snapshot_identity
          OR previous.selected_family IS NOT NEW.selected_family
          OR previous.selected_configuration_id IS NOT NEW.selected_configuration_id
          OR previous.candidate_artifact_relative_path IS NOT NEW.candidate_artifact_relative_path
          OR previous.candidate_artifact_hash IS NOT NEW.candidate_artifact_hash
          OR previous.canonical_fitted_state_hash IS NOT NEW.canonical_fitted_state_hash
          OR previous.runtime_identity IS NOT NEW.runtime_identity
          OR previous.deterministic_profile_version_id IS NOT NEW.deterministic_profile_version_id
          OR previous.profile_prior_hash IS NOT NEW.profile_prior_hash
          OR previous.accepted_baseline_profile_identity IS NOT NEW.accepted_baseline_profile_identity
          OR previous.profile_feedback_snapshot_identity IS NOT NEW.profile_feedback_snapshot_identity
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'preference model disable changed promotion evidence');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_model_activation_immutable_update
    BEFORE UPDATE ON preference_model_activation_events
    BEGIN
      SELECT RAISE(ABORT, 'preference model activation events are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_model_activation_immutable_delete
    BEFORE DELETE ON preference_model_activation_events
    BEGIN
      SELECT RAISE(ABORT, 'preference model activation events are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS learned_listing_scores_active_event_guard
    BEFORE INSERT ON learned_listing_scores
    WHEN NOT EXISTS (
      SELECT 1 FROM preference_model_activation_events active
      WHERE active.event_identity = NEW.activation_event_identity
        AND active.sequence = (
          SELECT MAX(sequence) FROM preference_model_activation_events
        )
        AND active.event_type = 'promote'
        AND active.protocol_identity = NEW.protocol_identity
        AND active.implementation_identity = NEW.implementation_identity
        AND active.candidate_artifact_hash = NEW.candidate_artifact_hash
        AND active.evaluation_result_identity = NEW.evaluation_result_identity
        AND active.selected_family = NEW.selected_family
        AND active.selected_configuration_id = NEW.selected_configuration_id
        AND active.deterministic_profile_version_id =
          NEW.deterministic_profile_version_id
        AND active.profile_prior_hash = NEW.profile_prior_hash
        AND active.accepted_baseline_profile_identity =
          NEW.accepted_baseline_profile_identity
        AND active.profile_feedback_snapshot_identity =
          NEW.profile_feedback_snapshot_identity
    )
    BEGIN
      SELECT RAISE(ABORT, 'learned score does not bind the active promotion');
    END`,
  `CREATE TRIGGER IF NOT EXISTS learned_listing_scores_immutable_update
    BEFORE UPDATE ON learned_listing_scores
    BEGIN
      SELECT RAISE(ABORT, 'learned listing scores are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS learned_listing_scores_immutable_delete
    BEFORE DELETE ON learned_listing_scores
    BEGIN
      SELECT RAISE(ABORT, 'learned listing scores are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohort_sources_ready_guard
    BEFORE INSERT ON adhoc_review_cohort_sources
    WHEN EXISTS (
      SELECT 1 FROM adhoc_review_cohorts cohort
      WHERE cohort.id = NEW.cohort_id AND cohort.state = 'ready'
    )
    BEGIN
      SELECT RAISE(ABORT, 'ready ad hoc review cohort sources are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohort_memberships_ready_guard
    BEFORE INSERT ON adhoc_review_cohort_memberships
    WHEN EXISTS (
      SELECT 1 FROM adhoc_review_cohorts cohort
      WHERE cohort.id = NEW.cohort_id AND cohort.state = 'ready'
    )
    BEGIN
      SELECT RAISE(ABORT, 'ready ad hoc review cohort memberships are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohorts_update_guard
    BEFORE UPDATE ON adhoc_review_cohorts
    WHEN NOT (
      OLD.state = 'building'
      AND NEW.state = 'ready'
      AND OLD.id = NEW.id
      AND OLD.schema_version = NEW.schema_version
      AND OLD.refresh_boundary = NEW.refresh_boundary
      AND OLD.origin_cache_key = NEW.origin_cache_key
      AND OLD.route_provider_name = NEW.route_provider_name
      AND OLD.selection_seed = NEW.selection_seed
      AND OLD.selection_version = NEW.selection_version
      AND OLD.requested_target = NEW.requested_target
      AND OLD.source_count = NEW.source_count
      AND OLD.head_vector_hash = NEW.head_vector_hash
      AND OLD.base_cohort_id IS NEW.base_cohort_id
      AND OLD.created_at = NEW.created_at
      AND NEW.ready_at IS NOT NULL
      AND NEW.selected_count >= 1
      AND NEW.ordinary_accepted_count BETWEEN 0 AND NEW.selected_count
      AND NEW.distance_exempt_count =
        NEW.selected_count - NEW.ordinary_accepted_count
      AND NEW.selected_count = (
        SELECT count(*) FROM adhoc_review_cohort_memberships membership
        WHERE membership.cohort_id = OLD.id
      )
      AND NEW.source_count = (
        SELECT count(*) FROM adhoc_review_cohort_sources source
        WHERE source.cohort_id = OLD.id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'ad hoc review cohort mutation is invalid');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohorts_immutable_delete
    BEFORE DELETE ON adhoc_review_cohorts
    BEGIN
      SELECT RAISE(ABORT, 'ad hoc review cohorts are durable provenance');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohort_sources_immutable_change
    BEFORE UPDATE ON adhoc_review_cohort_sources
    BEGIN
      SELECT RAISE(ABORT, 'ad hoc review cohort sources are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohort_sources_immutable_delete
    BEFORE DELETE ON adhoc_review_cohort_sources
    BEGIN
      SELECT RAISE(ABORT, 'ad hoc review cohort sources are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohort_memberships_immutable_change
    BEFORE UPDATE ON adhoc_review_cohort_memberships
    BEGIN
      SELECT RAISE(ABORT, 'ad hoc review cohort memberships are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS adhoc_review_cohort_memberships_immutable_delete
    BEFORE DELETE ON adhoc_review_cohort_memberships
    BEGIN
      SELECT RAISE(ABORT, 'ad hoc review cohort memberships are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_edges_immutable_update
    BEFORE UPDATE ON physical_asset_cluster_edges
    BEGIN
      SELECT RAISE(ABORT, 'physical asset cluster edges are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_edges_immutable_delete
    BEFORE DELETE ON physical_asset_cluster_edges
    BEGIN
      SELECT RAISE(ABORT, 'physical asset cluster edges are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_members_immutable_update
    BEFORE UPDATE ON physical_asset_cluster_members
    BEGIN
      SELECT RAISE(ABORT, 'physical asset cluster members are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_members_immutable_delete
    BEFORE DELETE ON physical_asset_cluster_members
    BEGIN
      SELECT RAISE(ABORT, 'physical asset cluster members are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_overrides_immutable_update
    BEFORE UPDATE ON physical_asset_cluster_overrides
    BEGIN
      SELECT RAISE(ABORT, 'physical asset cluster overrides are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_overrides_immutable_delete
    BEFORE DELETE ON physical_asset_cluster_overrides
    BEGIN
      SELECT RAISE(ABORT, 'physical asset cluster overrides are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_blocks_immutable_update
    BEFORE UPDATE ON auction_event_blocks
    BEGIN
      SELECT RAISE(ABORT, 'auction event blocks are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_blocks_immutable_delete
    BEFORE DELETE ON auction_event_blocks
    BEGIN
      SELECT RAISE(ABORT, 'auction event blocks are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_block_members_immutable_update
    BEFORE UPDATE ON auction_event_block_members
    BEGIN
      SELECT RAISE(ABORT, 'auction event block members are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_block_members_immutable_delete
    BEFORE DELETE ON auction_event_block_members
    BEGIN
      SELECT RAISE(ABORT, 'auction event block members are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_families_immutable_update
    BEFORE UPDATE ON semantic_families
    BEGIN
      SELECT RAISE(ABORT, 'semantic families are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_families_immutable_delete
    BEFORE DELETE ON semantic_families
    BEGIN
      SELECT RAISE(ABORT, 'semantic families are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_family_members_immutable_update
    BEFORE UPDATE ON semantic_family_members
    BEGIN
      SELECT RAISE(ABORT, 'semantic family members are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_family_members_immutable_delete
    BEFORE DELETE ON semantic_family_members
    BEGIN
      SELECT RAISE(ABORT, 'semantic family members are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feature_snapshots_immutable_update
    BEFORE UPDATE ON preference_feature_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'preference feature snapshots are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feature_snapshots_immutable_delete
    BEFORE DELETE ON preference_feature_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'preference feature snapshots are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_historical_examples_immutable_update
    BEFORE UPDATE ON preference_historical_examples
    BEGIN
      SELECT RAISE(ABORT, 'preference historical examples are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_historical_examples_immutable_delete
    BEFORE DELETE ON preference_historical_examples
    BEGIN
      SELECT RAISE(ABORT, 'preference historical examples are append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_session_end_events_time_guard
    BEFORE INSERT ON review_session_end_events
    WHEN NOT EXISTS (
      SELECT 1 FROM review_sessions session
      WHERE session.session_id = NEW.session_id
        AND NEW.ended_at >= session.started_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'review session end precedes its start');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slates_session_time_guard
    BEFORE INSERT ON review_slates
    WHEN NOT EXISTS (
      SELECT 1 FROM review_sessions session
      LEFT JOIN review_session_end_events ending
        ON ending.session_id = session.session_id
      WHERE session.session_id = NEW.session_id
        AND NEW.generated_at >= session.started_at
        AND (ending.ended_at IS NULL OR NEW.generated_at <= ending.ended_at)
    )
    BEGIN
      SELECT RAISE(ABORT, 'review slate is outside its session');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slate_candidates_server_guard
    BEFORE INSERT ON review_slate_candidates
    WHEN NOT EXISTS (
      SELECT 1 FROM review_slates slate
      WHERE slate.slate_id = NEW.slate_id
        AND NEW.position <= slate.candidate_count
        AND NEW.candidate_set_hash = slate.candidate_set_hash
        AND NEW.model_version = slate.candidate_model_version
        AND NEW.feature_version = slate.candidate_feature_version
        AND NEW.displayed_snapshot_at <= slate.generated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'slate candidate disagrees with server-owned slate');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slate_freezes_completeness_guard
    BEFORE INSERT ON review_slate_freezes
    WHEN NOT EXISTS (
      SELECT 1 FROM review_slates slate
      WHERE slate.slate_id = NEW.slate_id
        AND NEW.candidate_set_hash = slate.candidate_set_hash
        AND NEW.observed_candidate_count = slate.candidate_count
        AND NEW.observed_candidate_count = (
          SELECT COUNT(*) FROM review_slate_candidates candidate
          WHERE candidate.slate_id = NEW.slate_id
        )
        AND NEW.frozen_at >= slate.generated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'review slate cannot freeze an incomplete candidate set');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_impressions_server_candidate_guard
    BEFORE INSERT ON listing_impressions
    WHEN NOT EXISTS (
      SELECT 1
      FROM review_slate_candidates candidate
      JOIN review_slate_freezes freeze ON freeze.slate_id = candidate.slate_id
      WHERE candidate.slate_candidate_id = NEW.slate_candidate_id
        AND candidate.slate_id = NEW.slate_id
        AND candidate.listing_id = NEW.listing_id
        AND candidate.physical_asset_cluster_id = NEW.physical_asset_cluster_id
        AND candidate.auction_event_block_id = NEW.auction_event_block_id
        AND candidate.semantic_family_id = NEW.semantic_family_id
        AND candidate.position = NEW.position
        AND candidate.candidate_set_hash = NEW.candidate_set_hash
        AND candidate.model_version = NEW.model_version
        AND candidate.feature_version = NEW.feature_version
        AND candidate.baseline_score IS NEW.baseline_score
        AND candidate.candidate_score IS NEW.candidate_score
        AND candidate.intrinsic_score IS NEW.intrinsic_score
        AND candidate.observed_preference_score IS NEW.observed_preference_score
        AND candidate.actionability_score IS NEW.actionability_score
        AND candidate.investigation_score IS NEW.investigation_score
        AND candidate.uncertainty_score IS NEW.uncertainty_score
        AND candidate.selection_probability IS NEW.selection_probability
        AND candidate.entry_reason = NEW.entry_reason
        AND candidate.exploration_bucket = NEW.exploration_bucket
        AND candidate.displayed_snapshot_id = NEW.displayed_snapshot_id
        AND candidate.displayed_snapshot_hash = NEW.displayed_snapshot_hash
        AND candidate.displayed_snapshot_at = NEW.displayed_snapshot_at
        AND candidate.displayed_price_amount_minor IS NEW.displayed_price_amount_minor
        AND candidate.displayed_price_currency IS NEW.displayed_price_currency
        AND candidate.displayed_location IS NEW.displayed_location
        AND candidate.displayed_condition IS NEW.displayed_condition
        AND candidate.displayed_time_remaining_seconds
          IS NEW.displayed_time_remaining_seconds
        AND candidate.displayed_auction_ends_at IS NEW.displayed_auction_ends_at
        AND candidate.displayed_facts_json = NEW.displayed_facts_json
    )
    BEGIN
      SELECT RAISE(ABORT, 'impression disagrees with the frozen server candidate');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feedback_v2_impression_guard
    BEFORE INSERT ON preference_feedback_v2
    WHEN NOT EXISTS (
      SELECT 1 FROM listing_impressions impression
      WHERE impression.impression_id = NEW.impression_id
        AND impression.listing_id = NEW.listing_id
        AND impression.displayed_snapshot_id = NEW.feature_snapshot_id
        AND impression.displayed_snapshot_hash = NEW.feature_snapshot_hash
        AND impression.model_version = NEW.model_version
        AND impression.feature_version = NEW.feature_version
        AND NEW.feedback_at >= impression.displayed_at
        AND (NEW.action_at IS NULL OR NEW.action_at >= impression.displayed_at)
    )
    BEGIN
      SELECT RAISE(ABORT, 'feedback disagrees with the actual displayed impression');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_comparisons_v2_slate_guard
    BEFORE INSERT ON preference_pairwise_comparisons_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM listing_impressions left_impression
      JOIN listing_impressions right_impression
        ON right_impression.slate_id = left_impression.slate_id
      WHERE left_impression.impression_id = NEW.left_impression_id
        AND right_impression.impression_id = NEW.right_impression_id
        AND left_impression.slate_id = NEW.slate_id
        AND left_impression.model_version = NEW.model_version
        AND right_impression.model_version = NEW.model_version
        AND left_impression.feature_version = NEW.feature_version
        AND right_impression.feature_version = NEW.feature_version
        AND NEW.comparison_at >= left_impression.displayed_at
        AND NEW.comparison_at >= right_impression.displayed_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'pairwise comparison requires two impressions from one slate');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_freezes_v2_registration_guard
    BEFORE INSERT ON preference_prospective_freezes_v2
    WHEN julianday(NEW.prospective_not_before) < julianday('now')
    BEGIN
      SELECT RAISE(ABORT, 'prospective freeze must be registered before evidence begins');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_assignments_v2_future_guard
    BEFORE INSERT ON preference_prospective_assignments_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM preference_prospective_freezes_v2 freeze
      JOIN review_slates slate ON slate.slate_id = NEW.slate_id
      JOIN review_sessions session ON session.session_id = slate.session_id
      WHERE freeze.freeze_id = NEW.freeze_id
        AND session.queue_name = 'best_matches'
        AND NEW.assigned_at >= freeze.prospective_not_before
        AND NEW.assigned_at <= slate.generated_at
        AND slate.generated_at >= freeze.prospective_not_before
        AND slate.baseline_model_version = freeze.baseline_model_version
        AND slate.baseline_feature_version = freeze.baseline_feature_version
        AND slate.candidate_model_version = freeze.candidate_model_version
        AND slate.candidate_feature_version = freeze.candidate_feature_version
    )
    BEGIN
      SELECT RAISE(ABORT, 'prospective assignment is not future freeze-bound team-draft evidence');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_evaluation_receipts_v2_gate
    BEFORE INSERT ON preference_prospective_evaluation_receipts_v2
    WHEN NOT EXISTS (
      SELECT 1 FROM preference_prospective_freezes_v2 freeze
      WHERE freeze.freeze_id = NEW.freeze_id
        AND NEW.evaluated_from >= freeze.prospective_not_before
        AND NEW.evaluated_through >= NEW.evaluated_from
        AND NEW.unique_physical_listings_reviewed <= (
          SELECT COUNT(DISTINCT impression.physical_asset_cluster_id)
          FROM preference_prospective_assignments_v2 assignment
          JOIN listing_impressions impression
            ON impression.slate_id = assignment.slate_id
          WHERE assignment.freeze_id = NEW.freeze_id
            AND impression.displayed_at >= NEW.evaluated_from
            AND impression.displayed_at <= NEW.evaluated_through
        )
        AND NEW.unique_positive_physical_clusters <= (
          SELECT COUNT(DISTINCT impression.physical_asset_cluster_id)
          FROM preference_prospective_assignments_v2 assignment
          JOIN listing_impressions impression
            ON impression.slate_id = assignment.slate_id
          JOIN preference_feedback_v2 feedback
            ON feedback.impression_id = impression.impression_id
          WHERE assignment.freeze_id = NEW.freeze_id
            AND feedback.feedback_state IN (
              'interesting_item_bad_listing', 'interesting_listing'
            )
            AND feedback.feedback_at >= NEW.evaluated_from
            AND feedback.feedback_at <= NEW.evaluated_through
        )
        AND NEW.completed_slates_of_25 <= (
          SELECT COUNT(*)
          FROM preference_prospective_assignments_v2 assignment
          JOIN review_slates slate ON slate.slate_id = assignment.slate_id
          WHERE assignment.freeze_id = NEW.freeze_id
            AND slate.candidate_count = 25
            AND slate.generated_at >= NEW.evaluated_from
            AND slate.generated_at <= NEW.evaluated_through
            AND 25 = (
              SELECT COUNT(*)
              FROM listing_impressions impression
              WHERE impression.slate_id = assignment.slate_id
            )
        )
        AND (
          NEW.result_state = 'pending_future_evidence'
          OR (
            NEW.result_state = 'thresholds_met_pending_operator_approval'
            AND NEW.unique_physical_listings_reviewed >= freeze.minimum_unique_physical_listings
            AND NEW.unique_positive_physical_clusters >= freeze.minimum_unique_positive_clusters
            AND NEW.completed_slates_of_25 >= freeze.minimum_completed_slates_of_25
            AND NEW.supported_slice_count >= freeze.minimum_supported_slices
            AND NEW.minimum_positive_clusters_in_supported_slice
              >= freeze.minimum_positives_per_supported_slice
            AND NEW.relative_lift >= freeze.minimum_relative_lift
            AND NEW.extra_positive_discoveries_per_25
              >= freeze.minimum_extra_positive_discoveries_per_25
            AND NEW.maximum_supported_slice_recall50_loss
              <= freeze.maximum_supported_slice_recall50_loss
            AND NEW.event_bootstrap_lower95 > 0
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'prospective evaluation is not future-bound or fails a frozen gate');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_operator_approvals_v2_gate
    BEFORE INSERT ON preference_prospective_operator_approvals_v2
    WHEN NOT EXISTS (
      SELECT 1 FROM preference_prospective_evaluation_receipts_v2 receipt
      WHERE receipt.receipt_id = NEW.receipt_id
        AND receipt.result_state = 'thresholds_met_pending_operator_approval'
        AND NEW.approved_at >= receipt.evaluated_through
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator approval requires a threshold-qualified prospective receipt');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_promotion_authorizations_v2_gate
    BEFORE INSERT ON preference_prospective_promotion_authorizations_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM preference_prospective_evaluation_receipts_v2 receipt
      JOIN preference_prospective_operator_approvals_v2 approval
        ON approval.receipt_id = receipt.receipt_id
      WHERE receipt.receipt_id = NEW.receipt_id
        AND receipt.freeze_id = NEW.freeze_id
        AND receipt.result_state = 'thresholds_met_pending_operator_approval'
        AND approval.approval_id = NEW.approval_id
        AND NEW.authorized_at >= approval.approved_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'promotion authorization requires matching future evidence and explicit approval');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feedback_reason_codes_v2_immutable_update
    BEFORE UPDATE ON preference_feedback_reason_codes_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_feedback_reason_codes_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feedback_reason_codes_v2_immutable_delete
    BEFORE DELETE ON preference_feedback_reason_codes_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_feedback_reason_codes_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_sessions_immutable_update
    BEFORE UPDATE ON review_sessions
    BEGIN
      SELECT RAISE(ABORT, 'review_sessions is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_sessions_immutable_delete
    BEFORE DELETE ON review_sessions
    BEGIN
      SELECT RAISE(ABORT, 'review_sessions is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_session_end_events_immutable_update
    BEFORE UPDATE ON review_session_end_events
    BEGIN
      SELECT RAISE(ABORT, 'review_session_end_events is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_session_end_events_immutable_delete
    BEFORE DELETE ON review_session_end_events
    BEGIN
      SELECT RAISE(ABORT, 'review_session_end_events is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slates_immutable_update
    BEFORE UPDATE ON review_slates
    BEGIN
      SELECT RAISE(ABORT, 'review_slates is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slates_immutable_delete
    BEFORE DELETE ON review_slates
    BEGIN
      SELECT RAISE(ABORT, 'review_slates is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slate_candidates_immutable_update
    BEFORE UPDATE ON review_slate_candidates
    BEGIN
      SELECT RAISE(ABORT, 'review_slate_candidates is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slate_candidates_immutable_delete
    BEFORE DELETE ON review_slate_candidates
    BEGIN
      SELECT RAISE(ABORT, 'review_slate_candidates is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slate_freezes_immutable_update
    BEFORE UPDATE ON review_slate_freezes
    BEGIN
      SELECT RAISE(ABORT, 'review_slate_freezes is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS review_slate_freezes_immutable_delete
    BEFORE DELETE ON review_slate_freezes
    BEGIN
      SELECT RAISE(ABORT, 'review_slate_freezes is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_impressions_immutable_update
    BEFORE UPDATE ON listing_impressions
    BEGIN
      SELECT RAISE(ABORT, 'listing_impressions is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_impressions_immutable_delete
    BEFORE DELETE ON listing_impressions
    BEGIN
      SELECT RAISE(ABORT, 'listing_impressions is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feedback_v2_immutable_update
    BEFORE UPDATE ON preference_feedback_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_feedback_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_feedback_v2_immutable_delete
    BEFORE DELETE ON preference_feedback_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_feedback_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_comparisons_v2_immutable_update
    BEFORE UPDATE ON preference_pairwise_comparisons_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_comparisons_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_comparisons_v2_immutable_delete
    BEFORE DELETE ON preference_pairwise_comparisons_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_comparisons_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_shadow_scores_v2_immutable_update
    BEFORE UPDATE ON preference_shadow_scores_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_shadow_scores_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_shadow_scores_v2_immutable_delete
    BEFORE DELETE ON preference_shadow_scores_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_shadow_scores_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_freezes_v2_immutable_update
    BEFORE UPDATE ON preference_prospective_freezes_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_freezes_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_freezes_v2_immutable_delete
    BEFORE DELETE ON preference_prospective_freezes_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_freezes_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_assignments_v2_immutable_update
    BEFORE UPDATE ON preference_prospective_assignments_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_assignments_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_assignments_v2_immutable_delete
    BEFORE DELETE ON preference_prospective_assignments_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_assignments_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_evaluation_receipts_v2_immutable_update
    BEFORE UPDATE ON preference_prospective_evaluation_receipts_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_evaluation_receipts_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_evaluation_receipts_v2_immutable_delete
    BEFORE DELETE ON preference_prospective_evaluation_receipts_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_evaluation_receipts_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_operator_approvals_v2_immutable_update
    BEFORE UPDATE ON preference_prospective_operator_approvals_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_operator_approvals_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_operator_approvals_v2_immutable_delete
    BEFORE DELETE ON preference_prospective_operator_approvals_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_operator_approvals_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_promotion_authorizations_v2_immutable_update
    BEFORE UPDATE ON preference_prospective_promotion_authorizations_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_promotion_authorizations_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_prospective_promotion_authorizations_v2_immutable_delete
    BEFORE DELETE ON preference_prospective_promotion_authorizations_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_prospective_promotion_authorizations_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_interaction_events_v2_lineage_guard
    BEFORE INSERT ON preference_interaction_events_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM listing_impressions impression
      JOIN review_slate_candidates candidate
        ON candidate.slate_candidate_id = impression.slate_candidate_id
      JOIN review_slate_freezes freeze ON freeze.slate_id = candidate.slate_id
      WHERE impression.impression_id = NEW.impression_id
        AND candidate.slate_candidate_id = NEW.slate_candidate_id
        AND candidate.slate_id = NEW.slate_id
        AND candidate.listing_id = NEW.listing_id
        AND candidate.candidate_set_hash = NEW.candidate_set_hash
        AND NEW.occurred_at >= impression.displayed_at
        AND NEW.server_sequence = COALESCE((
          SELECT MAX(existing.server_sequence)
          FROM preference_interaction_events_v2 existing
          WHERE existing.impression_id = NEW.impression_id
        ), 0) + 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'interaction event is not the next frozen-impression event');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offer_cadence_v2_guard
    BEFORE INSERT ON preference_pairwise_offer_cadence_receipts_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM review_sessions session
      LEFT JOIN review_session_end_events ending
        ON ending.session_id = session.session_id
      WHERE session.session_id = NEW.session_id
        AND session.user_id = NEW.user_id
        AND session.queue_name = 'teach_the_model'
        AND NEW.observed_at >= session.started_at
        AND (ending.ended_at IS NULL OR NEW.observed_at <= ending.ended_at)
        AND NEW.offer_sequence = COALESCE((
          SELECT MAX(existing.offer_sequence)
          FROM preference_pairwise_offer_cadence_receipts_v2 existing
          WHERE existing.user_id = NEW.user_id
        ), 0) + 1
        AND NEW.ordinary_feedback_count_at_offer = (
          SELECT COUNT(*)
          FROM preference_feedback_v2 feedback
          JOIN listing_impressions impression
            ON impression.impression_id = feedback.impression_id
          JOIN review_slates slate ON slate.slate_id = impression.slate_id
          JOIN review_sessions feedback_session
            ON feedback_session.session_id = slate.session_id
          WHERE feedback_session.user_id = NEW.user_id
            AND feedback.feedback_at <= NEW.observed_at
        )
        AND (
          (
            NEW.offer_sequence = 1
            AND NEW.prior_offer_id IS NULL
            AND NEW.ordinary_feedback_count_since_prior_offer =
              NEW.ordinary_feedback_count_at_offer
            AND NEW.ordinary_feedback_count_since_prior_offer >=
              NEW.required_ordinary_feedback_interval
          )
          OR (
            NEW.offer_sequence > 1
            AND NEW.prior_offer_id = (
              SELECT prior_offer.offer_id
              FROM preference_pairwise_offers_v2 prior_offer
              JOIN preference_pairwise_offer_cadence_receipts_v2 prior_receipt
                ON prior_receipt.cadence_receipt_id = prior_offer.cadence_receipt_id
              WHERE prior_receipt.user_id = NEW.user_id
              ORDER BY prior_receipt.offer_sequence DESC
              LIMIT 1
            )
            AND NEW.ordinary_feedback_count_since_prior_offer =
              NEW.ordinary_feedback_count_at_offer - (
                SELECT prior_receipt.ordinary_feedback_count_at_offer
                FROM preference_pairwise_offers_v2 prior_offer
                JOIN preference_pairwise_offer_cadence_receipts_v2 prior_receipt
                  ON prior_receipt.cadence_receipt_id = prior_offer.cadence_receipt_id
                WHERE prior_offer.offer_id = NEW.prior_offer_id
              )
            AND NEW.ordinary_feedback_count_since_prior_offer >=
              NEW.required_ordinary_feedback_interval
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'pairwise cadence receipt lacks twenty new ordinary feedback rows');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offers_v2_lineage_guard
    BEFORE INSERT ON preference_pairwise_offers_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM preference_pairwise_offer_cadence_receipts_v2 cadence
      JOIN review_slates slate ON slate.slate_id = NEW.slate_id
      JOIN review_slate_freezes freeze ON freeze.slate_id = slate.slate_id
      JOIN review_slate_candidates left_candidate
        ON left_candidate.slate_candidate_id = NEW.left_slate_candidate_id
      JOIN review_slate_candidates right_candidate
        ON right_candidate.slate_candidate_id = NEW.right_slate_candidate_id
      WHERE cadence.cadence_receipt_id = NEW.cadence_receipt_id
        AND cadence.session_id = slate.session_id
        AND cadence.observed_at = NEW.offered_at
        AND left_candidate.slate_id = slate.slate_id
        AND right_candidate.slate_id = slate.slate_id
        AND left_candidate.candidate_set_hash = NEW.candidate_set_hash
        AND right_candidate.candidate_set_hash = NEW.candidate_set_hash
        AND slate.candidate_set_hash = NEW.candidate_set_hash
        AND left_candidate.model_version = NEW.model_version
        AND right_candidate.model_version = NEW.model_version
        AND slate.candidate_model_version = NEW.model_version
        AND left_candidate.feature_version = NEW.feature_version
        AND right_candidate.feature_version = NEW.feature_version
        AND slate.candidate_feature_version = NEW.feature_version
        AND NEW.offered_at >= freeze.frozen_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'pairwise offer disagrees with its cadence receipt or frozen slate');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offer_responses_v2_lineage_guard
    BEFORE INSERT ON preference_pairwise_offer_responses_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM preference_pairwise_offers_v2 offer
      JOIN preference_pairwise_comparisons_v2 comparison
        ON comparison.comparison_id = NEW.comparison_id
      JOIN listing_impressions left_impression
        ON left_impression.impression_id = comparison.left_impression_id
      JOIN listing_impressions right_impression
        ON right_impression.impression_id = comparison.right_impression_id
      WHERE offer.offer_id = NEW.offer_id
        AND comparison.slate_id = offer.slate_id
        AND (
          (
            left_impression.slate_candidate_id = offer.left_slate_candidate_id
            AND right_impression.slate_candidate_id = offer.right_slate_candidate_id
          )
          OR (
            left_impression.slate_candidate_id = offer.right_slate_candidate_id
            AND right_impression.slate_candidate_id = offer.left_slate_candidate_id
          )
        )
        AND NEW.responded_at >= offer.offered_at
        AND NEW.responded_at >= comparison.comparison_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'pairwise response does not answer its exact offered pair');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_slate_candidate_explanations_v2_lineage_guard
    BEFORE INSERT ON preference_slate_candidate_explanations_v2
    WHEN NOT EXISTS (
      SELECT 1
      FROM review_slate_candidates candidate
      JOIN review_slates slate ON slate.slate_id = candidate.slate_id
      JOIN review_slate_freezes freeze ON freeze.slate_id = slate.slate_id
      WHERE candidate.slate_candidate_id = NEW.slate_candidate_id
        AND candidate.slate_id = NEW.slate_id
        AND candidate.listing_id = NEW.listing_id
        AND candidate.candidate_set_hash = NEW.candidate_set_hash
        AND candidate.model_version = NEW.model_version
        AND candidate.feature_version = NEW.feature_version
        AND candidate.displayed_snapshot_id = NEW.snapshot_id
        AND candidate.displayed_snapshot_hash = NEW.snapshot_hash
        AND NEW.recorded_at >= freeze.frozen_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'candidate explanation disagrees with its frozen candidate lineage');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_interaction_events_v2_immutable_update
    BEFORE UPDATE ON preference_interaction_events_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_interaction_events_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_interaction_events_v2_immutable_delete
    BEFORE DELETE ON preference_interaction_events_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_interaction_events_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offer_cadence_receipts_v2_immutable_update
    BEFORE UPDATE ON preference_pairwise_offer_cadence_receipts_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_offer_cadence_receipts_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offer_cadence_receipts_v2_immutable_delete
    BEFORE DELETE ON preference_pairwise_offer_cadence_receipts_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_offer_cadence_receipts_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offers_v2_immutable_update
    BEFORE UPDATE ON preference_pairwise_offers_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_offers_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offers_v2_immutable_delete
    BEFORE DELETE ON preference_pairwise_offers_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_offers_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offer_responses_v2_immutable_update
    BEFORE UPDATE ON preference_pairwise_offer_responses_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_offer_responses_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_pairwise_offer_responses_v2_immutable_delete
    BEFORE DELETE ON preference_pairwise_offer_responses_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_pairwise_offer_responses_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_slate_candidate_explanations_v2_immutable_update
    BEFORE UPDATE ON preference_slate_candidate_explanations_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_slate_candidate_explanations_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_slate_candidate_explanations_v2_immutable_delete
    BEFORE DELETE ON preference_slate_candidate_explanations_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_slate_candidate_explanations_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_members_v2_sealed_guard
    BEFORE INSERT ON preference_identity_import_members_v2
    WHEN EXISTS (
      SELECT 1 FROM preference_identity_import_receipts_v2 receipt
      WHERE receipt.receipt_id = NEW.receipt_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'sealed Preference V2 identity receipt cannot gain members');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_receipts_v2_completeness_guard
    BEFORE INSERT ON preference_identity_import_receipts_v2
    WHEN NOT (
      NEW.assignment_count = (
        SELECT count(*)
        FROM preference_identity_import_staging_members_v2 staged
        WHERE staged.receipt_id = NEW.receipt_id
      )
      AND NEW.physical_cluster_count = (
        SELECT count(*)
        FROM preference_identity_import_staging_physical_v2 staged
        WHERE staged.receipt_id = NEW.receipt_id
      )
      AND NEW.auction_event_block_count = (
        SELECT count(*)
        FROM preference_identity_import_staging_events_v2 staged
        WHERE staged.receipt_id = NEW.receipt_id
      )
      AND NEW.semantic_family_count = (
        SELECT count(*)
        FROM preference_identity_import_staging_families_v2 staged
        WHERE staged.receipt_id = NEW.receipt_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM preference_identity_import_staging_members_v2 staged
        LEFT JOIN preference_identity_import_members_v2 imported
          ON imported.receipt_id = staged.receipt_id
          AND imported.listing_id = staged.listing_id
          AND imported.assignment_ordinal = staged.assignment_ordinal
          AND imported.accepted_physical_asset_cluster_id =
            staged.accepted_physical_asset_cluster_id
          AND imported.runtime_physical_asset_cluster_id =
            staged.runtime_physical_asset_cluster_id
          AND imported.runtime_auction_event_block_id =
            staged.auction_event_block_id
          AND imported.runtime_semantic_family_id = staged.semantic_family_id
          AND imported.evidence_json = staged.evidence_json
          AND imported.evidence_hash = staged.evidence_hash
        WHERE staged.receipt_id = NEW.receipt_id
          AND imported.listing_id IS NULL
      )
      AND
      NEW.assignment_count = (
        SELECT count(*) FROM preference_identity_import_members_v2 imported
        WHERE imported.receipt_id = NEW.receipt_id
      )
      AND NEW.physical_member_count = NEW.assignment_count
      AND NEW.auction_event_member_count = NEW.assignment_count
      AND NEW.semantic_family_member_count = NEW.assignment_count
      AND NEW.physical_cluster_count = (
        SELECT count(DISTINCT imported.runtime_physical_asset_cluster_id)
        FROM preference_identity_import_members_v2 imported
        WHERE imported.receipt_id = NEW.receipt_id
      )
      AND NEW.auction_event_block_count = (
        SELECT count(DISTINCT imported.runtime_auction_event_block_id)
        FROM preference_identity_import_members_v2 imported
        WHERE imported.receipt_id = NEW.receipt_id
      )
      AND NEW.semantic_family_count = (
        SELECT count(DISTINCT imported.runtime_semantic_family_id)
        FROM preference_identity_import_members_v2 imported
        WHERE imported.receipt_id = NEW.receipt_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM preference_identity_import_members_v2 imported
        LEFT JOIN physical_asset_clusters physical_cluster
          ON physical_cluster.physical_asset_cluster_id =
            imported.runtime_physical_asset_cluster_id
          AND physical_cluster.cluster_version = imported.physical_algorithm_version
        LEFT JOIN preference_identity_import_staging_physical_v2 staged_physical
          ON staged_physical.receipt_id = imported.receipt_id
          AND staged_physical.runtime_physical_asset_cluster_id =
            imported.runtime_physical_asset_cluster_id
          AND staged_physical.cluster_version = physical_cluster.cluster_version
        LEFT JOIN physical_asset_cluster_members physical_member
          ON physical_member.physical_asset_cluster_id =
            imported.runtime_physical_asset_cluster_id
          AND physical_member.listing_id = imported.listing_id
          AND physical_member.algorithm_version = imported.physical_algorithm_version
          AND physical_member.evidence_json = imported.evidence_json
        LEFT JOIN auction_event_blocks event_block
          ON event_block.auction_event_block_id =
            imported.runtime_auction_event_block_id
          AND event_block.block_version = imported.auction_event_algorithm_version
        LEFT JOIN preference_identity_import_staging_events_v2 staged_event
          ON staged_event.receipt_id = imported.receipt_id
          AND staged_event.auction_event_block_id =
            imported.runtime_auction_event_block_id
          AND staged_event.block_version = event_block.block_version
          AND staged_event.source_id = event_block.source_id
          AND staged_event.authoritative_event_key =
            event_block.authoritative_event_key
          AND staged_event.evidence_json = event_block.evidence_json
        LEFT JOIN auction_event_block_members event_member
          ON event_member.auction_event_block_id =
            imported.runtime_auction_event_block_id
          AND event_member.listing_id = imported.listing_id
          AND event_member.algorithm_version = imported.auction_event_algorithm_version
          AND event_member.evidence_json = imported.evidence_json
        LEFT JOIN semantic_families semantic_family
          ON semantic_family.semantic_family_id = imported.runtime_semantic_family_id
          AND semantic_family.family_version = imported.semantic_family_algorithm_version
        LEFT JOIN preference_identity_import_staging_families_v2 staged_family
          ON staged_family.receipt_id = imported.receipt_id
          AND staged_family.semantic_family_id =
            imported.runtime_semantic_family_id
          AND staged_family.family_version = semantic_family.family_version
          AND staged_family.industry_domain = semantic_family.industry_domain
          AND staged_family.primary_asset_class =
            semantic_family.primary_asset_class
          AND staged_family.canonical_manufacturer =
            semantic_family.canonical_manufacturer
          AND staged_family.assignment_method =
            semantic_family.assignment_method
          AND staged_family.clustering_parameters_json =
            semantic_family.clustering_parameters_json
        LEFT JOIN semantic_family_members semantic_member
          ON semantic_member.semantic_family_id = imported.runtime_semantic_family_id
          AND semantic_member.listing_id = imported.listing_id
          AND semantic_member.algorithm_version = imported.semantic_family_algorithm_version
          AND semantic_member.evidence_json = imported.evidence_json
        WHERE imported.receipt_id = NEW.receipt_id
          AND (
            imported.receipt_kind <> NEW.receipt_kind
            OR imported.source_generation_identity <>
              NEW.source_generation_identity
            OR imported.manifest_hash <> NEW.manifest_hash
            OR imported.namespace_map_version <> NEW.namespace_map_version
            OR physical_cluster.physical_asset_cluster_id IS NULL
            OR staged_physical.runtime_physical_asset_cluster_id IS NULL
            OR physical_member.listing_id IS NULL
            OR event_block.auction_event_block_id IS NULL
            OR staged_event.auction_event_block_id IS NULL
            OR event_member.listing_id IS NULL
            OR semantic_family.semantic_family_id IS NULL
            OR staged_family.semantic_family_id IS NULL
            OR semantic_member.listing_id IS NULL
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Preference V2 identity receipt is incomplete or disagrees with imported members');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_physical_v2_immutable_update
    BEFORE UPDATE ON preference_identity_import_staging_physical_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_physical_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_physical_v2_immutable_delete
    BEFORE DELETE ON preference_identity_import_staging_physical_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_physical_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_events_v2_immutable_update
    BEFORE UPDATE ON preference_identity_import_staging_events_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_events_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_events_v2_immutable_delete
    BEFORE DELETE ON preference_identity_import_staging_events_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_events_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_families_v2_immutable_update
    BEFORE UPDATE ON preference_identity_import_staging_families_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_families_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_families_v2_immutable_delete
    BEFORE DELETE ON preference_identity_import_staging_families_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_families_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_members_v2_immutable_update
    BEFORE UPDATE ON preference_identity_import_staging_members_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_members_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_staging_members_v2_immutable_delete
    BEFORE DELETE ON preference_identity_import_staging_members_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_staging_members_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_receipts_v2_immutable_update
    BEFORE UPDATE ON preference_identity_import_receipts_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_receipts_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_receipts_v2_immutable_delete
    BEFORE DELETE ON preference_identity_import_receipts_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_receipts_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_members_v2_immutable_update
    BEFORE UPDATE ON preference_identity_import_members_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_members_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_identity_import_members_v2_immutable_delete
    BEFORE DELETE ON preference_identity_import_members_v2
    BEGIN
      SELECT RAISE(ABORT, 'preference_identity_import_members_v2 is append-only');
    END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_members_imported_v2_immutable_update
      BEFORE UPDATE ON physical_asset_cluster_members
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_physical_asset_cluster_id = OLD.physical_asset_cluster_id
          AND imported.listing_id = OLD.listing_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity members are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_cluster_members_imported_v2_immutable_delete
      BEFORE DELETE ON physical_asset_cluster_members
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_physical_asset_cluster_id = OLD.physical_asset_cluster_id
          AND imported.listing_id = OLD.listing_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity members are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_block_members_imported_v2_immutable_update
      BEFORE UPDATE ON auction_event_block_members
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_auction_event_block_id = OLD.auction_event_block_id
          AND imported.listing_id = OLD.listing_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity members are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_block_members_imported_v2_immutable_delete
      BEFORE DELETE ON auction_event_block_members
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_auction_event_block_id = OLD.auction_event_block_id
          AND imported.listing_id = OLD.listing_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity members are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_family_members_imported_v2_immutable_update
      BEFORE UPDATE ON semantic_family_members
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_semantic_family_id = OLD.semantic_family_id
          AND imported.listing_id = OLD.listing_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity members are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_family_members_imported_v2_immutable_delete
      BEFORE DELETE ON semantic_family_members
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_semantic_family_id = OLD.semantic_family_id
          AND imported.listing_id = OLD.listing_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity members are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_clusters_imported_v2_immutable_update
      BEFORE UPDATE ON physical_asset_clusters
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_physical_asset_cluster_id = OLD.physical_asset_cluster_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity parents are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS physical_asset_clusters_imported_v2_immutable_delete
      BEFORE DELETE ON physical_asset_clusters
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_physical_asset_cluster_id = OLD.physical_asset_cluster_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity parents are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_blocks_imported_v2_immutable_update
      BEFORE UPDATE ON auction_event_blocks
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_auction_event_block_id = OLD.auction_event_block_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity parents are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS auction_event_blocks_imported_v2_immutable_delete
      BEFORE DELETE ON auction_event_blocks
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_auction_event_block_id = OLD.auction_event_block_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity parents are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_families_imported_v2_immutable_update
      BEFORE UPDATE ON semantic_families
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_semantic_family_id = OLD.semantic_family_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity parents are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS semantic_families_imported_v2_immutable_delete
      BEFORE DELETE ON semantic_families
      WHEN EXISTS (
        SELECT 1 FROM preference_identity_import_members_v2 imported
        WHERE imported.runtime_semantic_family_id = OLD.semantic_family_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'receipted Preference V2 identity parents are immutable');
      END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_audit_receipts_immutable_update
    BEFORE UPDATE ON pipeline_audit_receipts
    BEGIN
      SELECT RAISE(ABORT, 'pipeline audit receipts are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_audit_receipts_immutable_delete
    BEFORE DELETE ON pipeline_audit_receipts
    BEGIN
      SELECT RAISE(ABORT, 'pipeline audit receipts are durable provenance');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_v2_coverage_receipts_immutable_update
    BEFORE UPDATE ON preference_v2_score_coverage_receipts
    BEGIN
      SELECT RAISE(ABORT, 'Preference V2 coverage receipts are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS preference_v2_coverage_receipts_immutable_delete
    BEFORE DELETE ON preference_v2_score_coverage_receipts
    BEGIN
      SELECT RAISE(ABORT, 'Preference V2 coverage receipts are durable provenance');
    END`,
  `CREATE TRIGGER IF NOT EXISTS source_release_proofs_immutable_update
    BEFORE UPDATE ON source_review_release_proofs
    BEGIN
      SELECT RAISE(ABORT, 'source release proofs are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS source_release_proofs_immutable_delete
    BEFORE DELETE ON source_review_release_proofs
    BEGIN
      SELECT RAISE(ABORT, 'source release proofs are durable provenance');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_image_content_links_immutable_update
    BEFORE UPDATE ON listing_image_content_links
    BEGIN
      SELECT RAISE(ABORT, 'listing image content links are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS listing_image_content_links_immutable_delete
    BEFORE DELETE ON listing_image_content_links
    BEGIN
      SELECT RAISE(ABORT, 'listing image content links are durable provenance');
    END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_execution_evidence_no_update
    BEFORE UPDATE ON pipeline_execution_evidence
    BEGIN
      SELECT RAISE(ABORT, 'pipeline execution evidence is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_execution_evidence_no_delete
    BEFORE DELETE ON pipeline_execution_evidence
    BEGIN
      SELECT RAISE(ABORT, 'pipeline execution evidence is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_component_execution_links_no_update
    BEFORE UPDATE ON pipeline_component_execution_links
    BEGIN
      SELECT RAISE(ABORT, 'pipeline component execution links are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_component_execution_links_no_delete
    BEFORE DELETE ON pipeline_component_execution_links
    BEGIN
      SELECT RAISE(ABORT, 'pipeline component execution links are immutable');
    END`,
  `CREATE UNIQUE INDEX IF NOT EXISTS source_runs_run_source_uidx ON source_runs (discovery_run_id, source_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_stubs_source_listing_uidx ON listing_stubs (source_id, source_listing_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_stubs_source_url_uidx ON listing_stubs (source_id, source_url)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_images_position_uidx ON listing_images (listing_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_images_source_url_uidx ON listing_images (listing_id, source_url)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_images_one_primary_uidx ON listing_images (listing_id) WHERE is_primary = 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS locations_cache_key_uidx ON locations (cache_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS route_cache_input_uidx ON route_cache (origin_cache_key, destination_location_id, provider_name, input_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS profile_versions_profile_version_uidx ON profile_versions (profile_id, version)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_routes_listing_uidx ON listing_routes (listing_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS upstream_lot_representatives_owner_uidx
    ON upstream_lot_representatives (owner_listing_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS source_acquired_bundle_reservation_idx
    ON source_acquired_bundles (reservation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS image_content_storage_key_idx
    ON image_content_blobs (storage_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS listing_image_content_exact_idx
    ON listing_image_content_links
      (listing_image_id, source_input_hash, content_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS preference_shadow_score_listing_identity_idx
    ON preference_shadow_scores_v2 (shadow_score_id, listing_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_component_execution_shadow_unique_idx
    ON pipeline_component_execution_links (component_name, shadow_receipt_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_component_execution_receipt_unique_idx
    ON pipeline_component_execution_links (component_name, execution_receipt_id)`,
  `CREATE VIEW review_session_records_v2 AS
    SELECT
      session.session_id,
      session.started_at,
      ending.ended_at,
      session.queue_name,
      session.client_id,
      session.user_id,
      ending.outcome,
      session.logging_policy_version
    FROM review_sessions session
    LEFT JOIN review_session_end_events ending
      ON ending.session_id = session.session_id`,
  `CREATE VIEW preference_prospective_readiness_v2 AS
    SELECT
      freeze.freeze_id,
      CASE
        WHEN authorization.authorization_id IS NOT NULL
          THEN 'authorized_for_separate_operator_promotion'
        WHEN approval.approval_id IS NOT NULL
          THEN 'operator_approved_pending_authorization_receipt'
        WHEN receipt.result_state = 'thresholds_met_pending_operator_approval'
          THEN 'thresholds_met_pending_operator_approval'
        ELSE 'pending_future_evidence'
      END AS readiness_state,
      receipt.receipt_id,
      approval.approval_id,
      authorization.authorization_id
    FROM preference_prospective_freezes_v2 freeze
    LEFT JOIN preference_prospective_evaluation_receipts_v2 receipt
      ON receipt.freeze_id = freeze.freeze_id
    LEFT JOIN preference_prospective_operator_approvals_v2 approval
      ON approval.receipt_id = receipt.receipt_id
    LEFT JOIN preference_prospective_promotion_authorizations_v2 authorization
      ON authorization.receipt_id = receipt.receipt_id`,
  `INSERT INTO _auction_discovery_public_schema (singleton, version, applied_at) VALUES (1, 45, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version, applied_at=excluded.applied_at`
];


