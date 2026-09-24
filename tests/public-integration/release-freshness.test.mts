import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureDatabase } from "../../db/bootstrap.ts";
import type { SourceReleaseFreshnessResult } from "../../lib/scheduler/runtime-adapter.ts";
import { PerformanceTelemetryBuffer } from "../../lib/performance/telemetry.ts";

const env: { DB?: D1Database } = {};
Object.assign(globalThis, { __releaseFreshnessTestEnv: env });
const adapters = new URL("./discovery-adapters.fixture.mts", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
  if(s==='cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env=globalThis.__releaseFreshnessTestEnv'};
  if(/source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(process.env.PUBLIC_RELEASE_FRESHNESS_EMPTY === "1" ? "data:text/javascript,export default []" : adapters)}};
  return n(s,c);
}`)}`, import.meta.url);
const service = await import("../../lib/scheduler/runtime-service.ts");
const release = await import("../../lib/pipeline/source-release-state.ts");
const authorization = await import("../../lib/scheduler/runtime-authorization.ts");
const { NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION } = await import("../../lib/scheduler/runtime-adapter.ts");
const now = new Date("2026-01-02T12:00:00.000Z");
const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const sources = ["fixture_html", "fixture_json"];
const originalFetch = globalThis.fetch;
const aiKeys = ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"] as const;
const previousAi = aiKeys.map((key) => [key, process.env[key]] as const);
test.before(() => {
  globalThis.fetch = async () => { throw new Error("release tests prohibit external requests"); };
  for (const key of aiKeys) process.env[key] = "disabled";
});
test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of previousAi) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

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
  async first(column?: string) { const row = this.db.prepare(this.sql).get(...this.values); return row ? column ? row[column] : row : null; }
  async all() { return this.execute(); }
}
async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const binding = {
    prepare(sql: string) { return new Statement(db, sql); },
    async batch(statements: Statement[]) {
      db.exec("BEGIN IMMEDIATE");
      try { const rows = statements.map((statement) => statement.execute()); db.exec("COMMIT"); return rows; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  await ensureDatabase(binding);
  for (const source of sources) {
    db.prepare(`INSERT INTO auction_sources (id,display_name,base_url,enabled,permission_status,pickup_location_visibility)
      VALUES (?,?,'https://example.invalid',1,'allowed','mixed')`).run(source, source);
    db.prepare(`INSERT INTO discovery_runs (id,trigger,status,origin_postal_code) VALUES (?,'manual','completed','90210')`).run(source);
    db.prepare(`INSERT INTO source_inventory_publications (source_id,inventory_run_id,listing_count,published_at) VALUES (?,?,0,?)`).run(source, source, now.toISOString());
    db.prepare(`INSERT INTO source_inventory_publication_heads (source_id,inventory_run_id,updated_at) VALUES (?,?,?)`).run(source, source, now.toISOString());
  }
  // Optional AI, votes, cohorts, history, and preference visibility are absent.
  for (const domain of ["source_publication", "source_current_membership", "shared_alias_group",
    "upstream_representative", "ownership_derivation", "active_origin", "route_contract",
    "accepted_detail_location", "factual_supplement", "image_local_primary"]) {
    db.prepare(`INSERT INTO pipeline_generation_state (domain,scope_type,scope_id,generation,fingerprint,derivation_version)
      VALUES (?,'global','all',1,?,'fixture-v1')`).run(domain, hash("1"));
  }
  db.exec(`INSERT INTO listing_stubs (id,source_id,source_listing_id,source_url,title,discovered_at,content_hash)
      VALUES ('fixture_html:one','fixture_html','one','https://example.invalid/one','Fixture','${now.toISOString()}','fixture');
    INSERT INTO listing_current_pipeline_state (listing_id,source_id,source_release_work_input_hash,
      relevant_generation_vector_hash,projection_derivation_version,updated_at)
      VALUES ('fixture_html:one','fixture_html','${hash("2")}','${hash("3")}','fixture-v1','2026-01-01T00:00:00.000Z');`);
  for (const sourceId of sources) await release.reconcileProjectedSourceRelease({ database: binding, sourceId, now });
  return { db, binding };
}
function queue(db: DatabaseSync) {
  return db.prepare("SELECT subject_id,input_hash,revision FROM pipeline_work_items ORDER BY subject_id").all();
}
function change(db: DatabaseSync, domain: string) {
  db.prepare(`INSERT INTO pipeline_generation_state (domain,scope_type,scope_id,generation,fingerprint,derivation_version)
    VALUES (?,'global','all',1,?,'fixture-v1') ON CONFLICT(domain,scope_type,scope_id)
    DO UPDATE SET generation=generation+1,fingerprint=excluded.fingerprint`).run(domain, hash("4"));
}
async function drain(database: D1Database) {
  for (let count = 0; count < 3; count++) {
    const snapshot = await service.readNightlySchedulerSnapshot({ database, limit: 32,
      campaignId: "fixture-release", coverageMode: "complete_current", includeSourceAcquisitions: false, now });
    const candidate = snapshot.candidates[0];
    if (!candidate) return;
    assert.equal(candidate.stage, "source_release");
    const reservation = await service.reserveNightlySchedulerCandidate({ database, candidate, now });
    const acquired = service.acquireNightlySchedulerCandidate({ candidate, reservation });
    const bundle = await service.validateNightlySchedulerAcquisition({ candidate, reservation, acquired });
    const result = await service.commitNightlySchedulerCandidate({ database, candidate, reservation, bundle, now });
    assert.equal(result.kind, "outcome");
  }
  assert.fail("bounded release drain did not finish");
}

test("release queue identity changes for global-only input with zero listing refreshes", async () => {
  const { db, binding } = await fixture();
  try {
    await service.enqueueProjectedSourceReleaseWork(binding, now, ["fixture_json"]);
    const before = queue(db)[0]!.input_hash;
    change(db, "enrichment_target");
    await service.enqueueProjectedSourceReleaseWork(binding, now, ["fixture_json"]);
    assert.notEqual(queue(db)[0]!.input_hash, before);
    const after = queue(db);
    change(db, "source_release_cache");
    await service.enqueueProjectedSourceReleaseWork(binding, now, ["fixture_json"]);
    assert.deepEqual(queue(db), after);
  } finally { db.close(); }
});

test("final reconciliation drains all published sources with optional AI and history absent", async () => {
  const { db, binding } = await fixture();
  try {
    const evidence = await release.readProjectedSourceReleaseEvidence({ database: binding, sourceId: "fixture_json" });
    const vector = await release.readSourceReleaseGenerationVector({ database: binding, sourceId: "fixture_json" });
    const canonical = await release.computeSourceReleaseInput(evidence);
    assert.equal(canonical.derivationVersion, "source-review-release-v7");
    assert.equal(vector.generationVectorHash, canonical.generationVectorHash);
    assert.deepEqual(vector.generationVector, evidence.generationVector);
    for (const component of ["enrichment_target_head", "vote_watermark", "cohort_policy", "active_history", "preference_visibility"]) {
      assert.equal(vector.generationVector.some((entry) => entry.component === component), false);
    }
    assert.deepEqual(await service.reconcileNightlySourceReleaseFreshness({ database: binding, now }),
      { status: "settled", checkedSourceIds: sources, queuedSourceIds: [] });
    const proofs = db.prepare("SELECT * FROM source_review_release_proofs ORDER BY proof_id").all();
    change(db, "presentation_policy");
    const policyVector = await release.readSourceReleaseGenerationVector({ database: binding, sourceId: "fixture_json" });
    assert.ok(policyVector.generationVector.some((entry) => entry.component === "preference_visibility"));
    assert.deepEqual(await service.reconcileNightlySourceReleaseFreshness({ database: binding, now }),
      { status: "queued", checkedSourceIds: sources, queuedSourceIds: sources });
    assert.deepEqual(db.prepare("SELECT * FROM source_review_release_proofs ORDER BY proof_id").all(), proofs);
    const firstQueue = queue(db);
    await service.reconcileNightlySourceReleaseFreshness({ database: binding, now });
    assert.deepEqual(queue(db), firstQueue);
    await drain(binding);
    assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).status, "settled");
    change(db, "enrichment_target");
    await service.reconcileNightlySourceReleaseFreshness({ database: binding, now });
    assert.deepEqual(queue(db).map((row) => row.subject_id), sources);
    assert.notDeepEqual(queue(db).map((row) => row.input_hash), firstQueue.map((row) => row.input_hash));
    await drain(binding);
    change(db, "source_release_cache");
    assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).status, "settled");
    assert.deepEqual(queue(db), []);
  } finally { db.close(); }
});

