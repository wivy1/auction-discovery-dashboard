import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireRepairLock, classifyFailure, containedPath, extractionLiterals, hash, LEGACY_REPAIR_CAPABILITY, LIMITS, listJobs, prepareJobs, proposalPrompt, proposalRequest, proposalResponseSchema, REPAIR_CAPABILITY, REPAIR_GENERATION_POLICY, REPAIR_SCHEMA, sanitizeDiagnostic, validateProposal, writeJson, type FailureDiagnostic } from "../../lib/source-repair/core.ts";
import { validateRepairTarget } from "../../lib/source-repair/config.ts";
import { REPAIR_STORE_LIMITS } from "../../lib/source-repair/storage.ts";

const base = 'function requiredText(value:any,label:string){if(typeof value!=="string")throw new TypeError(`${label} must be a string`);return value;}function normalizeListing(raw:any){const description=requiredText(raw.description,"description");return {id:raw.id,description};}export const adapter={normalizeListing};';
const diagnostic: FailureDiagnostic = { sourceId: "fixture-json", errorCode: "SourceAdapterError", message: "description must be a string", observedAt: "2026-01-01T00:00:00Z", evidence: "source_run", sourceRunId: "run-one" };
async function fixture(code = base) {
  const root = await mkdtemp(join(tmpdir(), "repair-core-"));
  const target = { sourceId: diagnostic.sourceId, adapterPath: "source-adapters.local/example/adapter.ts", testFiles: ["source-adapters.local/example/adapter.test.ts"], files: ["source-adapters.local/example/page.json"] };
  for (const [path, text] of [[target.adapterPath, code], [target.testFiles[0]!, "export {};"], [target.files[0]!, '{"items":[{"id":"one","description":null}]}']]) {
    await mkdir(dirname(join(root, path!)), { recursive: true }); await writeFile(join(root, path!), text!);
  }
  return { root, target: await validateRepairTarget(root, target), base: code };
}
test("prepare is bound to explicit local target and preserves an unchanged case", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await prepareJobs(f.root, [diagnostic], { targets: [f.target] });
  assert.equal(first.created, 1); assert.equal(first.jobs[0]!.capability, REPAIR_CAPABILITY); assert.equal(first.jobs[0]!.generationPolicy, REPAIR_GENERATION_POLICY);
  const second = await prepareJobs(f.root, [{ ...diagnostic, sourceRunId: "run-two", observedAt: "2026-01-02T00:00:00Z" }], { targets: [f.target] });
  assert.equal(second.created, 0); assert.equal(second.jobs[0]!.id, first.jobs[0]!.id); assert.equal(second.jobs[0]!.sourceRunId, "run-one");
  assert.equal(first.jobs[0]!.targetHash, f.target.targetHash); assert.equal(first.jobs[0]!.model, undefined);
  assert.equal((await prepareJobs(f.root, [diagnostic])).skippedReason, "repair_config_missing");
  assert.equal((await prepareJobs(f.root, [{ ...diagnostic, sourceId: "unapproved" }], { targets: [f.target] })).created, 0);
});
test("strict response schema supplies only admitted data expressions", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!;
  const { prompt, schema } = proposalRequest(job, f.base, { evidenceContext: '{"description":null}' });
  assert.deepEqual(schema.properties.edits.items.properties.before.enum, ["raw.description"]);
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.adapterPath.const, f.target.adapterPath);
  const value = { schemaVersion: REPAIR_SCHEMA, sourceId: job.sourceId, adapterPath: job.adapterPath, baseHash: job.adapterHash, edits: [{ before: "raw.description", after: 'raw.description === null ? "" : raw.description' }], explanation: "Explicit null in saved evidence; all non-null validation remains." };
  const result = validateProposal(JSON.stringify(value), job, base, schema); assert.equal(result.abstained, false); assert.match(result.candidate, /requiredText\(raw.description === null/u);
  assert.throws(() => validateProposal(JSON.stringify({ ...value, adapterPath: "tests/fixture.ts" }), job, base, schema), /proposal_contract_invalid/u);
  assert.throws(() => validateProposal(JSON.stringify({ ...value, edits: [{ before: 'requiredText(raw.description,"description")', after: "raw.description" }] }), job, base, schema), /proposal_before_not_in_schema/u);
  assert.throws(() => validateProposal(JSON.stringify(value), job, base + " ", schema), /proposal_contract_invalid/u);
  assert.equal(validateProposal(JSON.stringify({ ...value, edits: [], explanation: "Missing reproducer; abstain." }), job, base, schema).abstained, true);
  assert.match(prompt, /missing, number, object and array/u);
});
test("legacy literal profile remains separate for fresh HTML failures", async (t) => {
  const code = 'function parseListing(raw:any){const match=raw.html.match(/title=(\\w+)/);const title=match[1];return {title};}export const adapter={parseListing};';
  const f = await fixture(code); t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(extractionLiterals(code).length, 1);
  const prepared = await prepareJobs(f.root, [diagnostic], { targets: [f.target] }); assert.equal(prepared.created, 2);
  const job = prepared.jobs.find((entry) => entry.capability === LEGACY_REPAIR_CAPABILITY)!;
  const request = proposalRequest(job, code); assert.match(request.prompt, /does not establish protected-value equivalence/u);
  const before = extractionLiterals(code)[0]!.text;
  const proposal = { schemaVersion: REPAIR_SCHEMA, sourceId: job.sourceId, adapterPath: job.adapterPath, baseHash: hash(code), edits: [{ before, after: '/heading=(\\w+)/' }], explanation: "Proposal only, missing live reproducer." };
  assert.match(validateProposal(JSON.stringify(proposal), job, code, request.schema).candidate, /heading=/u);
  assert.throws(() => validateProposal(JSON.stringify({ ...proposal, edits: [{ before, after: '"heading"' }] }), job, code), /replacement_not_extraction_literal/u);
});
test("access failures and unknown ownership are diagnostic only", () => {
  for (const [errorCode, message, reason] of [["http_403", "denied", "access_boundary_requires_external_resolution"], ["SourceAdapterError", "rate limit", "access_boundary_requires_external_resolution"], ["invalid_marker", "marker missing", "browser_marker_outside_adapter_parser"], ["unknown", "failed", "failure_outside_known_parser_ownership"]]) {
    assert.deepEqual(classifyFailure({ ...diagnostic, errorCode: errorCode!, message: message! }), { disposition: "diagnostic_only", reason });
  }
});
test("target support change cannot reuse a previous proof", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const original = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!;
  await writeFile(join(f.root, f.target.files[0]!), "{}");
  await assert.rejects(prepareJobs(f.root, [diagnostic], { targets: [f.target] }), /repair_target_changed_since_preparation/u);
  const fresh = await validateRepairTarget(f.root, { sourceId: f.target.sourceId, adapterPath: f.target.adapterPath, testFiles: f.target.testFiles, files: f.target.files });
  const next = (await prepareJobs(f.root, [diagnostic], { targets: [fresh] })).jobs[0]!; assert.notEqual(next.id, original.id);
});
test("full repair store rejects preparation without adding a job", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await prepareJobs(f.root, [diagnostic], { targets: [f.target], measureStorage: async () => ({ usedBytes: REPAIR_STORE_LIMITS.bytes, freeBytes: 10_000_000_000 }) });
  assert.equal(result.skippedReason, "repair_store_byte_limit"); assert.equal(result.created, 0);
  assert.deepEqual(await listJobs(join(f.root, "work", "source-repairs")), []);
});
test("failed unpublished lock owner write does not block the next batch", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(acquireRepairLock(f.root, { writeOwner: async () => { throw new Error("fixture owner write failure"); } }), /fixture owner/u);
  const release = await acquireRepairLock(f.root); assert.ok(release); assert.equal(await acquireRepairLock(f.root), null); await release!();
  const again = await acquireRepairLock(f.root); assert.ok(again); await again!();
});
test("receipt and diagnostic boundaries preserve no arbitrary paths or secrets", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const path of ["../outside", "/absolute", "x\\y", "x/../y"]) assert.throws(() => containedPath(f.root, path), /unsafe_relative_path/u);
  const text = sanitizeDiagnostic('https://example.com/items?token=fixture-value authorization=fixture-key C:\\private\\file.txt');
  assert.doesNotMatch(text, /fixture-value|fixture-key|private\\/u);
  const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!;
  await writeJson(join(f.root, "work", "source-repairs"), `${job.id}/job.json`, job);
  assert.equal((await listJobs(join(f.root, "work", "source-repairs")))[0]!.id, job.id);
  assert.equal((await readFile(join(f.root, "work", "source-repairs", job.id, "adapter-base.ts"), "utf8")), base);
});
test("fixture-code sanitizer preserves line breaks while default diagnostics stay identical", () => {
  const value = "alpha\r\nbeta\u0000\tgamma\nhttps://example.com/items?token=fixture-query#fragment\npassword=fixture-value\nC:\\fixture\\file.ts\nBearer fixturelong12345";
  const expected = "alpha beta gamma https://example.com/items [credential redacted] [local path] Bearer [redacted]";
  assert.equal(sanitizeDiagnostic(value), expected); assert.equal(sanitizeDiagnostic(value, 2_000, { preserveLineBreaks: false }), expected);
  assert.equal(sanitizeDiagnostic(value, 2_000, { preserveLineBreaks: true }), "alpha\nbeta gamma\nhttps://example.com/items\n[credential redacted]\n[local path]\nBearer [redacted]");
  assert.equal(sanitizeDiagnostic("\n  first\nsecond\n", 2_000, { preserveLineBreaks: true }), "\n  first\nsecond\n");
});
test("fixture context truncation stays explicit at initial and global request limits", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!;
  const label = `[BEGIN FILE ${f.target.testFiles[0]}; complete redacted content]\n`;
  const large = label + "// immutable source context\n".repeat(150) + `[END FILE ${f.target.testFiles[0]}]`;
  const initiallyBounded = JSON.parse(proposalPrompt(job, base, { fixtureContext: large })).trustedFixtureContext as string;
  assert.ok(initiallyBounded.length <= 3_000); assert.match(initiallyBounded, /truncated; remaining source omitted/u); assert.doesNotMatch(initiallyBounded, /complete redacted content/u);
  const small = label + "// immutable source context\n".repeat(90) + `[END FILE ${f.target.testFiles[0]}]`;
  const original = proposalPrompt(job, base, { evidenceContext: "", fixtureContext: small });
  const overhead = Buffer.byteLength(JSON.stringify({ prompt: original, format: proposalResponseSchema(job, base, original) })) + 2_000;
  const evidenceContext = '"'.repeat(Math.ceil((LIMITS.inputBytes - overhead + 1_500) / 4));
  const request = proposalRequest(job, base, { evidenceContext, fixtureContext: small });
  const fitted = JSON.parse(request.prompt).trustedFixtureContext as string;
  assert.ok(fitted.length < small.length); assert.match(fitted, /(?:truncated|omitted)/iu); assert.doesNotMatch(fitted, /complete redacted content/u);
  assert.ok(Buffer.byteLength(JSON.stringify({ prompt: request.prompt, format: request.schema })) + 2_000 <= LIMITS.inputBytes);
});
