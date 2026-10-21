import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { register } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import { ensureDatabase, DATABASE_SCHEMA_VERSION } from "../../db/bootstrap.ts";
import { CREATE_SCHEMA_METADATA_SQL } from "../../db/bootstrap-sql.ts";
import { normalizePublisherLeadEvidenceEntries, bindPublisherLeadEvidence } from "../../lib/sources/publisher-lead-evidence.ts";
import { stableContentHash } from "../../lib/sources/parsing.ts";
import type { SourceInventoryPublisherLeadEvidenceInput, SourcePage, SourcePublisherSharedOutboundLeadEvidence, SourcePublisherUnresolvedAddressLeadEvidence, SourcePublisherUnresolvedOutboundLeadEvidence } from "../../lib/sources/types.ts";

const bindings: { DB?: D1Database } = {};
Object.assign(globalThis, { __publicLeadEvidenceEnv: bindings });
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) { if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicLeadEvidenceEnv;'}; return n(s,c); }`)}`, import.meta.url);
const storage = await import("../../lib/pipeline/storage.ts");

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
  failNextBatch = false;
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(statement => statement.execute());
      if (this.failNextBatch) { this.failNextBatch = false; this.sqlite.exec("SELECT * FROM deliberately_missing_fixture_table"); }
      this.sqlite.exec("COMMIT"); return result;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
const root: SourcePage = { url: "https://events.example.test/current", body: '{"address":null,"renderedAddress":"Example City, XY"}', fetchedAt: "2026-01-01T00:00:00.000Z" };
const event: SourcePage = { url: "https://events.example.test/events/event-a", body: '{"id":"event-a","address":null}', fetchedAt: "2026-01-01T00:00:01.000Z" };
function evidence(): SourceInventoryPublisherLeadEvidenceInput & { evidence: SourcePublisherUnresolvedAddressLeadEvidence } {
  return { pageKey: "event:event-a", evidence: {
    kind: "unresolved_address_v1", publisherHost: "events.example.test", eventId: "event-a",
    canonicalUrl: event.url, addressStatus: "unresolved",
    root: { url: root.url, bodyHash: stableContentHash(root.body), fetchedAt: root.fetchedAt, inlineAddress: null, renderedAddressText: "Example City, XY" },
    event: { bodyHash: stableContentHash(event.body), fetchedAt: event.fetchedAt, inlineAddress: null, renderedAddressText: null },
  } };
}
function outboundEvidence(): SourceInventoryPublisherLeadEvidenceInput & { evidence: SourcePublisherUnresolvedOutboundLeadEvidence } {
  return { pageKey: "event:event-a", evidence: {
    kind: "unresolved_outbound_v1", publisherHost: "events.example.test", eventId: "event-a",
    canonicalUrl: event.url, outboundStatus: "unresolved",
    root: { url: root.url, bodyHash: stableContentHash(root.body), fetchedAt: root.fetchedAt },
    event: { bodyHash: stableContentHash(event.body), fetchedAt: event.fetchedAt, outbound: {
      hrefHash: `sha256:${"a".repeat(64)}`, https: true, externalToPublisher: true,
      queryPresent: true, fragmentPresent: true, credentialsPresent: false, portPresent: false, signedQueryKeyPresent: false,
    } },
  } };
}
function sharedPair(): Array<SourceInventoryPublisherLeadEvidenceInput & { evidence: SourcePublisherSharedOutboundLeadEvidence }> {
  const events = ["event-a", "event-b"].map(eventId => ({ eventId, canonicalUrl: `https://events.example.test/events/${eventId}` }));
  return events.map((entry, index) => ({ pageKey: `event:${entry.eventId}`, evidence: {
    kind: "shared_outbound_v1", publisherHost: "events.example.test", ...entry, outboundStatus: "unresolved",
    root: { url: root.url, bodyHash: stableContentHash(root.body), fetchedAt: root.fetchedAt },
    event: { bodyHash: stableContentHash(`fixture event ${entry.eventId}`), fetchedAt: event.fetchedAt, outboundTargetHash: `sha256:${"b".repeat(64)}` },
    peer: { eventId: events[1 - index]!.eventId, canonicalUrlHash: `sha256:${createHash("sha256").update(events[1 - index]!.canonicalUrl).digest("hex")}` },
  } }));
}
async function database() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec("PRAGMA foreign_keys=ON");
  const adapter = new Database(sqlite); bindings.DB = adapter.binding();
  await ensureDatabase(adapter.binding());
  sqlite.exec("INSERT INTO auction_sources(id,display_name,base_url) VALUES ('fixture','Fixture','https://events.example.test')");
  for (const id of ["run1", "run2"]) sqlite.prepare("INSERT INTO discovery_runs(id,trigger,status,origin_postal_code) VALUES (?,'manual','running','90210')").run(id);
  return { sqlite, adapter };
}