test("a current withheld source settles while only missing or dirty sources are queued", async () => {
  const { db, binding } = await fixture();
  try {
    db.exec(`INSERT INTO locations (id,cache_key) VALUES ('fixture','fixture');
      INSERT INTO route_cache (id,origin_cache_key,destination_location_id,provider_name,input_hash,drive_bucket)
        VALUES ('fixture','fixture','fixture','local_proximity','${hash("5")}','under_2h');
      INSERT INTO listing_routes (listing_id,route_cache_id) VALUES ('fixture_html:one','fixture');
      INSERT INTO listing_operational_ownership (listing_id,source_id,actionable_owner_listing_id,actionable_owner_source_id,
        owner_state,owner_basis,ownership_input_hash,derivation_version,counterpart_state)
        VALUES ('fixture_html:one','fixture_html','fixture_html:one','fixture_html','native_primary','fixture','${hash("6")}','fixture','unknown');
      UPDATE listing_current_pipeline_state SET source_current=1,review_candidate=1,ownership_input_hash='${hash("6")}',
        source_release_input_hash='${hash("7")}',route_cache_identity='fixture',route_input_hash='${hash("5")}';`);
    const settled = await release.reconcileProjectedSourceRelease({ database: binding, sourceId: "fixture_html", now });
    assert.equal(settled.state.state, "withheld");
    assert.equal(settled.state.incompleteCount, 1);
    assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).status, "settled");
    db.exec("DELETE FROM source_review_release_state WHERE source_id='fixture_json'");
    db.prepare("UPDATE listing_current_pipeline_state SET updated_at=?").run(now.toISOString());
    assert.deepEqual((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).queuedSourceIds,
      ["fixture_json"], "a touched but current withheld source is not queued");
    await drain(binding);
    db.exec("UPDATE source_review_release_state SET state='dirty' WHERE source_id='fixture_html'");
    assert.deepEqual((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).queuedSourceIds, ["fixture_html"]);
  } finally { db.close(); }
});

