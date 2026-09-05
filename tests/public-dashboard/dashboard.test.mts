import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { register } from "node:module";
import test from "node:test";
import { ensureDatabase } from "../../db/bootstrap.ts";
import { emptyDashboard, listingMatchesSourceFilter, dashboardSourceFilterOptions, parseNightlySourceOutcomes } from "../../app/components/auction-data.ts";
import { listingCloseValue, listingEndTimestamp, listingRecommendationDisplayScore, listingSummary } from "../../app/components/auction-display.ts";
import type { Listing } from "../../app/components/auction-data.ts";

process.env.ORIGIN_POSTAL_CODE = "90210";
for (const key of ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"]) delete process.env[key];

const bindings: { DB?: D1Database } = {};
Object.assign(globalThis, { __publicDashboardTestEnv: bindings });
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) { if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicDashboardTestEnv;'}; return n(s,c); }`)}`, import.meta.url);
const dashboard = await import("../../db/dashboard.ts");

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const query = this.db.prepare(this.sql);
    return query.columns().length > 0
      ? { success: true, results: query.all(...this.values), meta: {} }
      : { success: true, results: [], meta: { changes: Number(query.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return this.execute(); }
}

async function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const binding = {
    prepare(sql: string) { return new Statement(db, sql); },
    async batch(statements: Statement[]) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = statements.map(statement => statement.execute()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  bindings.DB = binding;
  await ensureDatabase(binding);
  return db;
}

test("empty registered-source dashboard reads all ordinary scopes on the fresh public schema", async () => {
  const db = await database();
  try {
    for (const scope of ["unvoted", "all", "voted", "interested", "not_interested"] as const) {
      const payload = await dashboard.readDashboardPayload(scope);
      assert.deepEqual(payload.listings, []);
      assert.deepEqual(payload.sources, []);
      assert.equal(payload.originPostalCode, "90210");
      assert.equal(payload.profile.positiveVotes, 0);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("generic labels and factual text work without an AI recommendation", () => {
  const listing = {
    id: "fixture:one", source: "Example inventory", sourceFilters: ["Example inventory"],
    cleanDescription: "Observed source description", rawDescription: "Original source text",
    aiSummary: "", aiMeta: { provider: "pending" }, recommendation: null,
    closesAt: "2026-01-02", attributes: { lotType: "unknown" },
  } as unknown as Listing;
  assert.equal(listingSummary(listing), "Observed source description");
  assert.equal(listingRecommendationDisplayScore(listing), null);
  assert.equal(listingEndTimestamp(listing), null);
  assert.ok(Number.isFinite(listingCloseValue(listing)));
  assert.deepEqual(dashboardSourceFilterOptions([listing]), ["Example inventory"]);
  assert.equal(listingMatchesSourceFilter(listing, "Example inventory"), true);
  assert.equal(listingMatchesSourceFilter(listing, "Another inventory"), false);
  assert.deepEqual(emptyDashboard.listings, []);
});

test("source outcomes accept an empty or arbitrary source set and reject duplicate identities", () => {
  const outcomes = Array.from({ length: 20 }, (_, index) => ({
    sourceId: `example_${index}`, outcome: "blocked", dependencySatisfied: false,
    reasonCode: "permission_review_required", priorHead: null, resultingHead: null,
    nextEligibleAt: null, proofIdentity: null, receiptIdentity: null,
  }));
  assert.deepEqual(parseNightlySourceOutcomes([]), []);
  assert.deepEqual(parseNightlySourceOutcomes(outcomes), outcomes);
  assert.equal(parseNightlySourceOutcomes([outcomes[0], outcomes[0]]), null);
  assert.equal(parseNightlySourceOutcomes([{ ...outcomes[0], sourceId: "" }]), null);
});

test("factual current listings stay reviewable and votes survive into ordinary history without AI", async () => {
  const db = await database();
  const at = "2026-01-01T00:00:00.000Z";
  const id = "example_inventory:one";
  try {
    db.prepare("INSERT INTO auction_sources(id, display_name, base_url) VALUES (?, ?, ?)")
      .run("example_inventory", "Example inventory", "https://inventory.example.test");
    db.prepare("INSERT INTO discovery_runs(id, trigger, status, origin_postal_code) VALUES ('fixture-run', 'manual', 'completed', '90210')").run();
    db.prepare(`INSERT INTO listing_stubs(id, source_id, source_listing_id, source_url, title,
      visible_postal_code, visible_country_code, discovered_at, content_hash)
      VALUES (?, 'example_inventory', 'one', 'https://inventory.example.test/one', 'Bench instrument', '90210', 'US', ?, 'fixture-detail')`).run(id, at);
    db.prepare(`INSERT INTO listing_details(listing_id, title_at_scrape, raw_description, clean_description,
      pickup_postal_code, pickup_country_code, scraped_at, content_hash)
      VALUES (?, 'Bench instrument', 'Observed original text', 'Observed source description', '90210', 'US', ?, 'fixture-detail')`).run(id, at);
    db.prepare("INSERT INTO source_current_listings(listing_id, source_id, inventory_run_id, observed_at) VALUES (?, 'example_inventory', 'fixture-run', ?)").run(id, at);
    db.prepare("INSERT INTO source_inventory_publications(source_id, inventory_run_id, listing_count) VALUES ('example_inventory', 'fixture-run', 1)").run();
    db.prepare("INSERT INTO source_inventory_publication_heads(source_id, inventory_run_id) VALUES ('example_inventory', 'fixture-run')").run();
    db.prepare("INSERT INTO locations(id, cache_key, postal_code, country_code) VALUES ('fixture-location', 'US|||90210', '90210', 'US')").run();
    db.prepare(`INSERT INTO route_cache(id, origin_cache_key, destination_location_id, provider_name, input_hash, drive_seconds, drive_bucket)
      VALUES ('fixture-route', 'US|||90210', 'fixture-location', 'local_proximity', 'fixture-route-hash', 600, 'under_2h')`).run();
    db.prepare("INSERT INTO listing_routes(listing_id, route_cache_id) VALUES (?, 'fixture-route')").run(id);
    db.prepare(`INSERT INTO listing_operational_ownership(listing_id, source_id, actionable_owner_source_id, owner_basis, owner_state, actionable_owner_listing_id,
      counterpart_state, ownership_input_hash, derivation_version)
      VALUES (?, 'example_inventory', 'example_inventory', 'native_source', 'native_primary', ?, 'unknown', 'fixture-owner', 'fixture-owner-v1')`).run(id, id);
    db.prepare(`INSERT INTO listing_current_pipeline_state(listing_id, source_id, source_current, active_inventory_run_id,
      review_candidate, ownership_input_hash, route_cache_identity, route_input_hash, relevant_generation_vector_hash,
      projection_derivation_version)
      VALUES (?, 'example_inventory', 1, 'fixture-run', 1, 'fixture-owner', 'fixture-route', 'fixture-route-hash',
      'fixture-generations', 'fixture-projection-v1')`).run(id);
    db.prepare(`INSERT INTO listing_recovery_status(listing_id, origin_cache_key, state, stage, last_attempted_at, last_error_code)
      VALUES (?, 'source-evidence', 'terminal', 'image', ?, 'source_image_absent')`).run(id, at);
    const initial = await dashboard.readDashboardPayload("unvoted");
    assert.equal(initial.listings.length, 1);
    assert.equal(initial.listings[0]!.source, "Example inventory");
    assert.equal(initial.listings[0]!.recommendation, null);
    assert.equal(initial.listings[0]!.voteReady, true);
    assert.deepEqual(initial.listings[0]!.sourceFilters, ["Example inventory"]);
    assert.equal(initial.run.stages.find(stage => stage.id === "enrichment")?.state, "not_run");
    assert.equal(await dashboard.upsertBinaryVote(id, "interested"), true);
    assert.equal((await dashboard.readDashboardPayload("unvoted")).listings.length, 0);
    assert.equal((await dashboard.readDashboardPayload("interested")).listings[0]!.vote, "interested");
    assert.equal(await dashboard.clearBinaryVote(id), true);
    assert.equal((await dashboard.readDashboardPayload("unvoted")).listings.length, 1);
    assert.equal(await dashboard.upsertBinaryVote(id, "interested"), true);
    db.prepare("DELETE FROM source_current_listings WHERE listing_id = ?").run(id);
    dashboard.invalidateDashboardReleaseCache();
    const history = await dashboard.readDashboardPayload("interested");
    assert.equal(history.listings[0]!.voteReady, true);
    assert.equal(await dashboard.upsertBinaryVote(id, "not_interested"), true);
    assert.equal((await dashboard.readDashboardPayload("not_interested")).listings[0]!.vote, "not_interested");
    assert.equal(await dashboard.clearBinaryVote(id), true);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
