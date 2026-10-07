/** Sanitized source evidence only. This module also runs in the Worker. */
export const SOURCE_PARSER_EVIDENCE_SCHEMA = "source-parser-evidence-v1";
export const SOURCE_PARSER_EVIDENCE_LIMITS = Object.freeze({
  packetBytes: 8 * 1024 * 1024, depth: 32, nodes: 100_000,
  keyBytes: 256, diagnosticBytes: 2_000, modelContextBytes: 16_384,
});
export type EvidenceJson = null | boolean | number | string | EvidenceJson[] | { [key: string]: EvidenceJson };
export interface SourceParserEvidenceRedactions {
  credentialFields: number; personalBidFields: number;
  urlQueries: number; urlUserInfo: number; urlFragments: number; inlineCredentials: number;
}
export interface SourceParserEvidencePage {
  url: string; body: string; fetchedAt: string; contentType?: string;
}
export type SourceParserEvidenceOperation = "plan_inventory" | "validate_page" | "parse_page";
export interface SourceParserEvidencePacket {
  schemaVersion: typeof SOURCE_PARSER_EVIDENCE_SCHEMA;
  sourceId: string; sourceRunId: string; observedAt: string;
  originalBodyHash: string; sanitizedBodyHash: string;
  diagnostic: { errorCode: string; message: string };
  replay: { kind: "discovery_page"; page: SourceParserEvidencePage; operation?: SourceParserEvidenceOperation; expectedListings?: number; plannedPage?: { [key: string]: EvidenceJson } };
  metadata: { redactions: SourceParserEvidenceRedactions };
}
export interface SourceParserEvidenceCaptureInput {
  sourceId: string; sourceRunId: string; observedAt: string;
  diagnostic: { errorCode: string; message: string };
  page: SourceParserEvidencePage; operation?: SourceParserEvidenceOperation; expectedListings?: number; plannedPage?: unknown;
}
export type SourceParserEvidenceCapture =
  | { available: true; packet: SourceParserEvidencePacket; key: string; serializedPacket: string; byteLength: number }
  | { available: false; reason: string };

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const operations: readonly unknown[] = ["plan_inventory", "validate_page", "parse_page"];
const redactions = (): SourceParserEvidenceRedactions => ({ credentialFields: 0, personalBidFields: 0, urlQueries: 0, urlUserInfo: 0, urlFragments: 0, inlineCredentials: 0 });
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => owns(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value));
const jsonContentType = (value: unknown): value is string => typeof value === "string" && value.length <= 128 &&
  /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(value.trim());
const safeKey = (key: string) => bytes(key) <= SOURCE_PARSER_EVIDENCE_LIMITS.keyBytes && key.length > 0 &&
  !/^(?:__proto__|prototype|constructor)$/u.test(key) && !/[\u0000-\u001f\u007f?\\/]/u.test(key) &&
  !/^https?:/iu.test(key) && sanitizeText(key, redactions()) === key;
const normalizedKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/gu, "");
const credentialKey = (key: string) => /authorization|cookie|password|passwd|secret|session|credential|capability|signature|token|apikey|accesskey|privatekey|csrf|xsrf|^(?:auth|pwd|basicauth|authentication)$/u.test(normalizedKey(key));
const personalBidKey = (key: string) => normalizedKey(key) !== "totalbids" &&
  /bidder|highbid|registrant|registration|bidrecords?|bidhistory|^bids$|winningbidder/u.test(normalizedKey(key));
const transportKey = (key: string) => ["headers", "requestheaders", "body", "requestbody"].includes(normalizedKey(key));
class EvidenceUnavailable extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function unavailable(reason: string): never { throw new EvidenceUnavailable(reason); }