test("active writers, release claims, and source reservations retain ownership", async () => {
  const { db, binding } = await fixture();
  try {
    db.exec(`INSERT INTO pipeline_run_lease (singleton,run_kind,run_id,acquired_at,expires_at)
      VALUES (1,'discovery','writer','${now.toISOString()}','2099-01-01T00:00:00.000Z')`);
    assert.deepEqual(await service.reconcileNightlySourceReleaseFreshness({ database: binding, now }),
      { status: "upstream_work_pending", checkedSourceIds: [], queuedSourceIds: [] });
    db.exec("DELETE FROM pipeline_run_lease");
    change(db, "presentation_policy");
    await service.reconcileNightlySourceReleaseFreshness({ database: binding, now });
    const snapshot = await service.readNightlySchedulerSnapshot({ database: binding, limit: 32,
      campaignId: "fixture-owned", coverageMode: "complete_current", includeSourceAcquisitions: false, now });
    await service.reserveNightlySchedulerCandidate({ database: binding, candidate: snapshot.candidates[0]!, now });
    const claimed = db.prepare("SELECT * FROM pipeline_work_items ORDER BY subject_id").all();
    assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).status, "upstream_work_pending");
    assert.deepEqual(db.prepare("SELECT * FROM pipeline_work_items ORDER BY subject_id").all(), claimed);
    db.exec(`DELETE FROM pipeline_work_items;
      INSERT INTO source_acquisition_reservations (reservation_id,source_id,request_role,request_identity,
        adapter_version,proof_version,lane_key,expected_generation,input_hash,input_revision,request_budget,lease_owner,expires_at)
        VALUES ('fixture','fixture_html','catalog','fixture','fixture','fixture','fixture',1,'${hash("8")}',1,1,'other-writer','2099-01-01T00:00:00.000Z')`);
    assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).status, "upstream_work_pending");
    assert.deepEqual(queue(db), []);
  } finally { db.close(); }
});