test("lead evidence validates separate bounded observations and exact completed captures", () => {
  const entry = evidence();
  const planned = { key: entry.pageKey, request: { kind: "discovery" as const, url: event.url }, minimumListings: 0, maximumListings: 0, inventoryMember: false, reviewCandidate: false };
  assert.deepEqual(bindPublisherLeadEvidence({ entries: [entry], plannedPages: [planned], pages: [event], roots: [root], pageRowCounts: new Map([[entry.pageKey, 0]]) }), [entry]);
  for (const entries of [
    [entry, entry], Array(21).fill(entry),
    [entry, { pageKey: "event:another-id", evidence: { ...entry.evidence, eventId: "another-id" } }],
    [{ ...entry, extra: true }],
    [{ ...entry, evidence: { ...entry.evidence, canonicalUrl: `${event.url}?token=fixture` } }],
    [{ ...entry, evidence: { ...entry.evidence, root: { ...entry.evidence.root, renderedAddressText: "x".repeat(1001) } } }],
    [{ ...entry, evidence: { ...entry.evidence, event: { ...entry.evidence.event, fetchedAt: "2025-12-31T23:59:59.000Z" } } }],
  ]) assert.throws(() => normalizePublisherLeadEvidenceEntries(entries));
  for (const changed of [
    { plannedPages: [{ ...planned, inventoryMember: true }] },
    { plannedPages: [{ ...planned, request: { ...planned.request, url: `${event.url}/other` } }] },
    { pages: [{ ...event, body: "changed source document" }] },
    { roots: [{ ...root, fetchedAt: "2026-01-01T00:00:00.001Z" }] },
    { pageRowCounts: new Map([[entry.pageKey, 1]]) },
  ]) assert.throws(() => bindPublisherLeadEvidence({ entries: [entry], plannedPages: [planned], pages: [event], roots: [root], pageRowCounts: new Map([[entry.pageKey, 0]]), ...changed }));
});

test("opaque outbound evidence admits only a hash and fixed safe shape, with no raw destination field", async () => {
  const entry = outboundEvidence();
  assert.deepEqual(normalizePublisherLeadEvidenceEntries([entry]), [entry]);
  for (const outbound of [
    { ...entry.evidence.event.outbound, hrefHash: "https://external.example.test/?private=source#lots" },
    { ...entry.evidence.event.outbound, hrefHash: `sha256:${"A".repeat(64)}` },
    { ...entry.evidence.event.outbound, rawHref: "https://external.example.test/?private=source#lots" },
    { ...entry.evidence.event.outbound, credentialsPresent: true },
    { ...entry.evidence.event.outbound, portPresent: true },
    { ...entry.evidence.event.outbound, signedQueryKeyPresent: true },
    { ...entry.evidence.event.outbound, externalToPublisher: false },
    { ...entry.evidence.event.outbound, queryPresent: false },
    { ...entry.evidence.event.outbound, fragmentPresent: false },
  ]) assert.throws(() => normalizePublisherLeadEvidenceEntries([{ ...entry, evidence: { ...entry.evidence, event: { ...entry.evidence.event, outbound } } }]));
  const { sqlite } = await database();
  try {
    await storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run1", publisherLeadEvidence: [entry] });
    assert.deepEqual(JSON.parse(String(sqlite.prepare("SELECT publisher_lead_evidence_json FROM source_inventory_publications").get()!.publisher_lead_evidence_json)), [entry]);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM listing_stubs").get()!.n, 0);
  } finally { sqlite.close(); }
});

