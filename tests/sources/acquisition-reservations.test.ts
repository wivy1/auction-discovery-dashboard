import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { ensureDatabase } from "../../db/bootstrap";
import * as acquisition from "../../lib/sources/acquisition-reservations";

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const query = this.db.prepare(this.sql);
    return /^\s*(SELECT|PRAGMA|EXPLAIN)\b/iu.test(this.sql)
      ? { success: true, results: query.all(...this.values), meta: {} }
      : { success: true, results: [], meta: { changes: Number(query.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.values), meta: {} }; }
}

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const database = {
    prepare(sql: string) { return new Statement(sqlite, sql); },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  await ensureDatabase(database);
  sqlite.exec("DROP TABLE IF EXISTS source_frontier_state");
  sqlite.prepare("INSERT INTO auction_sources(id, display_name, base_url) VALUES (?, ?, ?)")
    .run("fixture", "Synthetic fixture", "https://inventory.example.test/");
  return { sqlite, database };
}

const now = new Date("2026-09-05T12:00:00.000Z");
const digest = `sha256:${"1".repeat(64)}`;
function reservation(database: D1Database, reservationId = "claim-one", expectedGeneration = 1, laneKey = "inventory") {
  return acquisition.reserveSourceAcquisition({ database, reservationId, sourceId: "fixture",
    requestRole: "inventory", requestIdentity: "complete-document", adapterVersion: "fixture-v1", proofVersion: "complete-v1",
    laneKey, expectedGeneration, inputHash: digest, inputRevision: 1, requestBudget: 5,
    leaseOwner: "test-worker", leaseMs: 60_000, now });
}
async function acquired(database: D1Database, reservationId = "claim-one", laneKey = "inventory") {
  const reserved = await reservation(database, reservationId, 1, laneKey);
  assert.equal(reserved.outcome, "reserved");
  if (reserved.outcome !== "reserved") throw new Error("Fixture reservation failed");
  const claim = acquisition.sourceAcquisitionClaimIdentity(reserved.reservation);
  const result = await acquisition.putSourceAcquiredBundle({ database, claim, responseHash: digest, contentHash: digest,
    contentType: "application/json", byteLength: 2, parserVersion: "fixture-v1", validationVersion: "complete-v1",
    validatedMetadata: { count: 0 }, requestsConsumed: 1, now });
  assert.equal(result.outcome, "inserted");
  if (result.outcome !== "inserted") throw new Error("Fixture acquisition failed");
  return { claim, bundleIdentity: result.bundle.bundleIdentity };
}

test("fresh public schema reserves without private frontier state and commits exactly one generation", async () => {
  const { sqlite, database: db } = await database();
  try {
    const claim = await acquired(db);
    assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "fixture"), 1);
    assert.equal((await acquisition.commitSourceAcquisitionReservation({ database: db, ...claim, currentGeneration: 1, now })).outcome, "committed");
    assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "fixture"), 2);
    assert.equal((await acquisition.readSourceAcquisitionReservation(db, claim.claim.reservationId))?.state, "committed");
    assert.equal((await acquisition.readSourceAcquiredBundle(db, claim.bundleIdentity))?.state, "committed");
    for (const currentGeneration of [1, 2]) {
      assert.equal((await acquisition.commitSourceAcquisitionReservation({ database: db, ...claim, currentGeneration,
        now: new Date(now.getTime() + 120_000) })).outcome, "committed");
      assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "fixture"), 2);
    }
    assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "unregistered-fixture"), 1);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { sqlite.close(); }
});

test("reservation claims preserve lane exclusion, exact identity and generation checks", async () => {
  const { sqlite, database: db } = await database();
  try {
    assert.equal((await reservation(db)).outcome, "reserved");
    assert.equal((await reservation(db)).outcome, "already_reserved");
    assert.equal((await reservation(db, "competitor")).outcome, "lane_contended");
    await assert.rejects(reservation(db, "claim-one", 2), /different input/);
    assert.deepEqual(await reservation(db, "stale", 2, "another-lane"), { outcome: "generation_changed", currentGeneration: 1 });
  } finally { sqlite.close(); }
});

test("expired, foreign and stale commit claims cannot advance a generation or commit a bundle", async () => {
  const { sqlite, database: db } = await database();
  try {
    const first = await acquired(db);
    const second = await acquired(db, "claim-two", "other-lane");
    const commit = (overrides = {}) => acquisition.commitSourceAcquisitionReservation({ database: db, ...first, currentGeneration: 1, now, ...overrides });
    assert.equal((await commit({ claim: { ...first.claim, leaseOwner: "other-worker" } })).outcome, "claim_missed");
    assert.equal((await commit({ bundleIdentity: second.bundleIdentity })).outcome, "claim_missed");
    assert.equal((await commit({ bundleIdentity: `sha256:${"2".repeat(64)}` })).outcome, "bundle_missed");
    assert.equal((await commit({ now: new Date(now.getTime() + 60_000) })).outcome, "claim_missed");
    assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "fixture"), 1);
    assert.equal((await acquisition.readSourceAcquiredBundle(db, first.bundleIdentity))?.state, "validated");
    assert.equal((await commit()).outcome, "committed");
    assert.equal((await acquisition.commitSourceAcquisitionReservation({ database: db, ...second, currentGeneration: 1, now })).outcome, "claim_missed");
    assert.equal((await acquisition.readSourceAcquiredBundle(db, second.bundleIdentity))?.state, "validated");
    assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "fixture"), 2);
  } finally { sqlite.close(); }
});

test("failed generation update rolls the whole commit transaction back", async () => {
  const { sqlite, database: db } = await database();
  try {
    const claim = await acquired(db);
    sqlite.exec("CREATE TRIGGER reject_generation BEFORE UPDATE OF generation ON source_acquisition_state BEGIN SELECT RAISE(ABORT, 'synthetic writer failure'); END");
    await assert.rejects(acquisition.commitSourceAcquisitionReservation({ database: db, ...claim, currentGeneration: 1, now }), /synthetic writer failure/);
    assert.equal((await acquisition.readSourceAcquisitionReservation(db, claim.claim.reservationId))?.state, "acquired");
    assert.equal((await acquisition.readSourceAcquiredBundle(db, claim.bundleIdentity))?.state, "validated");
    assert.equal(await acquisition.readSourceAcquisitionGeneration(db, "fixture"), 1);
  } finally { sqlite.close(); }
});