test("new upstream work or a completed concurrent generation/head change cannot report settled", async () => {
  for (const mutation of ["upstream", "generation", "head"] as const) {
    const { db, binding } = await fixture();
    try {
      let injected = false;
      const racing = new Proxy(binding, { get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property);
        return (sql: string) => {
          if (!injected && sql.includes("FROM source_review_release_state")) {
            injected = true;
            if (mutation === "generation") change(db, "presentation_policy");
            else if (mutation === "head") db.exec("DELETE FROM source_inventory_publication_heads WHERE source_id='fixture_json'");
            else db.exec(`INSERT INTO pipeline_work_items (stage,subject_type,subject_id,source_id,lane_key,input_hash,reason_code,available_at)
              VALUES ('projection_source_refresh','source','fixture_html','fixture_html','fixture','${hash("8")}','fixture','${now.toISOString()}')`);
          }
          return target.prepare(sql);
        };
      } });
      assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: racing, now })).status, "upstream_work_pending");
      if (mutation === "upstream") assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pipeline_work_items WHERE stage='source_release'").get()?.n, 0);
    } finally { db.close(); }
  }
});

test("actual freshness POST accepts only preparation authorization and an exact payload", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const { db, binding } = await fixture(); env.DB = binding;
  const previousRevision = process.env.AUCTION_DISCOVERY_RUNTIME_REVISION;
  process.env.AUCTION_DISCOVERY_RUNTIME_REVISION = hash("a");
  try {
    const { POST } = await import("../../app/api/internal/nightly-scheduler/route.ts");
    const post = (token?: string, extra = {}) => POST(new Request("http://localhost:3000/api/internal/nightly-scheduler", {
      method: "POST", headers: { "content-type": "application/json", "x-auction-discovery-runtime-revision": hash("a"),
        ...(token ? { [authorization.NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER]: token } : {}) },
      body: JSON.stringify({ schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION, action: "reconcile_release_freshness", ...extra }),
    }));
    assert.equal((await post()).status, 401);
    const acquiring = authorization.schedulerRuntimeAuthorizationRegistry.issue({ campaignId: "fixture-acquiring", coverageMode: "complete_current", includeSourceAcquisitions: true });
    assert.equal((await post(acquiring)).status, 401);
    const preparing = authorization.schedulerRuntimeAuthorizationRegistry.issue({ campaignId: "fixture-preparing", coverageMode: "complete_current", includeSourceAcquisitions: false });
    assert.equal((await post(preparing, { sourceIds: sources })).status, 400);
    assert.equal((await post(preparing, { inputHash: hash("b") })).status, 400);
    change(db, "presentation_policy");
    const response = await post(preparing);
    assert.equal(response.status, 200);
    const body = await response.json() as { result: SourceReleaseFreshnessResult };
    assert.equal(body.result.status, "queued");
    assert.deepEqual(body.result.queuedSourceIds, sources);
    await drain(binding);
    const settled = await (await post(preparing)).json() as { result: SourceReleaseFreshnessResult };
    assert.equal(settled.result.status, "settled");
  } finally {
    authorization.schedulerRuntimeAuthorizationRegistry.reset(); delete env.DB; db.close();
    if (previousRevision === undefined) delete process.env.AUCTION_DISCOVERY_RUNTIME_REVISION;
    else process.env.AUCTION_DISCOVERY_RUNTIME_REVISION = previousRevision;
  }
});