test("shared outbound evidence requires exactly one reciprocal pair and preserves only hashes", async () => {
  const pair = sharedPair();
  assert.deepEqual(normalizePublisherLeadEvidenceEntries([...pair].reverse()), pair);
  const [left, right] = pair as [typeof pair[number], typeof pair[number]];
  for (const entries of [
    [left],
    [left, { ...right, evidence: { ...right.evidence, peer: { ...right.evidence.peer, eventId: "other-event" } } }],
    [left, { ...right, evidence: { ...right.evidence, peer: { ...right.evidence.peer, canonicalUrlHash: `sha256:${"0".repeat(64)}` } } }],
    [left, { ...right, evidence: { ...right.evidence, event: { ...right.evidence.event, outboundTargetHash: `sha256:${"c".repeat(64)}` } } }],
    [left, { ...right, evidence: { ...right.evidence, root: { ...right.evidence.root, bodyHash: "fnv1a64:0000000000000000" } } }],
    [left, { ...right, evidence: { ...right.evidence, root: { ...right.evidence.root, fetchedAt: "2026-01-01T00:00:00.001Z" } } }],
    [left, { ...right, evidence: { ...right.evidence, event: { ...right.evidence.event, rawTarget: "https://external.example.test/catalog" } } }],
    [...pair, { ...right, pageKey: "event:event-c", evidence: { ...right.evidence, eventId: "event-c", canonicalUrl: "https://events.example.test/events/event-c" } }],
  ]) assert.throws(() => normalizePublisherLeadEvidenceEntries(entries));
  const { sqlite } = await database();
  try {
    await assert.rejects(storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run1", publisherLeadEvidence: [left] }), /reciprocal pair/);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM source_inventory_publications").get()!.n, 0);
    await storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run1", publisherLeadEvidence: pair });
    assert.deepEqual(JSON.parse(String(sqlite.prepare("SELECT publisher_lead_evidence_json FROM source_inventory_publications").get()!.publisher_lead_evidence_json)), pair);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM listing_stubs").get()!.n, 0);
  } finally { sqlite.close(); }
});