function sanitizeText(value: string, counts: SourceParserEvidenceRedactions): string {
  // Reserved encoded delimiters can conceal arbitrarily nested credentials or
  // URL components. Decline that ambiguous representation without decoding it.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|2[0-9a-f]|3[a-f]|40|5[b-d]|60|7[b-d])/iu.test(value)) unavailable("unsafe_encoded_url_text");
  let result = value.replace(/https?:\/\/[^\s<>"'`]+/giu, (raw) => {
    let url: URL;
    try { url = new URL(raw); } catch { unavailable("unsafe_url_text"); }
    if (!url.username && !url.password && !url.search && !url.hash) return raw;
    if (url.username || url.password) counts.urlUserInfo++;
    if (url.search) counts.urlQueries++;
    if (url.hash) counts.urlFragments++;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  });
  result = result.replace(/(^|[\s("'`])((?:\/\/|\.?\.?\/)[^\s<>"'`]+)/giu, (whole, lead: string, raw: string) => {
    if (!raw.includes("?") && !raw.includes("#") && !/^\/\/[^/]*@/u.test(raw)) return whole;
    if (raw.startsWith("//")) {
      let url: URL;
      try { url = new URL(`https:${raw}`); } catch { unavailable("unsafe_url_text"); }
      if (url.username || url.password) counts.urlUserInfo++;
      if (url.search) counts.urlQueries++;
      if (url.hash) counts.urlFragments++;
      return `${lead}//${url.host}${url.pathname}`;
    }
    if (raw.includes("?")) counts.urlQueries++;
    if (raw.includes("#")) counts.urlFragments++;
    return `${lead}${raw.split(/[?#]/u, 1)[0]}`;
  });
  // A bare relative query target has no reliable base/URL contract. Decline it.
  if (/(?:^|\s)[^\s<>"'`]+\?[^\s<>"'`]+/u.test(result)) unavailable("unsafe_relative_url_text");
  result = result.replace(/\b(?:auth|authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, () => {
    counts.inlineCredentials++; return "[credential redacted]";
  }).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, (_whole, scheme: string) => {
    counts.inlineCredentials++; return `${scheme} [redacted]`;
  }).replace(/\b(?:auth|pwd|password|passwd|secret|(?:api[_-]?)?key|(?:access[_-]?|refresh[_-]?)?token|session(?:[_-]?id)?|capability|credential)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, () => {
    counts.inlineCredentials++; return "[credential redacted]";
  });
  return result;
}
interface WalkState { nodes: number; counts: SourceParserEvidenceRedactions; ancestors: Set<object> }
function sanitizeJson(value: unknown, state: WalkState, depth = 0, context = false): EvidenceJson {
  if (depth > SOURCE_PARSER_EVIDENCE_LIMITS.depth || ++state.nodes > SOURCE_PARSER_EVIDENCE_LIMITS.nodes) unavailable("json_structure_limit");
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) unavailable("unsafe_json_value"); return value; }
  if (typeof value === "string") return sanitizeText(value, state.counts);
  if (typeof value !== "object" || value === null || state.ancestors.has(value)) unavailable("unsafe_json_value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) unavailable("unsafe_json_value");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) unavailable("unsafe_json_value");
      return value.map((child) => sanitizeJson(child, state, depth + 1, context));
    }
    const result: { [key: string]: EvidenceJson } = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      if (!safeKey(key)) unavailable("unsafe_json_key");
      if (context && (transportKey(key) || credentialKey(key))) unavailable("secret_or_transport_context");
      if (credentialKey(key)) { state.counts.credentialFields++; sanitizeJson(child, state, depth + 1); continue; }
      if (personalBidKey(key)) { state.counts.personalBidFields++; sanitizeJson(child, state, depth + 1); continue; }
      result[key] = sanitizeJson(child, state, depth + 1, context);
    }
    return result;
  } finally { state.ancestors.delete(value); }
}
function parseBody(body: unknown): EvidenceJson {
  if (typeof body !== "string" || bytes(body) > SOURCE_PARSER_EVIDENCE_LIMITS.packetBytes) unavailable("evidence_byte_limit");
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { unavailable("invalid_json_body"); }
  if (parsed === null || typeof parsed !== "object") unavailable("unsupported_json_document");
  return parsed as EvidenceJson;
}
function pageMetadata(page: unknown): asserts page is SourceParserEvidencePage {
  if (!record(page) || !exactKeys(page, ["url", "body", "fetchedAt"], ["contentType"]) ||
    typeof page.url !== "string" || bytes(page.url) > 2_000 || !timestamp(page.fetchedAt) || !jsonContentType(page.contentType)) unavailable("unsupported_page_metadata");
  let url: URL;
  try { url = new URL(page.url); } catch { unavailable("page_url_not_replayable"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) unavailable("page_url_not_replayable");
}
function diagnostic(value: unknown, counts: SourceParserEvidenceRedactions): { errorCode: string; message: string } {
  if (!record(value) || !exactKeys(value, ["errorCode", "message"]) || typeof value.errorCode !== "string" ||
    typeof value.message !== "string" || !/^[A-Za-z][A-Za-z0-9_:.-]{0,119}$/u.test(value.errorCode)) unavailable("invalid_diagnostic");
  const message = sanitizeText(value.message, counts).replace(/\b[A-Z]:[\\/][^\r\n"<>]+/giu, "[local path]").replace(/[\u0000-\u001f\u007f]/gu, " ");
  if (bytes(message) > SOURCE_PARSER_EVIDENCE_LIMITS.diagnosticBytes) unavailable("diagnostic_byte_limit");
  return { errorCode: value.errorCode, message };
}
function identity(sourceId: unknown, sourceRunId: unknown): void {
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId) || typeof sourceRunId !== "string" || !RUN_ID.test(sourceRunId)) unavailable("invalid_evidence_identity");
}
export function sourceParserEvidenceKey(sourceRunId: string): string {
  if (!RUN_ID.test(sourceRunId)) throw new Error("invalid_evidence_identity");
  return `source-repair-evidence/v1/${sourceRunId}.json`;
}
export async function sourceParserEvidenceBodyHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function captureSourceParserEvidence(input: SourceParserEvidenceCaptureInput): Promise<SourceParserEvidenceCapture> {
  try {
    if (!record(input) || !exactKeys(input, ["sourceId", "sourceRunId", "observedAt", "diagnostic", "page"], ["operation", "expectedListings", "plannedPage"])) unavailable("unsupported_evidence_input");
    identity(input.sourceId, input.sourceRunId);
    if (!timestamp(input.observedAt)) unavailable("invalid_evidence_timestamp");
    pageMetadata(input.page);
    if (owns(input, "operation") && !operations.includes(input.operation)) unavailable("invalid_replay_context");
    if (input.expectedListings !== undefined && (!Number.isSafeInteger(input.expectedListings) || input.expectedListings < 0)) unavailable("invalid_replay_context");
    const counts = redactions();
    const state: WalkState = { nodes: 0, counts, ancestors: new Set() };
    const body = JSON.stringify(sanitizeJson(parseBody(input.page.body), state));
    let plannedPage: { [key: string]: EvidenceJson } | undefined;
    if (input.plannedPage !== undefined) {
      if (!record(input.plannedPage)) unavailable("invalid_replay_context");
      plannedPage = sanitizeJson(input.plannedPage, state, 0, true) as { [key: string]: EvidenceJson };
    }
    const safeDiagnostic = diagnostic(input.diagnostic, counts);
    const packet: SourceParserEvidencePacket = {
      schemaVersion: SOURCE_PARSER_EVIDENCE_SCHEMA, sourceId: input.sourceId, sourceRunId: input.sourceRunId, observedAt: input.observedAt,
      originalBodyHash: await sourceParserEvidenceBodyHash(input.page.body), sanitizedBodyHash: await sourceParserEvidenceBodyHash(body),
      diagnostic: safeDiagnostic,
      replay: { kind: "discovery_page", page: { url: input.page.url, body, fetchedAt: input.page.fetchedAt, contentType: input.page.contentType },
        ...(input.operation !== undefined ? { operation: input.operation } : {}), ...(input.expectedListings !== undefined ? { expectedListings: input.expectedListings } : {}), ...(plannedPage ? { plannedPage } : {}) },
      metadata: { redactions: counts },
    };
    const serializedPacket = JSON.stringify(packet);
    const byteLength = bytes(serializedPacket);
    if (byteLength > SOURCE_PARSER_EVIDENCE_LIMITS.packetBytes) unavailable("evidence_byte_limit");
    return { available: true, packet, key: sourceParserEvidenceKey(input.sourceRunId), serializedPacket, byteLength };
  } catch (error) {
    return { available: false, reason: error instanceof EvidenceUnavailable ? error.reason : "evidence_capture_unavailable" };
  }
}

/** Verifies identity, sanitization, packet limits and the retained sanitized-body hash. */
export async function validateSourceParserEvidencePacket(value: unknown, expected: { sourceId: string; sourceRunId: string }): Promise<SourceParserEvidencePacket> {
  try {
    identity(expected.sourceId, expected.sourceRunId);
    if (!record(value) || !exactKeys(value, ["schemaVersion", "sourceId", "sourceRunId", "observedAt", "originalBodyHash", "sanitizedBodyHash", "diagnostic", "replay", "metadata"]) ||
      value.schemaVersion !== SOURCE_PARSER_EVIDENCE_SCHEMA || value.sourceId !== expected.sourceId || value.sourceRunId !== expected.sourceRunId ||
      !timestamp(value.observedAt) || typeof value.originalBodyHash !== "string" || !SHA256.test(value.originalBodyHash) ||
      typeof value.sanitizedBodyHash !== "string" || !SHA256.test(value.sanitizedBodyHash)) unavailable("invalid_evidence_packet");
    if (bytes(JSON.stringify(value)) > SOURCE_PARSER_EVIDENCE_LIMITS.packetBytes) unavailable("evidence_byte_limit");
    if (!record(value.replay) || !exactKeys(value.replay, ["kind", "page"], ["operation", "expectedListings", "plannedPage"]) || value.replay.kind !== "discovery_page") unavailable("invalid_evidence_packet");
    pageMetadata(value.replay.page);
    if (owns(value.replay, "operation") && !operations.includes(value.replay.operation)) unavailable("invalid_replay_context");
    if (owns(value.replay, "expectedListings") && (!Number.isSafeInteger(value.replay.expectedListings) || (value.replay.expectedListings as number) < 0)) unavailable("invalid_replay_context");
    const counts = redactions();
    const state: WalkState = { nodes: 0, counts, ancestors: new Set() };
    const body = JSON.stringify(sanitizeJson(parseBody(value.replay.page.body), state));
    if (body !== value.replay.page.body) unavailable("evidence_body_not_sanitized");
    if (owns(value.replay, "plannedPage")) {
      if (!record(value.replay.plannedPage) || JSON.stringify(sanitizeJson(value.replay.plannedPage, state, 0, true)) !== JSON.stringify(value.replay.plannedPage)) unavailable("invalid_replay_context");
    }
    if (JSON.stringify(diagnostic(value.diagnostic, counts)) !== JSON.stringify(value.diagnostic)) unavailable("evidence_diagnostic_not_sanitized");
    if (!record(value.metadata) || !exactKeys(value.metadata, ["redactions"]) || !record(value.metadata.redactions) ||
      !exactKeys(value.metadata.redactions, Object.keys(redactions())) || Object.values(value.metadata.redactions).some((count) => !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > SOURCE_PARSER_EVIDENCE_LIMITS.packetBytes)) unavailable("invalid_redaction_metadata");
    if (await sourceParserEvidenceBodyHash(body) !== value.sanitizedBodyHash) unavailable("evidence_body_hash_mismatch");
    return value as unknown as SourceParserEvidencePacket;
  } catch (error) {
    throw new Error(error instanceof EvidenceUnavailable ? error.reason : "invalid_evidence_packet");
  }
}

interface ModelFocus { path: string[]; value: EvidenceJson; score: number }
/** A text/structure preview, never the entire large replay document. */
export function sourceParserEvidenceModelContext(packet: SourceParserEvidencePacket): string {
  try {
    const root = parseBody(packet.replay.page.body);
    const state: WalkState = { nodes: 0, counts: redactions(), ancestors: new Set() };
    const safe = sanitizeJson(root, state);
    if (JSON.stringify(safe) !== packet.replay.page.body) unavailable("evidence_body_not_sanitized");
    const safeDiagnostic = diagnostic(packet.diagnostic, redactions());
    const identifiers = new Set(safeDiagnostic.message.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/giu) ?? []);
    const messageWithoutIds = safeDiagnostic.message.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/giu, " ").toLowerCase();
    const words = new Set((messageWithoutIds.match(/[a-z][a-z0-9_]{3,63}/gu) ?? []).filter((word) => !["must", "string", "listing", "source", "invalid", "failed", "array", "object"].includes(word)));
    const namedFields = new Set([...messageWithoutIds.matchAll(/\b([a-z_][a-z0-9_]{0,63})\s+(?:must\b|is\s+(?:missing|invalid)\b)/gu)].map((match) => match[1]!));
    const focus: ModelFocus[] = [];
    const fieldScore = (value: EvidenceJson) => record(value) ? Object.keys(value).reduce((score, key) => score + (namedFields.has(key.toLowerCase()) ? 30 : words.has(key.toLowerCase()) ? 10 : 0), 0) : 0;
    const containerScore = (path: string[]) => /\blisting\b/u.test(messageWithoutIds) && path.some((key) => /^listings?$/iu.test(key)) ? 20 : 0;
    const visit = (value: EvidenceJson, path: string[]) => {
      if (Array.isArray(value)) { value.forEach((child, index) => visit(child, [...path, String(index)])); return; }
      if (!record(value)) return;
      let score = 0;
      for (const [key, child] of Object.entries(value)) {
        if (identifiers.has(key) || typeof child === "string" && identifiers.has(child)) score = 100;
        else if (words.has(key.toLowerCase())) score = Math.max(score, 10);
      }
      if (score) focus.push({ path, value, score: score + fieldScore(value) + containerScore(path) });
      for (const [key, child] of Object.entries(value)) {
        if (identifiers.has(key) && (record(child) || Array.isArray(child))) focus.push({ path: [...path, key], value: child, score: 200 + fieldScore(child) + containerScore([...path, key]) });
        visit(child, [...path, key]);
      }
    };
    visit(safe, []);
    const selected: ModelFocus[] = [];
    const hasIdentity = focus.some((item) => item.score >= 100);
    const prefix = (a: string[], b: string[]) => a.length <= b.length && a.every((key, index) => key === b[index]);
    for (const item of focus.sort((a, b) => b.score - a.score || b.path.length - a.path.length)) {
      if (hasIdentity && item.score < 100 || selected.some((other) => prefix(item.path, other.path) || prefix(other.path, item.path))) continue;
      selected.push(item); if (selected.length === 2) break;
    }
    const rootShape = { type: Array.isArray(safe) ? "array" : "object", count: Array.isArray(safe) ? safe.length : Object.keys(safe as object).length,
      keys: record(safe) ? Object.keys(safe).slice(0, 24) : undefined };
    for (const limit of [16, 8, 4, 0]) {
      let remaining = limit * 4;
      const preview = (value: EvidenceJson, depth = 0): unknown => {
        if (--remaining < 0 || depth > 4) return { type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, omitted: true };
        if (typeof value === "string") { const prefix = value.slice(0, limit * 32); return { type: "string", text: prefix, truncated: prefix.length !== value.length }; }
        if (value === null || typeof value !== "object") return { type: value === null ? "null" : typeof value, value };
        if (Array.isArray(value)) return { type: "array", count: value.length, items: value.slice(0, 3).map((child) => preview(child, depth + 1)), omittedItems: Math.max(0, value.length - 3) };
        const entries = Object.entries(value).sort(([a], [b]) => Number(namedFields.has(b.toLowerCase())) - Number(namedFields.has(a.toLowerCase())) || Number(words.has(b.toLowerCase())) - Number(words.has(a.toLowerCase())));
        return { type: "object", count: entries.length, fields: entries.slice(0, limit).map(([key, child]) => ({ key, ...preview(child, depth + 1) as object })), omittedFields: Math.max(0, entries.length - limit) };
      };
      const result = JSON.stringify({ schemaVersion: packet.schemaVersion, sourceId: packet.sourceId, sourceRunId: packet.sourceRunId,
        diagnostic: safeDiagnostic, operation: packet.replay.operation ?? "parse_page", redactions: packet.metadata.redactions, root: rootShape,
        focus: limit ? selected.map((item) => ({ path: item.path,
          diagnosticFields: [...namedFields].map((name) => {
            const key = record(item.value) ? Object.keys(item.value).find((field) => field.toLowerCase() === name) : undefined;
            return key === undefined ? { name, present: false } : { name: key, present: true, structure: preview((item.value as { [key: string]: EvidenceJson })[key]!) };
          }), structure: preview(item.value) })) : [],
        scope: "Bounded sanitized context only; the full replay document is retained separately." });
      if (bytes(result) <= SOURCE_PARSER_EVIDENCE_LIMITS.modelContextBytes) return result;
    }
    throw new Error("model_context_limit");
  } catch { throw new Error("evidence_model_context_unavailable"); }
}
