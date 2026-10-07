import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseRepairArgs, repairMain } from "../../scripts/source-repair-sandbox.mts";
import { fixture, projectRoot } from "./entrypoint-fixtures.mts";

const since = "2026-01-01T00:00:00.000Z"; const until = "2026-01-01T01:00:00.000Z"; const job = "a".repeat(64);
test("CLI accepts bounded preparation, inspection and saved-job testing forms", () => {
  assert.deepEqual(parseRepairArgs(["prepare", "--since", since, "--until", until, "--limit", "1", "--quiet"]),
    { action: "prepare", since, until, job: undefined, limit: 1, quiet: true });
  assert.equal(parseRepairArgs(["inspect"]).action, "inspect");
  assert.equal(parseRepairArgs(["inspect", "--job", job]).job, job);
  assert.equal(parseRepairArgs(["test", "--job", job]).job, job);
});
for (const [name, args] of [
  ["missing invocation bounds", ["run"]], ["reversed interval", ["run", "--since", until, "--until", since]],
  ["unbounded interval", ["prepare", "--since", since, "--until", "2026-01-02T00:00:00Z"]],
  ["job path traversal", ["inspect", "--job", "../job"]], ["test without a job", ["test"]],
  ["unexpected bounds on inspection", ["inspect", "--since", since]], ["invalid generation limit", ["run", "--since", since, "--until", until, "--limit", "3"]],
  ["duplicate arguments", ["inspect", "--quiet", "--quiet"]], ["unknown command", ["promote"]],
] as const) test(`CLI rejects ${name} before processing`, () => assert.throws(() => parseRepairArgs([...args])));

test("inspection of a disposable empty store performs no source or model operation", async () => fixture(async (root) => {
  const result = await repairMain(["inspect", "--quiet"], root, {});
  assert.deepEqual(result, { schemaVersion: "source-repair-inspection-v1", proposalOnly: true, jobs: [] });
}));

async function diagnosticFixture(root: string) {
  const target = "source-adapters.local/example-json"; await mkdir(join(root, target), { recursive: true });
  for (const name of ["adapter.ts", "adapter.test.ts", "fixture.json"]) await copyFile(join(projectRoot, "examples/source-repair", name), join(root, target, name));
  await writeFile(join(root, "source-repair.config.local.json"), JSON.stringify({ schemaVersion: "source-repair-config-v1", targets: [{ sourceId: "example_json", adapterPath: `${target}/adapter.ts`, testFiles: [`${target}/adapter.test.ts`], files: [`${target}/fixture.json`] }] }));
  const directory = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"); await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "fixture.sqlite"));
  try {
    database.exec(`CREATE TABLE source_runs (id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT, completed_at TEXT, error_code TEXT, error_message TEXT, status TEXT);
      CREATE TABLE source_acquisition_reservations (reservation_id TEXT, source_id TEXT, failure_code TEXT, failure_fingerprint TEXT, updated_at TEXT, created_at TEXT, state TEXT);`);
    database.prepare("INSERT INTO source_runs VALUES (?,?,?,?,?,?,?)").run("12345678-1234-4234-8234-123456789abc", "example_json", since, until, "SourceAdapterError", "Example listing description must be a string.", "failed");
  } finally { database.close(); }
}
for (const action of ["prepare", "run"] as const) test(`${action} preserves diagnostics without a provider call when inference is disabled`, async () => fixture(async (root) => {
  await diagnosticFixture(root); let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500); response.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const originalConfig = await readFile(join(root, "source-repair.config.local.json"));
  try {
    const result = await repairMain([action, "--since", since, "--until", until, "--quiet"], root, {
      SOURCE_REPAIR_ENABLED: action === "prepare" ? "1" : "0", SOURCE_REPAIR_MODEL: "fixture-local:latest", SOURCE_REPAIR_OLLAMA_URL: `http://127.0.0.1:${address.port}`,
      API_TOKEN: "never_return_fixture_canary",
    }) as { proposalOnly: boolean; attempted: number; created: number; jobs: Array<{ sourceId: string; state: string }> };
    assert.equal(result.proposalOnly, true); assert.equal(result.attempted, 0); assert.ok(result.created > 0);
    assert.ok(result.jobs.every((item) => item.sourceId === "example_json")); assert.ok(result.jobs.some((item) => item.state === "prepared"));
    assert.equal(requests, 0); assert.ok(!JSON.stringify(result).includes("never_return_fixture_canary"));
    assert.deepEqual(await readFile(join(root, "source-repair.config.local.json")), originalConfig);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}));