test("a new upstream item between source enqueues returns pending with the retained queued subset", async () => {
  const { db, binding } = await fixture();
  try {
    change(db, "presentation_policy");
    const proofs = db.prepare("SELECT * FROM source_review_release_proofs ORDER BY proof_id").all();
    db.exec(`CREATE TRIGGER concurrent_upstream AFTER INSERT ON pipeline_work_items
      WHEN NEW.stage='source_release' AND NEW.subject_id='fixture_html'
      BEGIN INSERT INTO pipeline_work_items (stage,subject_type,subject_id,source_id,lane_key,input_hash,reason_code,available_at)
        VALUES ('projection_source_refresh','source','fixture_json','fixture_json','fixture','${hash("8")}','fixture','${now.toISOString()}'); END`);
    assert.deepEqual(await service.reconcileNightlySourceReleaseFreshness({ database: binding, now }), {
      status: "upstream_work_pending", checkedSourceIds: sources, queuedSourceIds: ["fixture_html"],
    });
    assert.deepEqual(db.prepare("SELECT subject_id FROM pipeline_work_items WHERE stage='source_release'").all().map((row) => row.subject_id), ["fixture_html"]);
    assert.deepEqual(db.prepare("SELECT * FROM source_review_release_proofs ORDER BY proof_id").all(), proofs);
  } finally { db.close(); }
});

test("published source bound fails before enqueueing any release work", async () => {
  const { db, binding } = await fixture();
  try {
    for (let index = 0; index < 31; index++) {
      const id = `extra_fixture_${index}`;
      db.prepare(`INSERT INTO auction_sources (id,display_name,base_url,enabled,permission_status,pickup_location_visibility)
        VALUES (?,?,'https://example.invalid',1,'allowed','mixed')`).run(id, id);
      db.prepare(`INSERT INTO source_inventory_publications (source_id,inventory_run_id,listing_count,published_at)
        VALUES (?,'fixture_json',0,?)`).run(id, now.toISOString());
      db.prepare(`INSERT INTO source_inventory_publication_heads (source_id,inventory_run_id,updated_at)
        VALUES (?,'fixture_json',?)`).run(id, now.toISOString());
    }
    await assert.rejects(service.reconcileNightlySourceReleaseFreshness({ database: binding, now }), /exceeded 32 published sources/u);
    assert.deepEqual(queue(db), []);
  } finally { db.close(); }
});

