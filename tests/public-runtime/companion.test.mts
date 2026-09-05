import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const revision = `sha256:${"a".repeat(64)}`;
const supervisor = "b".repeat(32);
const capability = "C".repeat(64);
process.env.AUCTION_DISCOVERY_RUNTIME_REVISION = revision;
process.env.AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID = supervisor;
process.env.AUCTION_DISCOVERY_IMAGE_TOKEN = capability;
process.env.AUCTION_DISCOVERY_IMAGE_PORT = "32110";
for (const name of ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"]) delete process.env[name];
const { server, parseSourceAcquisitionBody } = await import("../../scripts/local-companion-service.ts");
const { parseNightlyWorkflowStatus, readTerminalNightlyManifest, buildNightlyVisibleCommand } = await import("../../scripts/nightly-visible-control.ts");
const { listSourceManifests } = await import("../../lib/sources/registry.ts");

test("neutral companion enforces Host, origin, capability and revision boundaries over real loopback HTTP", async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const send = (path: string, method = "GET", headers: Record<string, string> = {}, body = "") => new Promise<{status: number, payload: Record<string, unknown>}>((resolve, reject) => {
    const pending = request({ hostname: "127.0.0.1", port: address.port, path, method,
      headers: { host: "127.0.0.1:32110", ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, payload: text ? JSON.parse(text) : {} }));
    });
    pending.on("error", reject);
    pending.end(body);
  });
  try {
    const health = await send("/v1/health");
    assert.equal(health.status, 200);
    assert.equal(health.payload.runtimeRevision, revision);
    assert.equal(health.payload.supervisorInstanceId, supervisor);
    assert.equal(health.payload.active, false);
    assert.equal(health.payload.preferenceV2ScoringActive, false);
    assert.equal((await send("/v1/health", "GET", { host: "outside.invalid" })).status, 403);
    assert.equal((await send("/v1/nightly-run", "POST", { origin: "https://outside.invalid" })).status, 403);
    assert.equal((await send("/v1/nightly-run", "POST", { origin: "http://localhost:3000" })).payload.code, "runtime_revision_unavailable");
    assert.equal((await send("/v1/shutdown", "POST", { origin: "http://localhost:3000" })).status, 403);
    assert.equal((await send("/v1/source-acquisition", "POST", { "x-auction-discovery-capability": capability })).payload.code, "runtime_revision_mismatch");
    const staging = { "x-auction-discovery-capability": capability, "x-auction-discovery-runtime-revision": revision, "content-type": "application/json" };
    assert.equal((await send("/v1/enrichment-staged-generation", "POST", staging, "{}")).payload.code, "enrichment_not_configured");
    assert.equal((await send("/v1/preference-v2-score", "POST", staging, "{}")).status, 404);
    const schedule = await send("/v1/schedule", "PUT", { origin: "http://localhost:3000", "content-type": "application/json" }, '{"weekdays":[],"localTime":"99:99"}');
    assert.equal(schedule.payload.code, "invalid_schedule_time");
    assert.equal((await send("/v1/health")).payload.scheduleMutationActive, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an empty registration supports truthful completed workflow progress and rejects invented source IDs", () => {
  assert.equal(listSourceManifests().length, 0, "Run the public baseline checks with the default empty adapter configuration");
  const status = {
    stage: "complete", workflowState: "completed", sourceOutcomes: [],
    sourceOutcomeCounts: { refreshed: 0, skipped_recent: 0, preserved: 0, paused: 0, stopped: 0, blocked: 0 },
  };
  assert.equal(parseNightlyWorkflowStatus(JSON.stringify(status)).workflowState, "completed");
  assert.equal(parseNightlyWorkflowStatus(JSON.stringify({ ...status, sourceOutcomes: [{ sourceId: "unregistered_source" }] })).workflowState, null);
  assert.equal(parseSourceAcquisitionBody(JSON.stringify({ sourceId: "unregistered_source", mode: "catalog", trigger: "manual" })), null);
});

test("completed-run recovery uses checkout-local exact receipts and rejects process mismatch or ambiguous history", async () => {
  const parent = resolve(fileURLToPath(new URL("../../", import.meta.url)), ".wrangler", "public-runtime-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "recovery-"));
  const registry = resolve(directory, ".wrangler", "logs", "discovery-runners");
  mkdirSync(registry, { recursive: true });
  const created = "2026-01-01T00:00:00.000Z";
  const started = "2026-01-01T00:00:01.000Z";
  const ended = "2026-01-01T00:00:03.000Z";
  const status = { schemaVersion: "auction-discovery-nightly-status-v1", processId: 1234,
    state: "completed", runtimeRevision: revision, startedAt: started, endedAt: ended, updatedAt: ended };
  const receipt = (id: string) => ({ id, project: "auction-discovery", task: "dashboard", activity: "nightly-discovery",
    command: buildNightlyVisibleCommand(directory, revision), working_directory: directory,
    manifest_path: resolve(registry, `${id}.json`), runner_pid: 1234, state: "completed", exit_code: 0,
    created_at: created, runner_started_at: started, ended_at: ended, updated_at: ended });
  const first = receipt("1".repeat(32));
  const duplicate = receipt("2".repeat(32));
  try {
    writeFileSync(first.manifest_path, JSON.stringify(first));
    writeFileSync(duplicate.manifest_path, JSON.stringify(duplicate));
    assert.equal(await readTerminalNightlyManifest(directory, JSON.stringify(status)), null);
    rmSync(duplicate.manifest_path);
    assert.equal(await readTerminalNightlyManifest(directory, JSON.stringify({ ...status, processId: 1235 })), null);
    assert.equal((await readTerminalNightlyManifest(directory, JSON.stringify(status)))?.id, first.id);
    writeFileSync(first.manifest_path, JSON.stringify({ ...first, command: "invalid command" }));
    assert.equal(await readTerminalNightlyManifest(directory, JSON.stringify(status)), null);
  } finally {
    assert.ok(directory.startsWith(`${parent}${sep}`));
    rmSync(directory, { recursive: true, force: true });
  }
});