test("zero-row evidence publishes immutably, rejects replay conflicts and rolls back with the publication", async () => {
  const { sqlite, adapter } = await database();
  try {
    const entry = evidence();
    await storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run1", publisherLeadEvidence: [entry] });
    const before = sqlite.prepare("SELECT * FROM source_inventory_publications").get();
    assert.deepEqual(JSON.parse(String(before!.publisher_lead_evidence_json)), [entry]);
    assert.equal(before!.listing_count, 0);
    await storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run1", publisherLeadEvidence: [entry] });
    assert.deepEqual(sqlite.prepare("SELECT * FROM source_inventory_publications").get(), before);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM listing_stubs").get()!.n, 0);
    const changed = { ...entry, evidence: { ...entry.evidence, root: { ...entry.evidence.root, renderedAddressText: "Different source text" } } };
    await assert.rejects(storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run1", publisherLeadEvidence: [changed] }), /conflicts with immutable evidence/);
    assert.deepEqual(sqlite.prepare("SELECT * FROM source_inventory_publications").get(), before);
    assert.throws(() => sqlite.exec("UPDATE source_inventory_publications SET publisher_lead_evidence_json='[]'"), /immutable/);
    assert.throws(() => sqlite.exec("DELETE FROM source_inventory_publications"), /immutable/);
    adapter.failNextBatch = true;
    await assert.rejects(storage.replaceSourceCurrentInventory({ sourceId: "fixture", runId: "run2", publisherLeadEvidence: [changed] }), /deliberately_missing_fixture_table/);
    assert.equal((await storage.readSourceInventoryPublicationHead("fixture"))?.inventoryRunId, "run1");
    assert.deepEqual(sqlite.prepare("SELECT * FROM source_inventory_publications").all(), [before]);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { sqlite.close(); }
});

test("traversal lead evidence requires its exact completed zero-row audit page", async () => {
  const { sqlite } = await database();
  try {
    const entry = evidence();
    const traversal = await storage.prepareSourceInventoryTraversal({ sourceId: "fixture", fingerprint: "lead-fixture-v1", expectedListings: 0,
      pages: [{ key: entry.pageKey, inventoryMember: false, reviewCandidate: false }] });
    await storage.checkpointSourceInventoryTraversalPage({ traversalId: traversal.traversalId, sourceId: "fixture", pageKey: entry.pageKey, listingIds: [], observedAt: event.fetchedAt });
    const input = { traversalId: traversal.traversalId, sourceId: "fixture", runId: "run1", originCacheKey: "fixture-origin" };
    await assert.rejects(storage.publishSourceInventoryTraversal({ ...input, publisherLeadEvidence: [{ ...entry, pageKey: "missing-event" }] }), /completed zero-row audit/);
    await storage.publishSourceInventoryTraversal({ ...input, publisherLeadEvidence: [entry] });
    assert.deepEqual(JSON.parse(String(sqlite.prepare("SELECT publisher_lead_evidence_json FROM source_inventory_publications").get()!.publisher_lead_evidence_json)), [entry]);
  } finally { sqlite.close(); }
});

function legacyDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(CREATE_SCHEMA_METADATA_SQL);
  sqlite.exec("INSERT INTO _auction_discovery_public_schema VALUES(1,46,'2026-01-01T00:00:00.000Z')");
  sqlite.exec(`CREATE TABLE source_inventory_publications(source_id TEXT NOT NULL,inventory_run_id TEXT NOT NULL,listing_count INTEGER NOT NULL,collection_counts_json TEXT NOT NULL DEFAULT '[]',published_at TEXT NOT NULL,PRIMARY KEY(source_id,inventory_run_id));
    INSERT INTO source_inventory_publications VALUES('fixture','historical',0,'[]','2026-01-01T00:00:00.000Z');
    CREATE TRIGGER source_inventory_publications_conflict_guard BEFORE INSERT ON source_inventory_publications WHEN EXISTS(SELECT 1 FROM source_inventory_publications existing WHERE existing.source_id=NEW.source_id AND existing.inventory_run_id=NEW.inventory_run_id AND (existing.listing_count<>NEW.listing_count OR existing.collection_counts_json<>NEW.collection_counts_json)) BEGIN SELECT RAISE(ABORT,'old conflict'); END;`);
  return { sqlite, adapter: new Database(sqlite) };
}

test("V46 migration preserves old publications with empty evidence and rolls back its version on failure", async () => {
  const { sqlite, adapter } = legacyDatabase();
  try {
    const prior = sqlite.prepare("SELECT * FROM source_inventory_publications").get()!;
    adapter.failNextBatch = true;
    await assert.rejects(ensureDatabase(adapter.binding()), /deliberately_missing_fixture_table/);
    assert.equal(sqlite.prepare("SELECT version FROM _auction_discovery_public_schema").get()!.version, 46);
    assert.equal(sqlite.prepare("PRAGMA table_info(source_inventory_publications)").all().some(row => row.name === "publisher_lead_evidence_json"), false);
    assert.deepEqual(await ensureDatabase(adapter.binding()), { version: DATABASE_SCHEMA_VERSION, initialized: true });
    assert.deepEqual({ ...sqlite.prepare("SELECT * FROM source_inventory_publications").get() }, { ...prior, publisher_lead_evidence_json: "[]" });
    assert.throws(() => sqlite.prepare("INSERT INTO source_inventory_publications VALUES(?,?,?,?,?,?)").run("fixture", "historical", 0, "[]", "2026-01-01T00:00:00.000Z", JSON.stringify([evidence()])), /conflicts with immutable evidence/);
    assert.throws(() => sqlite.prepare("INSERT INTO source_inventory_publications VALUES(?,?,?,?,?,?)").run("fixture", "oversized", 0, "[]", "2026-01-01T00:00:00.000Z", JSON.stringify(Array(21).fill({}))), /CHECK/);
  } finally { sqlite.close(); }
});
