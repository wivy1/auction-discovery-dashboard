import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { ensureDatabase } from "../../db/bootstrap.ts";
import * as schema from "../../db/bootstrap-sql.ts";
import { markListingsEnded, readListingEndOverrides } from "../../db/listing-end-state.ts";
import { HttpError } from "../../lib/http.ts";

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
const timestamp = "2026-09-11T12:00:00.000Z";
async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const adapter = new Database(sqlite);
  await ensureDatabase(adapter.binding());
  seed(sqlite);
  return { sqlite, adapter, db: adapter.binding() };
}
function seed(sqlite: DatabaseSync) {
  sqlite.exec(`INSERT INTO auction_sources (id, display_name, base_url, enabled, permission_status, pickup_location_visibility)
    VALUES ('fixture', 'Fixture', 'https://example.invalid', 1, 'allowed', 'listing')`);
  for (const id of ["unknown", "empty", "date", "future", "past", "live", "observation", "supplement", "stub"]) {
    sqlite.prepare(`INSERT INTO listing_stubs (id, source_id, source_listing_id, source_url, title, discovered_at, content_hash)
      VALUES (?, 'fixture', ?, ?, ?, ?, ?)`)
      .run(`fixture:${id}`, id, `https://example.invalid/${id}`, id, timestamp, id);
    if (id === "stub") continue;
    const close = id === "date" ? "2026-09-11" : id === "future" || id === "observation"
      ? "2099-09-11T12:00:00.000Z" : id === "past" ? "2000-09-11T12:00:00.000Z" : id === "empty" ? " \t" : null;
    sqlite.prepare(`INSERT INTO listing_details (listing_id, title_at_scrape, raw_description, clean_description, auction_ends_at, scraped_at, content_hash)
      VALUES (?, ?, 'Original source facts', 'Original source facts', ?, ?, ?)`)
      .run(`fixture:${id}`, id, close, timestamp, id);
  }
  sqlite.prepare(`INSERT INTO listing_detail_observations (listing_id, title, auction_ends_at, source_url, detail_content_hash, observed_at)
    VALUES ('fixture:observation', 'Observation', NULL, 'https://example.invalid/observation', 'fnv1a64:0000000000000000', ?)`)
    .run(timestamp);
  sqlite.prepare(`INSERT INTO listing_action_deadlines (listing_id, deadline_at, basis, source_text, source_url, detail_content_hash, observed_at)
    VALUES ('fixture:live', '2000-09-11T12:00:00.000Z', 'live_auction_start', 'Live auction begins', 'https://example.invalid/live', 'fnv1a64:0000000000000000', ?)`)
    .run(timestamp);
  sqlite.prepare(`INSERT INTO listing_votes (listing_id, value, created_at, updated_at)
    VALUES ('fixture:unknown', 'interested', ?, ?)`)
    .run(timestamp, timestamp);
}
function sourceSnapshot(sqlite: DatabaseSync) {
  return JSON.stringify(["listing_stubs", "listing_details", "listing_detail_observations", "listing_action_deadlines", "listing_votes"]
    .map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
}

test("operator-ended state persists, deduplicates, and preserves source facts and votes", async () => {
  const { sqlite, db } = await fixture();
  try {
    const original = sourceSnapshot(sqlite);
    const ids = ["unknown", "empty", "date", "future", "past", "live", "observation", "stub", "missing", "unknown"].map(id => `fixture:${id}`);
    const first = await markListingsEnded(db, ids);
    assert.equal(first.requestedCount, 9);
    assert.deepEqual(first.outcomes.map(row => [row.listingId, row.status]), [
      ["fixture:unknown", "changed"], ["fixture:empty", "changed"],
      ["fixture:date", "skipped_has_time"], ["fixture:future", "skipped_has_time"],
      ["fixture:past", "skipped_has_time"], ["fixture:live", "changed"],
      ["fixture:observation", "changed"], ["fixture:stub", "changed"],
      ["fixture:missing", "skipped_not_found"],
    ]);
    const saved = await readListingEndOverrides(db, ids);
    assert.equal(saved.size, 5);
    assert.ok(Number.isFinite(Date.parse(saved.get("fixture:unknown")!)));
    const second = await markListingsEnded(db, ["fixture:unknown", "fixture:observation"]);
    assert.deepEqual(second.outcomes.map(row => row.status), ["already_ended", "already_ended"]);
    assert.equal(second.outcomes[0]!.markedEndedAt, saved.get("fixture:unknown"));
    assert.equal(sourceSnapshot(sqlite), original);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(await readListingEndOverrides(db, []), new Map());
  } finally { sqlite.close(); }
});

function activeLease(sqlite: DatabaseSync, expires = "2099-01-01T00:00:00.000Z") {
  sqlite.prepare(`INSERT INTO pipeline_run_lease (singleton, run_kind, run_id, acquired_at, expires_at)
    VALUES (1, 'discovery', 'fixture-lease', ?, ?)`)
    .run(timestamp, expires);
}
test("active and transaction-time leases block every override; expired leases permit the mutation", async () => {
  const { sqlite, adapter, db } = await fixture();
  try {
    const busy = (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "pipeline_busy";
    activeLease(sqlite);
    await assert.rejects(markListingsEnded(db, ["fixture:unknown", "fixture:stub"]), busy);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM listing_end_overrides").get()!.count, 0);
    sqlite.exec("DELETE FROM pipeline_run_lease");
    adapter.beforeBatch = () => { adapter.beforeBatch = null; activeLease(sqlite); };
    await assert.rejects(markListingsEnded(db, ["fixture:unknown", "fixture:stub"]), busy);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM listing_end_overrides").get()!.count, 0);
    sqlite.exec("DELETE FROM pipeline_run_lease");
    activeLease(sqlite, "2000-01-01T00:00:00.000Z");
    const result = await markListingsEnded(db, ["fixture:unknown", "fixture:stub"]);
    assert.deepEqual(result.outcomes.map(row => row.status), ["changed", "changed"]);
    assert.equal(sqlite.prepare("SELECT run_id FROM pipeline_run_lease").get()!.run_id, "fixture-lease");
  } finally { sqlite.close(); }
});

test("V45 upgrade adds only operator-end state and preserves retained source and vote records", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = new Database(sqlite);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    const statements = schema.PUBLIC_SCHEMA_STATEMENTS
      .filter(sql => !sql.includes('CREATE TABLE IF NOT EXISTS listing_end_overrides'))
      .map(sql => sql.replace('VALUES (1, 46, strftime', 'VALUES (1, 45, strftime'));
    await adapter.batch([schema.CREATE_SCHEMA_METADATA_SQL, ...statements].map(sql => adapter.prepare(sql)));
    seed(sqlite);
    const original = sourceSnapshot(sqlite);
    const tablesBefore = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    assert.equal(tablesBefore.has("listing_end_overrides"), false);
    const result = await ensureDatabase(adapter.binding());
    assert.equal(result.version, 46);
    assert.equal(result.initialized, true);
    assert.equal(sourceSnapshot(sqlite), original);
    const added = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map(row => row.name).filter(name => !tablesBefore.has(name));
    assert.deepEqual(added, ["listing_end_overrides"]);
    assert.deepEqual(await ensureDatabase(adapter.binding()), { version: 46, initialized: false });
    assert.equal((await markListingsEnded(adapter.binding(), ["fixture:unknown"])).outcomes[0]!.status, "changed");
  } finally { sqlite.close(); }
});