test("removed adapters retain a working source-release path through an empty registry", { skip: process.env.PUBLIC_RELEASE_FRESHNESS_EMPTY === "1" }, () => {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PUBLIC_RELEASE_FRESHNESS_EMPTY: "1" };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--import", "./scripts/node-runtime-preload.mjs", "--import", "tsx", "--test",
    "--test-name-pattern=^removed adapter child$", fileURLToPath(import.meta.url)], { env: childEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("removed adapter child", { skip: process.env.PUBLIC_RELEASE_FRESHNESS_EMPTY !== "1" }, async () => {
  const { db, binding } = await fixture();
  try {
    const { sourceRegistry } = await import("../../lib/sources/registry.ts");
    const { syncConfiguredSourceManifests } = await import("../../lib/settings/source-manifests.ts");
    assert.equal(sourceRegistry.size, 0);
    env.DB = binding;
    await syncConfiguredSourceManifests();
    db.exec(`INSERT INTO listing_details (listing_id,title_at_scrape,raw_description,clean_description,scraped_at,content_hash)
      VALUES ('fixture_html:one','Observed title','Observed description','Observed description','${now.toISOString()}','observed')`);
    const heads = db.prepare("SELECT * FROM source_inventory_publication_heads ORDER BY source_id").all();
    const stubs = db.prepare("SELECT * FROM listing_stubs ORDER BY id").all();
    const details = db.prepare("SELECT * FROM listing_details ORDER BY listing_id").all();
    change(db, "presentation_policy");
    assert.deepEqual((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).queuedSourceIds, sources);
    const snapshot = await service.readNightlySchedulerSnapshot({ database: binding, limit: 32,
      campaignId: "fixture-retained", coverageMode: "complete_current", includeSourceAcquisitions: false, now });
    assert.equal(snapshot.candidates.length, 2);
    assert.ok(snapshot.candidates.every((candidate) => candidate.sourceId === "scheduler_local" && candidate.stage === "source_release"));
    const candidate = snapshot.candidates[0]!;
    const item = candidate.workItem!;
    for (const sourceId of [null, "different_fixture"]) {
      await assert.rejects(service.reserveNightlySchedulerCandidate({ database: binding, now,
        candidate: { ...candidate, workItem: { ...item, sourceId } } }), /pipeline_work_identity_invalid/u);
    }
    const reservation = await service.reserveNightlySchedulerCandidate({ database: binding, candidate, now });
    assert.equal(reservation.laneKey, item.laneKey);
    const acquired = service.acquireNightlySchedulerCandidate({ candidate, reservation });
    assert.deepEqual(acquired, { kind: "local_commit" });
    const bundle = await service.validateNightlySchedulerAcquisition({ candidate, reservation, acquired });
    const priorProofs = db.prepare("SELECT * FROM source_review_release_proofs ORDER BY proof_id").all();
    for (const [column, value, original] of [
      ["revision", item.revision + 1, item.revision],
      ["lease_owner", "foreign-owner", reservation.queueClaim!.owner],
      ["lease_expires_at", "2000-01-01T00:00:00.000Z", reservation.expiresAt],
    ] as const) {
      db.prepare(`UPDATE pipeline_work_items SET ${column}=? WHERE stage='source_release' AND subject_id=?`).run(value, item.subjectId);
      await assert.rejects(service.commitNightlySchedulerCandidate({ database: binding, candidate, reservation, bundle, now }), /pipeline_work_claim_missed/u);
      assert.deepEqual(db.prepare("SELECT * FROM source_review_release_proofs ORDER BY proof_id").all(), priorProofs);
      db.prepare(`UPDATE pipeline_work_items SET ${column}=? WHERE stage='source_release' AND subject_id=?`).run(original, item.subjectId);
    }
    const telemetry = new PerformanceTelemetryBuffer({ now: () => now });
    const committed = await service.commitNightlySchedulerCandidate({ database: binding, candidate, reservation, bundle, now, telemetry });
    assert.equal(committed.kind, "outcome");
    const releaseEvents = telemetry.snapshot().events.filter((event) =>
      event.details.kind === "equivalence" || (event.details.kind === "stage" && event.details.stage === "source_release"));
    assert.equal(releaseEvents.length, 2);
    assert.ok(releaseEvents.every((event) => event.context.sourceId === item.sourceId));
    await drain(binding);
    assert.equal((await service.reconcileNightlySourceReleaseFreshness({ database: binding, now })).status, "settled");
    assert.deepEqual(db.prepare("SELECT * FROM source_inventory_publication_heads ORDER BY source_id").all(), heads);
    assert.deepEqual(db.prepare("SELECT * FROM listing_stubs ORDER BY id").all(), stubs);
    assert.deepEqual(db.prepare("SELECT * FROM listing_details ORDER BY listing_id").all(), details);
    db.exec(`INSERT INTO pipeline_work_items (stage,subject_type,subject_id,listing_id,source_id,lane_key,input_hash,reason_code,available_at)
      VALUES ('detail','listing','fixture_html:one','fixture_html:one','fixture_html','fixture','${hash("8")}','fixture','${now.toISOString()}')`);
    const dependent = await service.readNightlySchedulerSnapshot({ database: binding, limit: 32,
      campaignId: "fixture-dependent", coverageMode: "complete_current", includeSourceAcquisitions: false, now });
    await assert.rejects(service.reserveNightlySchedulerCandidate({ database: binding, candidate: dependent.candidates[0]!, now }), /source_policy_invalid/u);
    assert.equal(db.prepare("SELECT lease_owner FROM pipeline_work_items WHERE stage='detail'").get()?.lease_owner, null);
  } finally { delete env.DB; db.close(); }
});
