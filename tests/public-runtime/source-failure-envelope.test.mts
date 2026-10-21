import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { register } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { AcquiredSourcePage } from "../../lib/sources/acquired-pages.ts";
import type { SchedulerCallbackReceipt, SchedulerWorkOutcome } from "../../lib/scheduler/types.ts";

const revision = `sha256:${"c".repeat(64)}`;
const capability = "F".repeat(64);
const sourceId = "callback_fixture";
process.env.AUCTION_DISCOVERY_RUNTIME_REVISION = revision;
process.env.AUCTION_DISCOVERY_IMAGE_TOKEN = capability;
process.env.AUCTION_DISCOVERY_IMAGE_PORT = "32110";
process.env.AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID = "a".repeat(32);
process.env.ORIGIN_POSTAL_CODE = "90210";
process.env.ORIGIN_COUNTRY = "US";
const bindings: { DB?: D1Database; STORAGE?: R2Bucket; AUCTION_DISCOVERY_IMAGE_TOKEN: string } = {
  AUCTION_DISCOVERY_IMAGE_TOKEN: capability,
};
const fixtureState = { pages: [] as readonly AcquiredSourcePage[], captureCalls: 0, planFailure: null as string | null };
Object.assign(globalThis, { __publicSourceCallbackEnv: bindings, __publicSourceCallbackFixture: fixtureState });
const adapterFixture = new URL("./source-failure-adapters.fixture.mts", import.meta.url).href;
const browserFixture = new URL("./source-failure-browser.fixture.mts", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
  if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicSourceCallbackEnv;'};
  if(/source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(adapterFixture)}};
  if(/source-browser-acquisition(?:\\.ts)?$/.test(s) && c.parentURL.includes('/scripts/source-acquisition-service')) return {shortCircuit:true,url:${JSON.stringify(browserFixture)}};
  return n(s,c);
}`)}`, import.meta.url);
const api = await import("../../app/api/internal/source-acquisition/route.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { readSourceInventoryPublicationHead } = await import("../../lib/pipeline/storage.ts");
const { syncConfiguredSourceManifests } = await import("../../lib/settings/source-manifests.ts");
const service = await import("../../scripts/source-acquisition-service.ts");
const scheduler = await import("../../lib/scheduler/runtime-service.ts");
const { runNightlyScheduler } = await import("../../lib/scheduler/engine.ts");
const { sourceOrchestrationRegistry } = await import("../../lib/sources/orchestration.ts");
const { hashCanonicalJson } = await import("../../lib/performance/generations.ts");
const { sourceAdapterFailureEnvelope } = await import("../../lib/sources/failure-envelope.ts");
const { SourceAdapterError, SourceAccessChallengeError, SourceRetryableDiscoveryPageError, SourceRetryableIncompleteDetailError } = await import("../../lib/sources/types.ts");

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
  async all() { return this.execute(); }
  async first(column?: string) { const row = this.db.prepare(this.sql).get(...this.values); return row ? column ? row[column] : row : null; }
}
async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const database = {
    prepare(sql: string) { return new Statement(db, sql); },
    async batch(statements: Statement[]) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = statements.map((statement) => statement.execute()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  bindings.DB = database;
  bindings.STORAGE = { async put() { throw new Error("Image-free callback fixture must not write R2"); } } as unknown as R2Bucket;
  fixtureState.planFailure = null;
  fixtureState.captureCalls = 0;
  await ensureDatabase(database);
  await syncConfiguredSourceManifests();
  return { db, database };
}
async function pages(body: string): Promise<readonly AcquiredSourcePage[]> {
  const at = new Date(Date.now() - 50).toISOString();
  const bytes = new TextEncoder().encode(body);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [{ request: { kind: "discovery", url: "https://callback.fixture.invalid/inventory" },
    page: { url: "https://callback.fixture.invalid/inventory", fetchedAt: at, contentType: "text/html", body },
    startedAt: at, requestStartedAt: [at], requestBudgetCost: 2, bodySha256: digest }];
}
function callbackRequest(payload: unknown) {
  return new Request("http://localhost:3000/api/internal/source-acquisition", { method: "POST",
    headers: { "content-type": "application/json", "x-auction-discovery-capability": capability, "x-auction-discovery-runtime-revision": revision },
    body: JSON.stringify(payload) });
}
async function seed() {
  const response = await api.POST(callbackRequest({ action: "commit", sourceId,
    pages: await pages('<main><article data-id="one">Fixture instrument</article></main>'), trigger: "manual" }));
  assert.equal(response.status, 200, await response.clone().text());
}
const connection = { dashboardUrl: "http://localhost:3000", capability, runtimeRevision: revision, sourceId, mode: "catalog" as const };
const originalFetch = globalThis.fetch;
async function companionFailure(transform?: (response: Response, action: string) => Promise<Response>) {
  const actions: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "http://localhost:3000/api/internal/source-acquisition", "No source traffic is permitted");
    const action = (await request.clone().json() as { action: string }).action;
    actions.push(action);
    const response = await api.POST(request);
    return transform ? transform(response, action) : response;
  };
  try {
    await service.runLocalSourceAcquisition(connection);
    assert.fail("Malformed captured source inventory must stop before discovery creation");
  } catch (error) {
    assert.ok(error instanceof service.LocalSourceAcquisitionError);
    return { error, actions };
  } finally { globalThis.fetch = originalFetch; }
}
const structural = { category: "adapter_contract", reasonCode: "adapter_contract_failed" };
function assertNoNewRun(db: DatabaseSync, baseline: number) {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM discovery_runs").get()?.n, baseline);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM source_runs").get()?.n, baseline);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pipeline_run_lease").get()?.n, 0);
}