test("backend rejects malformed or oversized mutation sets before writing", async () => {
  const { sqlite, db } = await fixture();
  try {
    for (const ids of [[], new Array<string>(2), [" fixture:unknown"], ["fixture:\u0000"], ["x".repeat(513)], Array(1001).fill("fixture:unknown")]) {
      await assert.rejects(markListingsEnded(db, ids), error => error instanceof HttpError && error.status === 400);
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM listing_end_overrides").get()!.count, 0);
  } finally { sqlite.close(); }
});
test("public fresh Drizzle schema installs the same usable V46 operator state", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = new Database(sqlite);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(readFileSync(new URL("../../drizzle/0000_public_schema.sql", import.meta.url), "utf8"));
    assert.deepEqual(await ensureDatabase(adapter.binding()), { version: 46, initialized: false });
    seed(sqlite);
    assert.equal((await markListingsEnded(adapter.binding(), ["fixture:unknown"])).outcomes[0]!.status, "changed");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = '_auction_discovery_schema'").get()!.count, 0);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { sqlite.close(); }
});
test("auction start alone allows explicit ending without a close time, rating, or vote", async () => {
  const { sqlite, db } = await fixture();
  try {
    sqlite.prepare(`INSERT INTO listing_action_deadlines (listing_id, deadline_at, basis, source_text, source_url, detail_content_hash, observed_at)
      VALUES ('fixture:stub', '2099-09-11T12:00:00.000Z', 'live_auction_start', 'Future live auction begins', 'https://example.invalid/stub', 'fnv1a64:0000000000000000', ?)`)
      .run(timestamp);
    const ids = ['fixture:live', 'fixture:stub'];
    const original = sourceSnapshot(sqlite);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM listing_scores WHERE listing_id IN ('fixture:live', 'fixture:stub')").get()!.count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM listing_votes WHERE listing_id IN ('fixture:live', 'fixture:stub')").get()!.count, 0);
    assert.equal((await readListingEndOverrides(db, ids)).size, 0,
      'past and future auction starts do not automatically create ended state');
    const result = await markListingsEnded(db, ids);
    assert.deepEqual(result.outcomes.map(row => row.status), ['changed', 'changed']);
    assert.equal((await readListingEndOverrides(db, ids)).size, 2);
    assert.equal(sourceSnapshot(sqlite), original, 'explicit ending preserves start evidence and does not add votes');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM listing_scores WHERE listing_id IN ('fixture:live', 'fixture:stub')").get()!.count, 0);
  } finally { sqlite.close(); }
});