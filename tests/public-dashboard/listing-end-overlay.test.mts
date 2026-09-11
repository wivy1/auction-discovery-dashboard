import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ensureDatabase } from "../../db/bootstrap.ts";
import { markListingsEnded, readListingEndOverrides } from "../../db/listing-end-state.ts";

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
class Database {
  beforeBatch: (() => void) | null = null;
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: Statement[]) {
    this.beforeBatch?.();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(statement => statement.execute());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}

const sourceText = readFileSync(new URL("../../db/dashboard.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("dashboard.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(["readDashboardPayload", "readDashboardPayloadForReleasePrimeAudit", "overlayListingEndState"]);
const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text));
assert.equal(functions.length, 3, "all production cache/overlay wrappers are extracted");
const code = ts.transpileModule(functions.map(node => node.getText(source).replace(/^export\s+/, "")).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test("production dashboard and audit wrappers overlay freshly persisted state on a frozen cache hit", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = new Database(sqlite);
  const db = adapter.binding();
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    await ensureDatabase(db);
    sqlite.exec(`INSERT INTO auction_sources (id, display_name, base_url, enabled, permission_status, pickup_location_visibility)
      VALUES ('fixture', 'Fixture', 'https://example.invalid', 1, 'allowed', 'listing');
      INSERT INTO listing_stubs (id, source_id, source_listing_id, source_url, title, discovered_at, content_hash)
      VALUES ('fixture:one', 'fixture', 'one', 'https://example.invalid/one', 'Original source title', '2026-09-11T12:00:00.000Z', 'source-hash');
      INSERT INTO listing_votes (listing_id, value, created_at, updated_at)
      VALUES ('fixture:one', 'interested', '2026-09-11T12:00:00.000Z', '2026-09-11T12:00:00.000Z');`);
    const cachedListing = Object.freeze({ id: "fixture:one", title: "Original source title", closesAt: "", vote: "interested", markedEndedAt: null });
    const cachedPayload = Object.freeze({ listings: Object.freeze([cachedListing]), marker: "cached canonical payload" });
    const originalPayload = JSON.stringify(cachedPayload);
    const before = JSON.stringify([
      sqlite.prepare("SELECT * FROM listing_stubs").all(), sqlite.prepare("SELECT * FROM listing_votes").all(),
      sqlite.prepare("SELECT * FROM pipeline_generation_state").all(), sqlite.prepare("SELECT * FROM pipeline_work_items").all(),
    ]);
    let cacheHits = 0;
    const api = runInNewContext(`${code}\n({ readDashboardPayload, readDashboardPayloadForReleasePrimeAudit })`, {
      env: { DB: db },
      readListingEndOverrides,
      dashboardReleaseReadDecision: async () => ({ decision: "optimized", vector: {} }),
      readDashboardReleaseVector: async () => ({}),
      readWithDashboardReleasePrime: async () => { cacheHits += 1; return { payload: cachedPayload, path: "optimized_hit" }; },
      readCanonicalDashboardPayload: async () => { throw new Error("a cache hit must not reconstruct source payload"); },
    }) as {
      readDashboardPayload: () => Promise<{ listings: { markedEndedAt: string | null }[] }>;
      readDashboardPayloadForReleasePrimeAudit: () => Promise<{ path: string; payload: { listings: { markedEndedAt: string | null }[] } }>;
    };
    assert.equal((await api.readDashboardPayload()).listings[0]!.markedEndedAt, null);
    assert.equal((await api.readDashboardPayloadForReleasePrimeAudit()).payload.listings[0]!.markedEndedAt, null);
    const saved = await markListingsEnded(db, ["fixture:one"]);
    const markedAt = saved.outcomes[0]!.markedEndedAt;
    assert.ok(markedAt);
    const fresh = await api.readDashboardPayload();
    const audit = await api.readDashboardPayloadForReleasePrimeAudit();
    assert.equal(fresh.listings[0]!.markedEndedAt, markedAt);
    assert.equal(audit.payload.listings[0]!.markedEndedAt, markedAt);
    assert.equal(audit.path, "optimized_hit");
    assert.equal(cacheHits, 4);
    assert.notEqual(fresh, cachedPayload);
    assert.notEqual(fresh.listings[0], cachedListing);
    assert.equal(JSON.stringify(cachedPayload), originalPayload);
    assert.equal(JSON.stringify([
      sqlite.prepare("SELECT * FROM listing_stubs").all(), sqlite.prepare("SELECT * FROM listing_votes").all(),
      sqlite.prepare("SELECT * FROM pipeline_generation_state").all(), sqlite.prepare("SELECT * FROM pipeline_work_items").all(),
    ]), before);
  } finally { sqlite.close(); }
});