test("generic malformed captured HTML crosses the real pre-run callback as a source-bound structural stop", async () => {
  const { db } = await fixture();
  try {
    await seed();
    const head = await readSourceInventoryPublicationHead(sourceId);
    const baseline = Number(db.prepare("SELECT COUNT(*) n FROM discovery_runs").get()?.n);
    fixtureState.pages = await pages("<main><p>No recognized source inventory</p></main>");
    const { error, actions } = await companionFailure();
    assert.equal(error.code, "source_adapter_contract_failed", JSON.stringify({ actions, captureCalls: fixtureState.captureCalls, message: error.message }));
    assert.equal(error.sourceId, sourceId);
    assert.deepEqual(error.failure, structural);
    assert.equal(JSON.stringify(error).includes("Private fixture source text"), false);
    assert.equal(error.cause, undefined);
    assert.deepEqual(actions, ["plan", "commit"]);
    assert.equal(fixtureState.captureCalls, 1);
    assert.equal(error.message.includes("neither listings"), false);
    assert.deepEqual(await readSourceInventoryPublicationHead(sourceId), head);
    assertNoNewRun(db, baseline);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("structural metadata requires a real matching adapter error and leaves access or retryable errors separate", () => {
  assert.deepEqual(sourceAdapterFailureEnvelope(new SourceAdapterError(sourceId, "private sentinel"), sourceId), structural);
  for (const error of [
    new Error("private sentinel"), { sourceId, name: "SourceAdapterError", message: "private sentinel" },
    new SourceAdapterError("another_fixture", "private sentinel"),
    new SourceAccessChallengeError(sourceId, "private sentinel"),
    new SourceRetryableDiscoveryPageError(sourceId, "private sentinel"),
    new SourceRetryableIncompleteDetailError(sourceId, "private sentinel"),
  ]) assert.equal(sourceAdapterFailureEnvelope(error, sourceId), null);
});

test("only actual matching source adapter errors from plan or commit retain the strict envelope", async () => {
  const { db } = await fixture();
  try {
    fixtureState.planFailure = "structural";
    const { error, actions } = await companionFailure();
    assert.equal(error.code, "source_adapter_contract_failed");
    assert.deepEqual(error.failure, structural);
    assert.equal(error.message, "Source adapter rejected the captured inventory");
    assert.equal(JSON.stringify(error).includes("Private fixture source text"), false);
    assert.equal(error.stack?.includes("Private fixture source text"), false);
    assert.equal(error.cause, undefined);
    assert.deepEqual(actions, ["plan"]);
    assert.equal(fixtureState.captureCalls, 0);
    assertNoNewRun(db, 0);
    for (const mode of ["mismatched", "runtime"]) {
      fixtureState.planFailure = mode;
      const result = await companionFailure();
      assert.equal(result.error.code, "source_callback_rejected");
      assert.equal(result.error.failure, null);
      assert.deepEqual(result.actions, ["plan"]);
    }
  } finally { fixtureState.planFailure = null; globalThis.fetch = originalFetch; db.close(); }
});

test("malformed, extra-field and source-mismatched callback envelopes retain generic failure behavior", async () => {
  const { db } = await fixture();
  try {
    fixtureState.pages = await pages("<main></main>");
    const valid = { error: "Source adapter rejected the captured inventory", code: "source_adapter_contract_failed", sourceId, failure: structural };
    for (const body of [
      { ...valid, sourceId: "another_fixture" },
      { ...valid, failure: { ...structural, private: "sentinel" } },
      { ...valid, failure: { category: "adapter_contract", reasonCode: "other" } },
      { error: valid.error, code: valid.code, sourceId },
      { ...valid, code: "internal_error" },
      { ...valid, error: "Private fixture source text" },
      { ...valid, private: "sentinel" },
    ]) {
      const result = await companionFailure(async (response, action) => action === "commit" ? Response.json(body, { status: 422 }) : response);
      assert.equal(result.error.code, "source_callback_rejected");
      assert.equal(result.error.failure, null);
    }
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("the real companion serializer preserves the bounded failure and source attribution", async () => {
  const { db } = await fixture();
  const { server } = await import("../../scripts/local-companion-service.ts");
  fixtureState.planFailure = "structural";
  globalThis.fetch = async (input, init) => api.POST(new Request(input, init));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const body = JSON.stringify({ sourceId, mode: "catalog", trigger: "manual" });
      const pending = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/source-acquisition", method: "POST",
        headers: { host: "127.0.0.1:32110", origin: "http://localhost:3000", "content-type": "application/json",
          "x-auction-discovery-runtime-revision": revision, "content-length": Buffer.byteLength(body) } }, (response) => {
        let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
      }); pending.on("error", reject); pending.end(body);
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.code, "source_adapter_contract_failed");
    assert.equal(result.body.sourceId, sourceId);
    assert.deepEqual(result.body.failure, structural);
    assert.equal(JSON.stringify(result.body).includes("Private fixture source text"), false);
    assert.equal(fixtureState.captureCalls, 0);
    assertNoNewRun(db, 0);
  } finally {
    fixtureState.planFailure = null;
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("scheduler settlement stops a structural source once while preserving prior head and releases exact ownership", async () => {
  const { db, database } = await fixture();
  try {
    await seed();
    const priorHead = await readSourceInventoryPublicationHead(sourceId);
    const baseline = Number(db.prepare("SELECT COUNT(*) n FROM discovery_runs").get()?.n);
    const now = new Date(Date.now() + 20 * 60 * 60_000);
    const snapshot = await scheduler.readNightlySchedulerSnapshot({ database, limit: 100, campaignId: "structural-fixture", coverageMode: "complete_current", includeSourceAcquisitions: true, now });
    const candidate = snapshot.candidates.find((entry) => entry.kind === "source_acquisition" && entry.sourceId === sourceId)!;
    assert.ok(candidate);
    const body = { error: "Source adapter rejected the captured inventory", code: "source_adapter_contract_failed", sourceId,
      upstreamCode: "source_adapter_contract_failed", upstreamError: null, upstreamDiagnostic: null, retryAfterMs: null, failure: structural };
    const receipt: SchedulerCallbackReceipt = { status: 422, body, responseHash: await hashCanonicalJson(body) };
    let dispatches = 0;
    let settled: SchedulerWorkOutcome | undefined;
    const result = await runNightlyScheduler({
      workSource: { async readSnapshot() { return { generation: "fixed-fixture", candidates: [candidate], boundedReadCount: 1 }; } },
      handlerRegistry: { handlers: new Map(), resolve: () => ({ id: `source:${sourceId}`, ready: true, readinessReasonCode: null,
        reserve: (entry) => scheduler.reserveNightlySchedulerCandidate({ database, candidate: entry, now }),
        acquire: (entry, reservation) => { dispatches += 1; return Promise.resolve(scheduler.acquireNightlySchedulerCandidate({ candidate: entry, reservation })); },
        validate: (entry, reservation, acquired) => scheduler.validateNightlySchedulerAcquisition({ candidate: entry, reservation, acquired }),
        async commit(entry, reservation, bundle) {
          const committed = await scheduler.commitNightlySchedulerCandidate({ database, candidate: entry, reservation, bundle, receipt, now });
          assert.equal(committed.kind, "outcome");
          if (committed.kind !== "outcome") throw new Error("Missing fixture outcome");
          const duplicate = await scheduler.commitNightlySchedulerCandidate({ database, candidate: entry, reservation, bundle, receipt, now });
          assert.deepEqual(duplicate, committed, "A lost finalizer response must not change terminal settlement");
          settled = committed.outcome; return committed.outcome;
        },
      }) },
      options: { maxDispatches: 5, sourceCampaignPolicies: sourceOrchestrationRegistry, now: () => now, sleep: async () => { throw new Error("Structural failure cannot retry after cooldown"); } },
    });
    assert.equal(dispatches, 1);
    assert.equal(settled?.classification, "no_progress");
    assert.equal(result.sourceOutcomes[0]?.outcome, "preserved");
    assert.equal(result.sourceOutcomes[0]?.reasonCode, "source_adapter_contract_failed");
    assert.deepEqual(await readSourceInventoryPublicationHead(sourceId), priorHead);
    assertNoNewRun(db, baseline);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM source_acquisition_reservations WHERE state IN ('reserved','acquired')").get()?.n, 0);
  } finally { db.close(); }
});

test("scheduler rejects malformed or mismatched structural metadata and retains generic bounded retry", async () => {
  const valid = { error: "Source adapter rejected the captured inventory", code: "source_adapter_contract_failed", sourceId, failure: structural };
  for (const [name, body, status] of [
    ["source mismatch", { ...valid, sourceId: "another_fixture" }, 422],
    ["malformed envelope", { ...valid, failure: { ...structural, extra: true } }, 422],
    ["unexpected response field", { ...valid, private: "sentinel" }, 422],
    ["untrusted upstream text", { ...valid, upstreamError: "sentinel" }, 422],
    ["ordinary callback", { error: "Source callback rejected the acquisition", code: "source_callback_rejected", sourceId }, 500],
    ["wrong status", valid, 500],
  ] as const) {
    const { db, database } = await fixture();
    try {
      await seed();
      const priorHead = await readSourceInventoryPublicationHead(sourceId);
      const now = new Date(Date.now() + 20 * 60 * 60_000);
      const snapshot = await scheduler.readNightlySchedulerSnapshot({ database, limit: 100, campaignId: `negative-${name.replaceAll(" ", "-")}`, coverageMode: "complete_current", includeSourceAcquisitions: true, now });
      const candidate = snapshot.candidates.find((entry) => entry.kind === "source_acquisition" && entry.sourceId === sourceId)!;
      assert.ok(candidate, name);
      const reservation = await scheduler.reserveNightlySchedulerCandidate({ database, candidate, now });
      const acquired = scheduler.acquireNightlySchedulerCandidate({ candidate, reservation });
      const bundle = await scheduler.validateNightlySchedulerAcquisition({ candidate, reservation, acquired });
      const receipt = { status, body, responseHash: await hashCanonicalJson(body) };
      const result = await scheduler.commitNightlySchedulerCandidate({ database, candidate, reservation, bundle, receipt, now });
      assert.equal(result.kind, "outcome", name);
      if (result.kind !== "outcome") throw new Error("Missing negative fixture outcome");
      assert.equal(result.outcome.classification, "retryable_pressure", name);
      assert.deepEqual(await readSourceInventoryPublicationHead(sourceId), priorHead, name);
      assertNoNewRun(db, 1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM source_acquisition_reservations WHERE state IN ('reserved','acquired')").get()?.n, 0, name);
    } finally { db.close(); }
  }
});
