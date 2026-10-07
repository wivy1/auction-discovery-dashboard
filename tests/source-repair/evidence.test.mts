import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  captureSourceParserEvidence, SOURCE_PARSER_EVIDENCE_LIMITS,
  sourceParserEvidenceKey, sourceParserEvidenceModelContext,
  validateSourceParserEvidencePacket,
} from "../../lib/source-repair/evidence.ts";
import { loadSourceParserEvidence } from "../../lib/source-repair/evidence-local.ts";

const timestamp = "2026-01-02T03:04:05.000Z";
function input(sourceId = "fixture-json", body = JSON.stringify({ items: [{ id: "one", title: null }] })) {
  return {
    sourceId, sourceRunId: "fixture-run", observedAt: timestamp,
    diagnostic: { errorCode: "SourceAdapterError", message: "title must be a string" },
    page: { url: "https://inventory.fixture.test/current", body, fetchedAt: timestamp, contentType: "application/json" },
  };
}

test("public source IDs accept hyphens and one character, with exact run identity", async () => {
  for (const sourceId of ["fixture-json", "a", "x_2-3"]) {
    const captured = await captureSourceParserEvidence(input(sourceId));
    assert.equal(captured.available, true);
    if (!captured.available) continue;
    assert.equal(captured.key, "source-repair-evidence/v1/fixture-run.json");
    const packet = await validateSourceParserEvidencePacket(JSON.parse(captured.serializedPacket), { sourceId, sourceRunId: "fixture-run" });
    assert.equal(packet.sourceId, sourceId);
    await assert.rejects(validateSourceParserEvidencePacket(packet, { sourceId, sourceRunId: "other-run" }), /invalid_evidence_packet/);
  }
  for (const sourceId of ["", "Bad", "../escape", "-bad", "a".repeat(65)]) {
    assert.deepEqual(await captureSourceParserEvidence(input(sourceId)), { available: false, reason: "invalid_evidence_identity" });
  }
  assert.throws(() => sourceParserEvidenceKey("../escape"), /invalid_evidence_identity/);
});

test("JSON evidence removes credentials and bidder state, and strips URL queries", async () => {
  const captured = await captureSourceParserEvidence(input("fixture-json", JSON.stringify({
    token: "fixture-credential", bidderId: "fixture-person", bidHistory: [{ bidder: "fixture-person" }],
    totalBids: 3, items: [{ id: "one", title: null, image: "https://user:pass@images.fixture.test/one?signature=private#view", note: "Bearer fixture-secret" }],
  })));
  assert.equal(captured.available, true);
  if (!captured.available) return;
  const body = JSON.parse(captured.packet.replay.page.body);
  assert.deepEqual(body, { totalBids: 3, items: [{ id: "one", title: null, image: "https://images.fixture.test/one", note: "Bearer [redacted]" }] });
  assert.equal(captured.packet.metadata.redactions.credentialFields, 1);
  assert.equal(captured.packet.metadata.redactions.personalBidFields, 3);
  assert.equal(captured.packet.metadata.redactions.urlQueries, 1);
  assert.notEqual(captured.packet.originalBodyHash, captured.packet.sanitizedBodyHash);
  assert.ok(!captured.serializedPacket.includes("fixture-credential"));
  await validateSourceParserEvidencePacket(captured.packet, { sourceId: "fixture-json", sourceRunId: "fixture-run" });
});

test("unsafe page URLs, HTML, malformed JSON and transport context are unavailable", async () => {
  for (const url of ["https://inventory.fixture.test/current?key=private", "https://user:pass@inventory.fixture.test/current", "https://inventory.fixture.test/current#fragment"]) {
    assert.deepEqual(await captureSourceParserEvidence({ ...input(), page: { ...input().page, url } }), { available: false, reason: "page_url_not_replayable" });
  }
  assert.deepEqual(await captureSourceParserEvidence({ ...input(), page: { ...input().page, body: "<main>error</main>", contentType: "text/html" } }), { available: false, reason: "unsupported_page_metadata" });
  assert.deepEqual(await captureSourceParserEvidence(input("fixture-json", "{")), { available: false, reason: "invalid_json_body" });
  for (const plannedPage of [{ request: { headers: { Authorization: "private" } } }, { request: { body: "private" } }]) {
    assert.deepEqual(await captureSourceParserEvidence({ ...input(), plannedPage }), { available: false, reason: "secret_or_transport_context" });
  }
});

test("ambiguous encoded secrets and unsafe keys fail closed; bounded semantic context survives", async () => {
  const unsafe = await captureSourceParserEvidence(input("fixture-json", JSON.stringify({ link: "https%3A%2F%2Fuser%3Apass%40inventory.fixture.test" })));
  assert.deepEqual(unsafe, { available: false, reason: "unsafe_encoded_url_text" });
  assert.deepEqual(await captureSourceParserEvidence(input("fixture-json", '{"__proto__":{"secret":"private"}}')), { available: false, reason: "unsafe_json_key" });
  const captured = await captureSourceParserEvidence({ ...input(), expectedListings: 0, plannedPage: {
    key: "inventory:document", request: { kind: "discovery", url: input().page.url },
    minimumListings: 0, maximumListings: 0, inventoryMember: true, reviewCandidate: true,
  } });
  assert.equal(captured.available, true);
  if (!captured.available) return;
  assert.equal(captured.packet.replay.expectedListings, 0);
  const context = sourceParserEvidenceModelContext(captured.packet);
  assert.ok(Buffer.byteLength(context) <= SOURCE_PARSER_EVIDENCE_LIMITS.modelContextBytes);
  assert.equal(JSON.parse(context).diagnostic.message, "title must be a string");
  const altered = JSON.parse(captured.serializedPacket);
  altered.replay.page.body = JSON.stringify({ items: [] });
  await assert.rejects(validateSourceParserEvidencePacket(altered, { sourceId: "fixture-json", sourceRunId: "fixture-run" }), /evidence_body_hash_mismatch/);
});

