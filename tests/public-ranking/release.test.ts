import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { computeSourceReleaseInput, readProjectedSourceReleaseEvidence } from "../../lib/pipeline/source-release-state.ts";
import { readCanonicalOperationalProjectionRows } from "../../lib/pipeline/operational-projection.ts";
import { ensureDatabase } from "../../db/bootstrap.ts";

function binding(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...input: SQLInputValue[]) { values = input; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...values), meta: {} }; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
}

test("canonical projection query works against the fresh public schema with no private tables or model", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const database = binding(sqlite);
    await ensureDatabase(database);
    assert.deepEqual(await readCanonicalOperationalProjectionRows({
      database, listingIds: ["sample:missing"], originCacheKey: "fixture-origin",
    }), []);
  } finally { sqlite.close(); }
});

test("real release SQL admits factual Unrated rows and still enforces route/image/enrichment contracts", async () => {
  const keys = ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const key of keys) delete process.env[key];
    sqlite.exec(`
      CREATE TABLE auction_sources (id TEXT);
      CREATE TABLE pipeline_generation_state (domain TEXT, scope_type TEXT, scope_id TEXT, generation INTEGER, fingerprint TEXT, derivation_version TEXT);
      CREATE TABLE listing_stubs (id TEXT, title TEXT);
      CREATE TABLE listing_details (listing_id TEXT, raw_description TEXT, clean_description TEXT);
      CREATE TABLE listing_detail_terminal_status (listing_id TEXT);
      CREATE TABLE listing_votes (listing_id TEXT);
      CREATE TABLE listing_impressions (listing_id TEXT);
      CREATE TABLE profile_versions (id TEXT);
      CREATE TABLE adhoc_review_cohorts (id TEXT);
      CREATE TABLE listing_routes (listing_id TEXT, route_cache_id TEXT);
      CREATE TABLE route_cache (id TEXT, provider_name TEXT, input_hash TEXT, error_code TEXT, drive_bucket TEXT);
      CREATE TABLE listing_enrichment_heads (listing_id TEXT, state TEXT, head_identity TEXT, enrichment_input_hash TEXT);
      CREATE TABLE listing_operational_ownership (listing_id TEXT, ownership_input_hash TEXT, actionable_owner_listing_id TEXT);
      CREATE TABLE pipeline_work_items (subject_type TEXT, subject_id TEXT, stage TEXT, lease_owner TEXT, lease_expires_at TEXT);
      CREATE TABLE listing_current_pipeline_state (
        listing_id TEXT, source_id TEXT, source_current INTEGER, review_candidate INTEGER,
        source_release_input_hash TEXT, relevant_generation_vector_hash TEXT,
        ownership_input_hash TEXT, accepted_detail_identity TEXT, accepted_detail_hash TEXT,
        factual_supplement_state TEXT, local_primary_state TEXT, route_cache_identity TEXT,
        route_input_hash TEXT, enrichment_head_identity TEXT, enrichment_input_hash TEXT,
        score_head_identity TEXT, factual_supplement_input_hash TEXT, image_input_hash TEXT
      );
      INSERT INTO auction_sources VALUES ('sample');
      INSERT INTO listing_stubs VALUES ('sample:1', 'Workbench');
      INSERT INTO listing_routes VALUES ('sample:1', 'route');
      INSERT INTO route_cache VALUES ('route', 'local_proximity', 'route-input', NULL, 'under_2h');
    `);
    const hash = `sha256:${"1".repeat(64)}`;
    sqlite.prepare("INSERT INTO listing_operational_ownership VALUES (?, ?, ?)")
      .run("sample:1", hash, "sample:1");
    sqlite.prepare("INSERT INTO listing_current_pipeline_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("sample:1", "sample", 1, 1, hash, hash, hash, "detail", "detail-hash", "ready", "terminal", "route", "route-input", null, "enrichment-input", null, "factual-input", "image-input");
    for (const domain of ["source_publication", "ownership_derivation", "active_origin", "accepted_detail_location", "image_local_primary"]) {
      sqlite.prepare("INSERT INTO pipeline_generation_state VALUES (?, 'global', 'global', 1, ?, 'fixture-v1')").run(domain, hash);
    }
    const database = binding(sqlite);
    const read = () => readProjectedSourceReleaseEvidence({ database, sourceId: "sample" });
    let evidence = await read();
    assert.equal(evidence.acceptedCount, 1);
    assert.equal(evidence.preparedCount, 1);
    assert.equal(evidence.incompleteCount, 0);
    assert.equal((await computeSourceReleaseInput(evidence)).preparedCount, 1);
    assert.equal(evidence.generationVector.length, 5, "Absent optional state must not fabricate generations");
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM pipeline_generation_state WHERE domain = 'preference_contract'").get()?.count, 0);
    for (const [table, component] of [["listing_votes", "vote_watermark"], ["listing_impressions", "active_history"], ["adhoc_review_cohorts", "cohort_policy"], ["profile_versions", "preference_visibility"]]) {
      sqlite.prepare(`INSERT INTO ${table} VALUES (?)`).run("sample:1");
      await assert.rejects(read(), new RegExp(`generation evidence is missing ${component}`));
      sqlite.exec(`DELETE FROM ${table}`);
    }
    // Obsolete optional work is not an invented failure or an enabled capability.
    sqlite.exec("INSERT INTO pipeline_work_items VALUES ('listing', 'sample:1', 'preference_v2_score', NULL, NULL)");
    assert.equal((await read()).preparedCount, 1);
    sqlite.exec("UPDATE listing_current_pipeline_state SET local_primary_state = 'pending'");
    assert.equal((await read()).preparedCount, 0);
    sqlite.exec("UPDATE listing_current_pipeline_state SET local_primary_state = 'terminal'");
    sqlite.exec("UPDATE route_cache SET input_hash = 'stale'");
    assert.equal((await read()).acceptedCount, 0);
    sqlite.exec("UPDATE route_cache SET input_hash = 'route-input'");
    for (const key of keys) process.env[key] = key.endsWith("PROVIDER") ? "ollama" : "user-model";
    await assert.rejects(read(), /generation evidence is missing enrichment_target_head/);
    sqlite.prepare("INSERT INTO pipeline_generation_state VALUES ('enrichment_target', 'global', 'global', 1, ?, 'fixture-v1')").run(hash);
    assert.equal((await read()).preparedCount, 0);
    sqlite.exec("INSERT INTO listing_enrichment_heads VALUES ('sample:1', 'complete', 'head', 'enrichment-input')");
    sqlite.exec("UPDATE listing_current_pipeline_state SET enrichment_head_identity = 'head'");
    evidence = await read();
    assert.equal(evidence.preparedCount, 1);
    assert.equal(sqlite.prepare("SELECT score_head_identity FROM listing_current_pipeline_state").get()?.score_head_identity, null);
    sqlite.exec("UPDATE listing_enrichment_heads SET enrichment_input_hash = 'stale'");
    assert.equal((await read()).preparedCount, 0);
    sqlite.exec("DELETE FROM pipeline_generation_state WHERE domain = 'source_publication'");
    await assert.rejects(read(), /generation evidence is missing source_publication/);
  } finally {
    sqlite.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
