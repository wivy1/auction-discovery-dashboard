/** Exact, read-only Miniflare R2 evidence lookup. No Worker code imports this module. */
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoSymlinks } from "./core.ts";
import {
  SOURCE_PARSER_EVIDENCE_LIMITS, sourceParserEvidenceKey, validateSourceParserEvidencePacket,
  type SourceParserEvidencePacket,
} from "./evidence.ts";

export type SourceParserEvidenceLoadResult =
  | { available: true; packet: SourceParserEvidencePacket; key: string; artifactHash: string; byteLength: number }
  | { available: false; reason: string };
const OBJECT_COLUMNS = [
  ["key", "TEXT"], ["blob_id", "TEXT"], ["version", "TEXT"], ["size", "INTEGER"], ["etag", "TEXT"],
  ["uploaded", "INTEGER"], ["checksums", "TEXT"], ["http_metadata", "TEXT"], ["custom_metadata", "TEXT"],
];
interface ObjectRow {
  key: string; blob_id: string | null; version: string; size: number; etag: string;
  uploaded: number; checksums: string; http_metadata: string; custom_metadata: string;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (algorithm: string, value: Uint8Array) => createHash(algorithm).update(value).digest("hex");
class EvidenceReadUnavailable extends Error { constructor(readonly reason: string) { super(reason); } }
function unavailable(reason: string): never { throw new EvidenceReadUnavailable(reason); }
function metadataJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8_192) unavailable("evidence_metadata_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { unavailable("evidence_metadata_invalid"); }
  if (!record(parsed)) unavailable("evidence_metadata_invalid");
  return parsed;
}
async function regularFile(root: string, path: string): Promise<void> {
  await assertNoSymlinks(root, path);
  if (!(await lstat(path)).isFile()) unavailable("evidence_storage_layout_unavailable");
}
async function boundedBlob(root: string, path: string, size: number): Promise<Buffer> {
  await regularFile(root, path);
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== size) unavailable("evidence_blob_size_mismatch");
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== size) unavailable("evidence_blob_size_mismatch");
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}
function verifyObject(row: ObjectRow, key: string): Record<string, unknown> {
  if (row.key !== key || typeof row.blob_id !== "string" || !/^[a-f0-9]{80}$/u.test(row.blob_id) ||
    typeof row.etag !== "string" || !/^[a-f0-9]{32}$/u.test(row.etag) ||
    typeof row.version !== "string" || !/^[a-f0-9]{32}$/u.test(row.version) ||
    !Number.isSafeInteger(row.uploaded) || row.uploaded <= 0 || !Number.isSafeInteger(row.size) || row.size <= 0 ||
    row.size > SOURCE_PARSER_EVIDENCE_LIMITS.packetBytes) unavailable("evidence_metadata_invalid");
  const http = metadataJson(row.http_metadata);
  if (typeof http.contentType !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(http.contentType)) unavailable("evidence_content_type_unavailable");
  metadataJson(row.custom_metadata);
  const checksums = metadataJson(row.checksums);
  const lengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, sha384: 96, sha512: 128 };
  for (const [algorithm, digest] of Object.entries(checksums)) {
    if (!lengths[algorithm] || typeof digest !== "string" || !new RegExp(`^[a-f0-9]{${lengths[algorithm]}}$`, "u").test(digest)) unavailable("evidence_metadata_invalid");
  }
  if (checksums.md5 !== undefined && checksums.md5 !== row.etag) unavailable("evidence_metadata_invalid");
  return checksums;
}

/** The source-run identity must come from a trusted D1 join, never model output. */
export async function loadSourceParserEvidence(projectRoot: string, sourceRunId: string, sourceId: string): Promise<SourceParserEvidenceLoadResult> {
  let database: DatabaseSync | undefined;
  try {
    const key = sourceParserEvidenceKey(sourceRunId);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(sourceId)) unavailable("invalid_evidence_identity");
    const directory = join(projectRoot, ".wrangler/state/v3/r2");
    await assertNoSymlinks(projectRoot, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const buckets = entries.filter((entry) => entry.name !== "miniflare-R2BucketObject");
    if (buckets.length !== 1 || !buckets[0]!.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/u.test(buckets[0]!.name)) unavailable("evidence_bucket_ambiguous");
    const metadataDirectory = join(directory, "miniflare-R2BucketObject");
    await assertNoSymlinks(projectRoot, metadataDirectory);
    const metadataFiles = (await readdir(metadataDirectory)).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
    if (metadataFiles.length !== 1 || !/^[a-f0-9]{64}\.sqlite$/u.test(metadataFiles[0]!)) unavailable("evidence_bucket_ambiguous");
    const metadataPath = join(metadataDirectory, metadataFiles[0]!);
    await regularFile(projectRoot, metadataPath);
    database = new DatabaseSync(metadataPath, { readOnly: true });
    const columns = database.prepare("PRAGMA table_info(_mf_objects)").all() as Array<{ name: string; type: string }>;
    if (JSON.stringify(columns.map(({ name, type }) => [name, type])) !== JSON.stringify(OBJECT_COLUMNS)) unavailable("evidence_storage_layout_unavailable");
    const read = database.prepare("SELECT key,blob_id,version,size,etag,uploaded,checksums,http_metadata,custom_metadata FROM _mf_objects WHERE key=? LIMIT 2");
    const rows = read.all(key) as unknown as ObjectRow[];
    if (!rows.length) unavailable("evidence_not_found");
    if (rows.length !== 1) unavailable("evidence_metadata_invalid");
    const row = rows[0]!;
    const checksums = verifyObject(row, key);
    const blob = await boundedBlob(projectRoot, join(directory, buckets[0]!.name, "blobs", row.blob_id!), row.size);
    if (hash("md5", blob) !== row.etag || Object.entries(checksums).some(([algorithm, digest]) => hash(algorithm, blob) !== digest)) unavailable("evidence_blob_hash_mismatch");
    if (JSON.stringify(read.all(key)) !== JSON.stringify(rows)) unavailable("evidence_metadata_changed");
    let packetJson: unknown;
    try { packetJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob)); }
    catch { unavailable("evidence_packet_invalid"); }
    let packet: SourceParserEvidencePacket;
    try { packet = await validateSourceParserEvidencePacket(packetJson, { sourceId, sourceRunId }); }
    catch { unavailable("evidence_packet_invalid"); }
    return { available: true, packet, key, artifactHash: hash("sha256", blob), byteLength: blob.length };
  } catch (error) {
    return { available: false, reason: error instanceof EvidenceReadUnavailable ? error.reason : "evidence_storage_unavailable" };
  } finally { database?.close(); }
}