test("trusted replay operations are explicit and legacy packets retain parse-page compatibility", async () => {
  for (const operation of ["plan_inventory", "validate_page", "parse_page"] as const) {
    const captured = await captureSourceParserEvidence({ ...input(), operation });
    assert.equal(captured.available, true);
    if (!captured.available) continue;
    const packet = await validateSourceParserEvidencePacket(captured.packet, { sourceId: "fixture-json", sourceRunId: "fixture-run" });
    assert.equal(packet.replay.operation, operation);
    assert.equal(JSON.parse(sourceParserEvidenceModelContext(packet)).operation, operation);
    const altered = JSON.parse(captured.serializedPacket); altered.replay.operation = "model_selected";
    await assert.rejects(validateSourceParserEvidencePacket(altered, { sourceId: "fixture-json", sourceRunId: "fixture-run" }), /invalid_replay_context/);
  }
  const captured = await captureSourceParserEvidence(input());
  assert.equal(captured.available, true);
  if (!captured.available) return;
  assert.equal(captured.packet.replay.operation, undefined);
  assert.equal(JSON.parse(sourceParserEvidenceModelContext(captured.packet)).operation, "parse_page");
});

async function localEvidence(sourceId: string) {
  const root = await mkdtemp(join(tmpdir(), "public-parser-evidence-"));
  const r2 = join(root, ".wrangler/state/v3/r2");
  const metadataPath = join(r2, "miniflare-R2BucketObject", `${"a".repeat(64)}.sqlite`);
  const blobId = "b".repeat(80);
  const blobPath = join(r2, "fixture-bucket", "blobs", blobId);
  await mkdir(join(r2, "miniflare-R2BucketObject"), { recursive: true });
  await mkdir(join(r2, "fixture-bucket", "blobs"), { recursive: true });
  const captured = await captureSourceParserEvidence(input(sourceId));
  assert.equal(captured.available, true);
  if (!captured.available) throw new Error("fixture evidence unavailable");
  const blob = Buffer.from(captured.serializedPacket);
  const digest = (algorithm: string) => createHash(algorithm).update(blob).digest("hex");
  await writeFile(blobPath, blob);
  const db = new DatabaseSync(metadataPath);
  db.exec("CREATE TABLE _mf_objects (key TEXT,blob_id TEXT,version TEXT,size INTEGER,etag TEXT,uploaded INTEGER,checksums TEXT,http_metadata TEXT,custom_metadata TEXT)");
  db.prepare("INSERT INTO _mf_objects VALUES (?,?,?,?,?,?,?,?,?)").run(captured.key, blobId, "c".repeat(32), blob.length, digest("md5"), 1,
    JSON.stringify({ sha256: digest("sha256") }), JSON.stringify({ contentType: "application/json" }), "{}");
  db.close();
  return { root, metadataPath, blobPath, captured, blob };
}
async function cleanFixture(root: string) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("public-parser-evidence-"));
  await rm(root, { recursive: true, force: true });
}

test("read-only local R2 lookup accepts both public ID forms without metadata or blob mutation", async () => {
  for (const sourceId of ["fixture-json", "a"]) {
    const fixture = await localEvidence(sourceId);
    try {
      const before = await readFile(fixture.metadataPath);
      const loaded = await loadSourceParserEvidence(fixture.root, "fixture-run", sourceId);
      assert.equal(loaded.available, true);
      if (!loaded.available) continue;
      assert.equal(loaded.packet.sourceId, sourceId);
      assert.equal(loaded.artifactHash, createHash("sha256").update(fixture.blob).digest("hex"));
      assert.deepEqual(await readFile(fixture.metadataPath), before);
      assert.deepEqual(await readFile(fixture.blobPath), fixture.blob);
      assert.deepEqual(await loadSourceParserEvidence(fixture.root, "other-run", sourceId), { available: false, reason: "evidence_not_found" });
      assert.deepEqual(await loadSourceParserEvidence(fixture.root, "fixture-run", "other-source"), { available: false, reason: "evidence_packet_invalid" });
    } finally { await cleanFixture(fixture.root); }
  }
});

test("local R2 lookup rejects a changed blob and ambiguous buckets", async () => {
  const fixture = await localEvidence("fixture-json");
  try {
    await writeFile(fixture.blobPath, Buffer.from("x".repeat(fixture.blob.length)));
    assert.deepEqual(await loadSourceParserEvidence(fixture.root, "fixture-run", "fixture-json"), { available: false, reason: "evidence_blob_hash_mismatch" });
    await mkdir(join(fixture.root, ".wrangler/state/v3/r2", "second-bucket"));
    assert.deepEqual(await loadSourceParserEvidence(fixture.root, "fixture-run", "fixture-json"), { available: false, reason: "evidence_bucket_ambiguous" });
  } finally { await cleanFixture(fixture.root); }
});
