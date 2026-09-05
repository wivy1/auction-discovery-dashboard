import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { register } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const revision = `sha256:${"d".repeat(64)}`;
const nonemptyFixture = process.env.PUBLIC_NIGHTLY_NONEMPTY_FIXTURE === "1";
process.env.AUCTION_DISCOVERY_RUNTIME_REVISION = revision;
delete process.env.PERF_FORCE_CANONICAL;
const bindings: { DB?: D1Database; STORAGE?: R2Bucket } = {};
Object.assign(globalThis, { __publicNightlyTestEnv: bindings });
const fixtureModule = new URL("./nightly-adapters.fixture.mts", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
  if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicNightlyTestEnv;'};
  if(${nonemptyFixture} && /source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(fixtureModule)}};
  return n(s,c);
}`)}`, import.meta.url);

const api = await import("../../app/api/internal/nightly-scheduler/route.ts");
const { parseNightlySchedulerArgs, runNightlySchedulerCli, readNightlySchedulerReadiness,
  corePreparationSettlementReserveMs } = await import("../../scripts/nightly-scheduler.mts");
const { SchedulerRuntimeAuthorizationRegistry, schedulerRuntimeAuthorizationRegistry,
  NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER } = await import("../../lib/scheduler/runtime-authorization.ts");
const { NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION } = await import("../../lib/scheduler/runtime-adapter.ts");
const headers = { "x-auction-discovery-runtime-revision": revision, "content-type": "application/json" };

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly database: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const statement = this.database.prepare(this.sql);
    if (statement.columns().length > 0) return { success: true, results: statement.all(...this.values), meta: {} };
    return { success: true, results: [], meta: { changes: Number(statement.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async first(column?: string) {
    const row = this.database.prepare(this.sql).get(...this.values);
    return row ? column ? row[column] : row : null;
  }
}

function database(): DatabaseSync {
  const connection = new DatabaseSync(":memory:");
  connection.exec("PRAGMA foreign_keys=ON");
  bindings.DB = {
    prepare(sql: string) { return new Statement(connection, sql); },
    async batch(statements: Statement[]) {
      connection.exec("BEGIN IMMEDIATE");
      try { const result = statements.map((statement) => statement.execute()); connection.exec("COMMIT"); return result; }
      catch (error) { connection.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return connection;
}

test("nightly coverage and authorization accept only the generic complete-current boundary", async () => {
  assert.throws(() => parseNightlySchedulerArgs(["--discovery-frontier"]), /unsupported/);
  assert.throws(() => parseNightlySchedulerArgs(["--performance", "--scenario", "frontier"]), /scenario/);
  assert.equal(parseNightlySchedulerArgs(["--complete-current-audit"]).completeCurrentAudit, true);
  const unsupportedCanonical = readNightlySchedulerReadiness(parseNightlySchedulerArgs(["--mode", "canonical"]));
  assert.equal(unsupportedCanonical.ready, false, "Removed legacy fallback must not advertise readiness");
  for (const canonicalArgs of [["--mode", "canonical"], []]) {
    let callbackAttempts = 0;
    const unavailable = await runNightlySchedulerCli([...canonicalArgs, "--runtime-revision", revision,
      "--workflow-deadline-at", new Date(Date.now() + 5 * 60 * 60_000).toISOString()], {
      environment: canonicalArgs.length === 0 ? { PERF_FORCE_CANONICAL: "true" } : {},
      request: async () => { callbackAttempts += 1; throw new Error("Unsupported canonical mode must never dispatch a callback"); },
    });
    assert.equal(unavailable.exitCode, 3);
    assert.equal(callbackAttempts, 0);
  }
  const ordinaryCoreGuard = corePreparationSettlementReserveMs({ sourceId: "fixture_a", stage: "primary_image" });
  assert.equal(corePreparationSettlementReserveMs({ sourceId: "fixture_b", stage: "primary_image" }), ordinaryCoreGuard);
  assert.ok(corePreparationSettlementReserveMs({ sourceId: "fixture_a", stage: "proximity" }) > ordinaryCoreGuard);
  const registry = new SchedulerRuntimeAuthorizationRegistry({ randomToken: () => "e".repeat(64) });
  assert.throws(() => registry.issue({ campaignId: "fixture", coverageMode: "unsupported" as never, includeSourceAcquisitions: true }), /coverage/);
  const binding = { campaignId: "fixture", coverageMode: "auto" as const, includeSourceAcquisitions: true };
  const token = registry.issue(binding);
  assert.equal(registry.authorize(token, binding), true);
  assert.equal(registry.transitionToPreparation(token, binding)?.includeSourceAcquisitions, false);
  assert.equal(registry.authorize(token, binding), false);
  const rejected = await api.GET(new Request("http://localhost:3000/api/internal/nightly-scheduler?limit=1&campaignId=fixture&coverageMode=discovery_frontier", { headers }));
  assert.equal(rejected.status, 400);
  const removedAction = await api.POST(new Request("http://localhost:3000/api/internal/nightly-scheduler", { method: "POST", headers,
    body: JSON.stringify({ schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION, action: "read_frontier_snapshot_chunk" }) }));
  assert.equal(removedAction.status, 400);
  assert.equal((await api.GET(new Request("https://outside.invalid/api/internal/nightly-scheduler", { headers }))).status, 403);
  assert.equal((await api.GET(new Request("http://localhost:3000/api/internal/nightly-scheduler"))).status, 409);
});

test("ordinary nightly CLI completes through the real loopback API with fresh empty SQLite and no source or model callbacks", { timeout: 20_000 }, async () => {
  const connection = database();
  schedulerRuntimeAuthorizationRegistry.reset();
  const paths: string[] = [];
  const actions: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      paths.push(incoming.url ?? "");
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      if (body) actions.push(String(JSON.parse(body).action));
      const request = new Request(`http://localhost${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) });
      const response = incoming.method === "GET" ? await api.GET(request) : await api.POST(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const auto = await api.GET(new Request("http://localhost:3000/api/internal/nightly-scheduler?limit=1&campaignId=auto-fixture&coverageMode=auto&includeSourceAcquisitions=true", { headers }));
    const autoBody = await auto.json() as { ready?: boolean; authorizationToken?: string; error?: string };
    assert.equal(auto.status, 200, JSON.stringify(autoBody));
    assert.equal(autoBody.ready, true);
    const rejectedScore = await api.POST(new Request("http://localhost:3000/api/internal/nightly-scheduler", { method: "POST",
      headers: { ...headers, [NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER]: autoBody.authorizationToken! },
      body: JSON.stringify({ schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION, action: "reserve", candidate: { kind: "preparation", stage: "preference_v2_score" } }) }));
    assert.equal(rejectedScore.status, 400);
    schedulerRuntimeAuthorizationRegistry.reset();
    const result = await runNightlySchedulerCli(["--base-url", `http://localhost:${address.port}`, "--runtime-revision", revision,
      "--workflow-deadline-at", new Date(Date.now() + 5 * 60 * 60_000).toISOString()], { signal: abort.signal });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    const output = result.output as { classification: string; result: { sourceOutcomes: unknown[] } };
    assert.ok(["clean_empty", "deterministic_terminal"].includes(output.classification), JSON.stringify(output));
    assert.deepEqual(output.result.sourceOutcomes, []);
    assert.ok(paths.every((path) => path.startsWith("/api/internal/nightly-scheduler")), JSON.stringify(paths));
    assert.ok(actions.includes("transition_to_preparation"), JSON.stringify(actions));
    assert.ok(actions.includes("record_execution_evidence"), JSON.stringify(actions));
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    schedulerRuntimeAuthorizationRegistry.reset();
    connection.close();
  }
});

test("nonempty generic nightly publishes one factual Unrated listing and releases exact ownership", { timeout: 55_000 }, async () => {
  if (!nonemptyFixture) {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, PUBLIC_NIGHTLY_NONEMPTY_FIXTURE: "1" };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = await promisify(execFile)(process.execPath, [
      "--import", new URL("../../scripts/node-runtime-preload.mjs", import.meta.url).href,
      "--import", "tsx", "--test", "--test-name-pattern=nonempty generic nightly", fileURLToPath(import.meta.url),
    ], { env: childEnvironment, timeout: 45_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    assert.match(child.stdout, /pass 1/u, child.stdout);
    return;
  }

  process.env.ORIGIN_POSTAL_CODE = "90210";
  process.env.ORIGIN_COUNTRY = "US";
  for (const key of ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"]) delete process.env[key];
  const connection = database();
  bindings.STORAGE = { async put(key: string) { throw new Error(`The image-free fixture must not publish an object: ${key}`); } } as unknown as R2Bucket;
  schedulerRuntimeAuthorizationRegistry.reset();
  const runs = await import("../../app/api/runs/route.ts");
  const proximity = await import("../../app/api/proximity/route.ts");
  const { readSourceInventoryPublicationHead } = await import("../../lib/pipeline/storage.ts");
  const { readDashboardPayload } = await import("../../db/dashboard.ts");
  const originalFetch = globalThis.fetch;
  const sourceCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    sourceCalls.push(url);
    assert.equal(url, "https://nightly.fixture.test/inventory", "Only the registered fixture inventory may be fetched");
    return Response.json({ total: 1, items: [{ id: "one", title: "Observed fixture instrument", description: "Observed immutable instrument description" }] });
  };

  const events: string[] = [];
  const responses: { path: string; status: number; body: string }[] = [];
  let callbackPublishedHead: Awaited<ReturnType<typeof readSourceInventoryPublicationHead>> = null;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body ? JSON.parse(body) as { action?: string; kind?: string } : {};
      events.push(path === "/api/internal/nightly-scheduler" ? payload.action ?? "snapshot" : `${path}:${payload.kind ?? "callback"}`);
      const request = new Request(`http://localhost${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) });
      const response = path === "/api/internal/nightly-scheduler"
        ? incoming.method === "GET" ? await api.GET(request) : await api.POST(request)
        : path === "/api/runs" ? await runs.POST(request)
        : path === "/api/proximity" ? await proximity.POST(request)
        : Response.json({ error: `Unexpected fixture callback ${path}` }, { status: 500 });
      if (path === "/api/runs" && payload.kind === "source_discovery") {
        callbackPublishedHead = await readSourceInventoryPublicationHead("nightly_fixture");
      }
      const text = await response.text();
      responses.push({ path, status: response.status, body: text });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(text);
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://localhost:${address.port}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25_000);
  try {
    const runCampaign = () => runNightlySchedulerCli(["--base-url", origin, "--runtime-revision", revision,
      "--workflow-deadline-at", new Date(Date.now() + 5 * 60 * 60_000).toISOString()], {
      signal: abort.signal,
      sleep: (milliseconds) => new Promise<void>((resolve, reject) => {
        if (abort.signal.aborted) { reject(new Error("Nonempty fixture exceeded its bounded workflow check")); return; }
        const onAbort = () => { clearTimeout(pause); reject(new Error("Nonempty fixture exceeded its bounded workflow check")); };
        const pause = setTimeout(() => { abort.signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
        abort.signal.addEventListener("abort", onAbort, { once: true });
      }),
      // Exercise actual HTTP while preventing any accidental fixed-port request
      // to another installation; source fetch interception is separate above.
      request: async (input) => {
        assert.equal(new URL(input.url).origin, origin, "The fixture may contact only its own loopback server");
        const response = await originalFetch(input.url, { method: input.method, headers: { ...input.headers, "content-type": "application/json" },
          ...(input.body ? { body: JSON.stringify(input.body) } : {}), signal: input.signal });
        return { status: response.status, body: await response.json() };
      },
    });
    const initialized = await api.GET(new Request(`${origin}/api/internal/nightly-scheduler?limit=1&campaignId=disabled-fixture&coverageMode=auto&includeSourceAcquisitions=true`, { headers }));
    assert.equal(initialized.status, 200, await initialized.text());
    connection.prepare("UPDATE auction_sources SET enabled=0 WHERE id='nightly_fixture'").run();
    schedulerRuntimeAuthorizationRegistry.reset();
    const disabled = await runCampaign();
    assert.equal(disabled.exitCode, 0, JSON.stringify(disabled.output));
    const disabledOutput = disabled.output as { readiness: { sourceCount: number }; result: { sourceOutcomes: unknown[] } };
    assert.equal(disabledOutput.readiness.sourceCount, 0);
    assert.deepEqual(disabledOutput.result.sourceOutcomes, []);
    assert.deepEqual(sourceCalls, [], "A disabled registration must not acquire source evidence");
    assert.ok(events.every((event) => !event.startsWith("/api/")), JSON.stringify(events));
    assert.equal(await readSourceInventoryPublicationHead("nightly_fixture"), null);
    const driftSnapshot = await api.GET(new Request(`${origin}/api/internal/nightly-scheduler?limit=1&campaignId=source-population-drift&coverageMode=auto&includeSourceAcquisitions=true`, { headers }));
    const driftBinding = await driftSnapshot.json() as { authorizationToken?: string };
    assert.equal(driftSnapshot.status, 200);
    connection.prepare("UPDATE auction_sources SET enabled=1 WHERE id='nightly_fixture'").run();
    const driftTransition = await api.POST(new Request(`${origin}/api/internal/nightly-scheduler`, { method: "POST",
      headers: { ...headers, [NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER]: driftBinding.authorizationToken! },
      body: JSON.stringify({ schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION, action: "transition_to_preparation", sourceOutcomes: [] }) }));
    assert.equal(driftTransition.status, 400, "Enabling a source must reject the prior campaign's empty terminal vector");
    schedulerRuntimeAuthorizationRegistry.reset();
    events.length = 0;
    responses.length = 0;
    const result = await runCampaign();
    const diagnostic = JSON.stringify({ output: result.output, events, responses: responses.filter(({ status }) => status >= 400) });
    assert.equal(result.exitCode, 0, diagnostic);
    const output = result.output as { classification: string; result: { sourceOutcomes: { sourceId: string; outcome: string }[] } };
    assert.ok(["clean_empty", "deterministic_terminal"].includes(output.classification), diagnostic);
    assert.equal(output.result.sourceOutcomes[0]?.sourceId, "nightly_fixture", diagnostic);
    assert.equal(output.result.sourceOutcomes[0]?.outcome, "refreshed", diagnostic);
    assert.ok(callbackPublishedHead, "The acquisition callback must publish before scheduler commit");
    const head = await readSourceInventoryPublicationHead("nightly_fixture");
    assert.equal(head?.listingCount, 1);
    assert.deepEqual(head, callbackPublishedHead);
    const callbackIndex = events.indexOf("/api/runs:source_discovery");
    assert.ok(events.indexOf("reserve") >= 0 && events.indexOf("reserve") < callbackIndex, diagnostic);
    assert.ok(events.indexOf("commit", callbackIndex + 1) > callbackIndex, diagnostic);
    assert.ok(events.indexOf("transition_to_preparation") > callbackIndex, diagnostic);
    assert.ok(events.includes("/api/proximity:callback"), diagnostic);
    assert.ok(events.includes("record_execution_evidence"), diagnostic);
    assert.deepEqual(sourceCalls, ["https://nightly.fixture.test/inventory"]);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM source_current_listings WHERE source_id='nightly_fixture'").get()?.n, 1);
    assert.equal(connection.prepare("SELECT clean_description FROM listing_details").get()?.clean_description, "Observed immutable instrument description");
    assert.equal(connection.prepare("SELECT count(*) AS n FROM pipeline_run_lease WHERE expires_at > ?").get(new Date().toISOString())?.n, 0);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM source_acquisition_reservations WHERE state IN ('reserved','acquired')").get()?.n, 0);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM pipeline_work_items WHERE lease_owner IS NOT NULL").get()?.n, 0);
    const dashboard = await readDashboardPayload("unvoted", "unfiltered");
    assert.equal(dashboard.listings.length, 1, JSON.stringify({ dashboard, diagnostic,
      workItems: connection.prepare("SELECT * FROM pipeline_work_items").all() }));
    assert.equal(dashboard.listings[0]?.title, "Observed fixture instrument");
    assert.equal(dashboard.listings[0]?.cleanDescription, "Observed immutable instrument description");
    assert.equal(dashboard.listings[0]?.recommendation, null, "No private model or synthetic rating may appear");
    assert.equal(dashboard.listings[0]?.voteReady, true, "The factual unrated listing must be reviewable");
    assert.deepEqual(connection.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    schedulerRuntimeAuthorizationRegistry.reset();
    connection.close();
  }
});
