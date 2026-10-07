import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hash, LEGACY_REPAIR_CAPABILITY, prepareJobs, proposalRequest, REPAIR_CAPABILITY, writeJson, type FailureDiagnostic, type ProcessReceipt, type RepairJob, type ValidationReceipt } from "../../lib/source-repair/core.ts";
import { validateRepairTarget } from "../../lib/source-repair/config.ts";
import { generateProposal, ollamaEligibility } from "../../lib/source-repair/diagnostics.ts";
import { repairEvidenceIdentity, repairFixtureContext, runRepairBatch, type WorkflowOptions } from "../../lib/source-repair/workflow.ts";
import type { SourceParserEvidencePacket } from "../../lib/source-repair/evidence.ts";

const base = 'function requiredText(value:any,label:string){if(typeof value!=="string")throw new TypeError(`${label} must be a string`);return value;}function normalizeListing(raw:any){const description=requiredText(raw.description,"description");return {id:raw.id,description};}export const adapter={normalizeListing};';
const model = "local-text:small"; const digest = "a".repeat(64); const at = "2026-01-01T00:00:00Z";
const diagnostic: FailureDiagnostic = { sourceId: "fixture-json", errorCode: "SourceAdapterError", message: "description must be a string", observedAt: at, evidence: "source_run", sourceRunId: "fixture-run" };
const idle = async () => ({ eligible: true, reason: "fixture_idle" });
const noEvidence: NonNullable<WorkflowOptions["loadEvidence"]> = async () => ({ available: false, reason: "source_evidence_missing" });
async function fixture(code = base) {
  const root = await mkdtemp(join(tmpdir(), "repair-feedback-"));
  const target = { sourceId: diagnostic.sourceId, adapterPath: "source-adapters.local/example/adapter.ts", testFiles: ["source-adapters.local/example/adapter.test.ts"], files: ["source-adapters.local/example/page.json"] };
  for (const [path, text] of [[target.adapterPath, code], [target.testFiles[0]!, "export {};"], [target.files[0]!, '{"items":[{"id":"one","description":null}]}']]) {
    await mkdir(dirname(join(root, path!)), { recursive: true }); await writeFile(join(root, path!), text!);
  }
  return { root, target: await validateRepairTarget(root, target), base: code };
}
type Chat = Record<string, any>;
function fakeProvider(output: (body: Chat, number: number) => unknown, metadata: { tag?: Record<string, unknown>; show?: Record<string, unknown>; active?: unknown[]; fail?: string; chatFail?: boolean } = {}) {
  const calls: Array<{ path: string; body?: Chat }> = []; let chats = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; const body = init?.body ? JSON.parse(String(init.body)) as Chat : undefined; calls.push({ path, body });
    if (metadata.fail === path) throw new Error("fixture provider unavailable");
    if (path === "/api/tags") return Response.json({ models: [{ name: model, model, size: 4_000_000, digest, details: { format: "gguf" }, ...metadata.tag }] });
    if (path === "/api/show") return Response.json({ details: { format: "gguf" }, model_info: { "general.architecture": "fixture" }, capabilities: ["completion"], template: "PRIVATE_TEMPLATE_NOT_PERSISTED", modelfile: "PRIVATE_MODELFILE_NOT_PERSISTED", ...metadata.show });
    if (path === "/api/ps") return Response.json({ models: metadata.active ?? [] });
    if (path === "/api/chat") { chats++; if (metadata.chatFail) throw new Error("fixture chat interrupted"); const result = output(body!, chats); return Response.json({ done: true, message: { content: typeof result === "string" ? result : JSON.stringify(result) } }); }
    throw new Error("unexpected fixture request");
  }) as typeof fetch;
  return { fetchImpl, calls, get chats() { return chats; } };
}
function proposal(body: Chat, edits = [{ before: "raw.description", after: 'raw.description === null ? "" : raw.description' }]) {
  const props = body.format.properties;
  return { schemaVersion: props.schemaVersion.const, sourceId: props.sourceId.const, adapterPath: props.adapterPath.const, baseHash: props.baseHash.const, edits, explanation: "Fixture evidence; tested proposal only." };
}
const processReceipt = (overrides: Partial<ProcessReceipt> = {}): ProcessReceipt => ({ exitCode: 0, timedOut: false, outputLimited: false, stdout: "", stderr: "", elapsedMs: 1, ...overrides });
const passed = (): ValidationReceipt => ({ status: "fixtures_passed_reproducer_missing", checkedAt: at, proposalOnly: true, liveFailureReproduced: false, baseline: processReceipt(), candidate: processReceipt(), snapshotHash: hash("fixture snapshot"), candidateHash: hash("fixture candidate") });
const containment = processReceipt({ stdout: JSON.stringify({ schemaVersion: "source-repair-containment-v2", fileDenied: true, immutableDenied: true, tempWritable: true, networkDenied: true, privateMountsAbsent: true, environmentScrubbed: true, networkControl: true, acceptedConnections: 0, count: 4 }) });
const candidateFailed = (): ValidationReceipt => ({ ...passed(), status: "candidate_failed", reason: "candidate_fixture_checks_failed", containment: { ...containment }, candidate: processReceipt({ exitCode: 1, stdout: "TAP version 13\nnot ok 1 - description preserves validation\n# fail 1" }) });
function options(f: Awaited<ReturnType<typeof fixture>>, provider: ReturnType<typeof fakeProvider>): WorkflowOptions {
  return { noAi: false, model, targets: [f.target], diagnostics: [diagnostic], loadEvidence: noEvidence, checkIdle: idle, fetchImpl: provider.fetchImpl, validate: async () => passed() };
}
test("installed local completion metadata admits only a bounded schema request", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = fakeProvider((body) => proposal(body)); const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!;
  const request = proposalRequest(job, base); let dispatches = 0;
  const result = await generateProposal("http://127.0.0.1:11434", request.prompt, provider.fetchImpl, undefined, request.schema, { model, expectedDigest: digest, onDispatch: () => dispatches++ });
  assert.equal(JSON.parse(result).sourceId, diagnostic.sourceId); assert.equal(dispatches, 1); assert.equal(provider.chats, 1);
  assert.deepEqual(provider.calls.find((call) => call.path === "/api/show")!.body, { model, verbose: false });
  const chat = provider.calls.find((call) => call.path === "/api/chat")!.body!;
  assert.equal(chat.model, model); assert.equal(chat.format.additionalProperties, false); assert.equal(chat.keep_alive, 0); assert.equal(chat.options.num_predict, 2_000);
  await assert.rejects(generateProposal("http://127.0.0.1:11434", "x", provider.fetchImpl), /repair_response_schema_required/u);
});
test("cloud aliases, remote metadata, unknown format and unsupported capabilities dispatch no chat", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!; const request = proposalRequest(job, base);
  for (const metadata of [
    { tag: { remote_host: "https://example.com", remote_model: "remote-text" } },
    { tag: { model: "alias:cloud" } }, { tag: { size: 0 } }, { tag: { digest: "unknown" } }, { tag: { details: { format: "unknown" } } },
    { show: { remote_host: "https://example.com" } }, { show: { remote_model: "remote-text" } },
    { show: { capabilities: ["embedding"] } }, { show: { model_info: {} } }, { show: { details: { format: "unknown" } } },
  ]) {
    const provider = fakeProvider((body) => proposal(body), metadata); const eligibility = await ollamaEligibility("http://127.0.0.1:11434", model, provider.fetchImpl);
    assert.equal(eligibility.eligible, false); await assert.rejects(generateProposal("http://127.0.0.1:11434", request.prompt, provider.fetchImpl, undefined, request.schema, { model })); assert.equal(provider.chats, 0);
  }
  const cloud = fakeProvider((body) => proposal(body)); assert.equal((await ollamaEligibility("http://127.0.0.1:11434", "text:cloud", cloud.fetchImpl)).reason, "repair_model_must_be_local"); assert.equal(cloud.calls.length, 0);
});
test("whole-declaration rejection is corrected once with the same admitted schema", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = fakeProvider((body, number) => number === 1 ? proposal(body, [{ before: 'const description=requiredText(raw.description,"description");', after: 'const description="";' }]) : proposal(body));
  const result = await runRepairBatch(f.root, at, at, options(f, provider));
  assert.equal(result.attempted, 2); assert.equal(result.jobs[0]!.requestCount, 2); assert.equal(result.jobs[0]!.state, "fixtures_passed_reproducer_missing");
  assert.equal("liveFailureReproduced" in result.jobs[0]!, false); assert.equal(result.jobs[0]!.validation!.liveFailureReproduced, false);
  const chats = provider.calls.filter((call) => call.path === "/api/chat"); assert.deepEqual(chats[0]!.body!.format, chats[1]!.body!.format); assert.match(chats[1]!.body!.messages[1].content, /correctionFeedback/u);
  const store = join(f.root, "work", "source-repairs", result.jobs[0]!.id); assert.deepEqual(await readdir(join(store, "attempts")), ["01", "02"]);
  assert.match(await readFile(join(store, "attempts", "01", "decision.json"), "utf8"), /proposal_before_not_in_schema/u);
  assert.doesNotMatch(await readFile(join(store, "attempts", "01", "input.json"), "utf8"), /PRIVATE_TEMPLATE|PRIVATE_MODELFILE/u);
  const repeat = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(repeat.attempted, 0); assert.equal(provider.chats, 2);
});
test("pending correction resumes with its remaining durable request allowance", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = fakeProvider((body, number) => number === 1 ? proposal(body, [{ before: "not an admitted site", after: '""' }]) : proposal(body));
  const first = await runRepairBatch(f.root, at, at, { ...options(f, provider), limit: 1 }); assert.equal(first.jobs[0]!.state, "correction_pending"); assert.equal(first.attempted, 1);
  const next = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(next.attempted, 1); assert.equal(next.jobs[0]!.requestCount, 2); assert.equal(next.jobs[0]!.state, "fixtures_passed_reproducer_missing");
});
test("exhausted rejection across two profiles never exceeds global two chats or resets", async (t) => {
  const code = 'function parseListing(raw:any){const match=raw.html.match(/title=(\\w+)/);const title=match[1];return {title};}export const adapter={parseListing};';
  const f = await fixture(code); t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = fakeProvider((body) => proposal(body, [{ before: "unavailable", after: '""' }]));
  const first = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(first.jobs.length, 2); assert.equal(first.attempted, 2); assert.equal(first.jobs.find((job) => job.capability === REPAIR_CAPABILITY)!.requestCount, 2); assert.equal(first.jobs.find((job) => job.capability === LEGACY_REPAIR_CAPABILITY)!.requestCount, 0);
  const next = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(next.attempted, 2); assert.equal(provider.chats, 4);
  const exhausted = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(exhausted.attempted, 0); assert.equal(provider.chats, 4);
});
test("fresh legacy profile can generate, while missing evidence remains explicit", async (t) => {
  const code = 'function parseListing(raw:any){const match=raw.html.match(/title=(\\w+)/);const title=match[1];return {title};}export const adapter={parseListing};';
  const f = await fixture(code); t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = await prepareJobs(f.root, [diagnostic], { targets: [f.target] }); const expression = prepared.jobs.find((job) => job.capability === REPAIR_CAPABILITY)!; expression.state = "abstained";
  await writeJson(join(f.root, "work", "source-repairs"), `${expression.id}/job.json`, expression);
  const provider = fakeProvider((body) => proposal(body, [{ before: body.format.properties.edits.items.properties.before.enum[0], after: '/heading=(\\w+)/' }]));
  const result = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(result.attempted, 1); assert.equal(result.jobs.find((job) => job.capability === LEGACY_REPAIR_CAPABILITY)!.state, "fixtures_passed_reproducer_missing");
});
test("saved validation resumes without inference and verbose receipts remain listable", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = fakeProvider((body) => proposal(body)); let idleChecks = 0;
  const first = await runRepairBatch(f.root, at, at, { ...options(f, provider), checkIdle: async () => ({ eligible: ++idleChecks < 5, reason: "new_discovery" }) });
  assert.equal(first.jobs[0]!.state, "validation_deferred"); assert.equal(first.attempted, 1);
  const result = await runRepairBatch(f.root, at, at, { ...options(f, provider), validate: async () => ({ ...passed(), baseline: processReceipt({ stdout: "x".repeat(240_000) }), candidate: processReceipt({ stdout: "y".repeat(240_000) }) }) });
  assert.equal(result.attempted, 0); assert.equal(result.jobs[0]!.state, "fixtures_passed_reproducer_missing"); assert.equal(provider.chats, 1);
  assert.ok(Buffer.byteLength(await readFile(join(f.root, "work", "source-repairs", result.jobs[0]!.id, "job.json"))) < 64_000);
  assert.equal((await runRepairBatch(f.root, at, at, options(f, provider))).attempted, 0);
});
test("only ordinary candidate assertions with sound baseline and containment allow correction", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const provider = fakeProvider((body) => proposal(body)); let validations = 0;
  const result = await runRepairBatch(f.root, at, at, { ...options(f, provider), validate: async () => ++validations === 1 ? candidateFailed() : passed() });
  assert.equal(result.attempted, 2); assert.equal(validations, 2); assert.equal(result.jobs[0]!.state, "fixtures_passed_reproducer_missing");
});
for (const stop of ["sandbox_unavailable", "baseline_failed", "timeout", "worker_signal", "missing_dependency", "containment_failed"] as const) test(`${stop} stops after one chat without correction`, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const provider = fakeProvider((body) => proposal(body));
  const receipt = candidateFailed();
  if (stop === "sandbox_unavailable") receipt.status = "sandbox_unavailable";
  if (stop === "baseline_failed") receipt.baseline!.exitCode = 1;
  if (stop === "timeout") receipt.candidate!.timedOut = true;
  if (stop === "worker_signal") receipt.candidate!.stdout += "\n# test worker terminated signal SIGXCPU";
  if (stop === "missing_dependency") receipt.candidate!.stderr = "ERR_MODULE_NOT_FOUND";
  if (stop === "containment_failed") receipt.containment!.exitCode = 1;
  const result = await runRepairBatch(f.root, at, at, { ...options(f, provider), validate: async () => receipt }); assert.equal(result.attempted, 1); assert.equal(result.jobs[0]!.requestCount, 1);
  assert.notEqual(result.jobs[0]!.state, "correction_pending"); assert.equal((await runRepairBatch(f.root, at, at, options(f, provider))).attempted, 0);
});
test("provider failure consumes an uncertain reservation without automatic retry", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const provider = fakeProvider((body) => proposal(body), { chatFail: true });
  const first = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(first.attempted, 1); assert.equal(first.jobs[0]!.state, "generation_failed");
  const next = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(next.attempted, 0); assert.equal(provider.chats, 1);
});
test("metadata failure after reservation records zero chat and never resets that reservation", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const provider = fakeProvider((body) => proposal(body)); let shows = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { if (new URL(String(input)).pathname === "/api/show" && ++shows === 3) return Response.json({ remote_model: "remote-text" }); return provider.fetchImpl(input, init); }) as typeof fetch;
  const first = await runRepairBatch(f.root, at, at, { ...options(f, provider), fetchImpl }); assert.equal(first.attempted, 0); assert.equal(first.jobs[0]!.requestCount, 1); assert.equal(first.jobs[0]!.state, "generation_failed"); assert.equal(provider.chats, 0);
  const output = JSON.parse(await readFile(join(f.root, "work", "source-repairs", first.jobs[0]!.id, "attempts", "01", "output.json"), "utf8")); assert.equal(output.chatDispatched, false);
  assert.equal((await runRepairBatch(f.root, at, at, options(f, provider))).attempted, 0);
});
test("disabled preparation can bind its first model later but a reserved model cannot change", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const provider = fakeProvider((body) => proposal(body, [{ before: "unavailable", after: '""' }]));
  const prepared = await runRepairBatch(f.root, at, at, { ...options(f, provider), noAi: true, model: undefined }); assert.equal(prepared.attempted, 0); assert.equal(prepared.jobs[0]!.model, undefined);
  const first = await runRepairBatch(f.root, at, at, { ...options(f, provider), limit: 1 }); assert.equal(first.jobs[0]!.model, model); assert.equal(first.jobs[0]!.id, prepared.jobs[0]!.id);
  const changed = await runRepairBatch(f.root, at, at, { ...options(f, provider), model: "another-local:small" }); assert.equal(changed.attempted, 0); assert.equal(changed.jobs[0]!.requestCount, 1);
});
test("disabled default, active ownership and stale target dispatch no chat", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const provider = fakeProvider((body) => proposal(body));
  assert.equal((await runRepairBatch(f.root, at, at, { ...options(f, provider), noAi: undefined })).attempted, 0);
  assert.equal((await runRepairBatch(f.root, at, at, { ...options(f, provider), checkIdle: async () => ({ eligible: false, reason: "busy" }) })).skippedReason, "busy");
  await writeFile(join(f.root, f.target.testFiles[0]!), "export const changed=true;"); await assert.rejects(runRepairBatch(f.root, at, at, options(f, provider)), /repair_target_changed_since_preparation/u); assert.equal(provider.chats, 0);
});
test("evidence identity ignores capture times but binds the trusted replay operation", () => {
  const packet = { schemaVersion: "source-parser-evidence-v1", sourceId: diagnostic.sourceId, sourceRunId: "one", observedAt: at, sanitizedBodyHash: digest, replay: { kind: "discovery_page", page: { url: "https://example.com/items", body: "{}", fetchedAt: at, contentType: "application/json" } } } as SourceParserEvidencePacket;
  assert.equal(repairEvidenceIdentity(packet), repairEvidenceIdentity({ ...packet, sourceRunId: "two", observedAt: "2026-02-02T00:00:00Z", replay: { ...packet.replay, operation: "parse_page", page: { ...packet.replay.page, fetchedAt: "2026-02-02T00:00:00Z" } } }));
  assert.notEqual(repairEvidenceIdentity(packet), repairEvidenceIdentity({ ...packet, replay: { ...packet.replay, operation: "plan_inventory" } }));
  assert.notEqual(repairEvidenceIdentity(packet), repairEvidenceIdentity({ ...packet, replay: { ...packet.replay, operation: "validate_page" } }));
});
test("malformed saved receipts cannot select an unapproved or mismatched target", async (t) => {
  for (const mutate of [
    (job: RepairJob) => { job.sourceId = "unapproved"; delete (job as Partial<RepairJob>).targetHash; },
    (job: RepairJob) => { job.adapterPath = "lib/sources/other.ts"; },
    (job: RepairJob) => { job.adapterHash = "b".repeat(64); },
    (job: RepairJob) => { job.targetHash = "b".repeat(64); },
    (job: RepairJob) => { job.target.sourceId = "unapproved"; },
    (job: RepairJob) => { job.target.adapterPath = "source-adapters.local/other/adapter.ts"; },
    (job: RepairJob) => { job.target.fileHashes[job.adapterPath] = "b".repeat(64); },
  ]) {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!; job.state = "validation_deferred"; mutate(job);
    const store = join(f.root, "work", "source-repairs"); await writeJson(store, `${job.id}/job.json`, job);
    const before = await readFile(join(store, job.id, "job.json"), "utf8"); const provider = fakeProvider((body) => proposal(body)); let validations = 0;
    const result = await runRepairBatch(f.root, at, at, { ...options(f, provider), diagnostics: [], validate: async () => { validations++; return passed(); } });
    assert.equal(result.attempted, 0); assert.equal(provider.chats, 0); assert.equal(validations, 0); assert.equal(result.skippedReason, "repair_saved_receipt_invalid");
    assert.equal(await readFile(join(store, job.id, "job.json"), "utf8"), before);
  }
});
test("bounded JSON immutable planning and parser contexts appear once in separate scopes", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const source = await readFile(new URL("../fixtures/source-repair/bounded-json/adapter.test.ts.txt", import.meta.url), "utf8");
  await writeFile(join(f.root, f.target.testFiles[0]!), source);
  f.target = await validateRepairTarget(f.root, { sourceId: f.target.sourceId, adapterPath: f.target.adapterPath, testFiles: f.target.testFiles, files: f.target.files });
  const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!;
  const context = (await repairFixtureContext(f.root, job))!;
  assert.ok(context.length <= 3_000); assert.match(context, /complete redacted content/u); assert.match(context, /\n/u);
  assert.equal(context.split('test("immutable independent bounds are available before nullable or missing text mapping"').length - 1, 1);
  assert.equal(context.split('test("immutable text and source identity controls preserve missing and malformed rejection"').length - 1, 1);
  assert.equal(context.split("for (const value of [null, undefined])").length - 1, 1);
  assert.equal(context.split("for (const value of [undefined, 7, {}, []])").length - 1, 1);
  assert.match(context, /planInventoryTraversal!\(page\(body\)\)/u); assert.match(context, /assert.throws\(\(\) => parse\(body\)/u);
  assert.doesNotMatch(context, /omitted|truncated/u);
  const provider = fakeProvider((body) => proposal(body, []));
  const batch = await runRepairBatch(f.root, at, at, options(f, provider)); assert.equal(batch.jobs[0]!.state, "abstained");
  const payload = JSON.parse(provider.calls.find((call) => call.path === "/api/chat")!.body!.messages[1].content);
  assert.equal(payload.trustedFixtureContext, context);
});
test("larger fixture windows merge overlapping and adjacent lines with honest omissions", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const lines = Array.from({ length: 200 }, (_, index) => `// source-line-${String(index).padStart(3, "0")} ${"x".repeat(20)}`);
  for (const index of [15, 19, 23, 80]) lines[index] += " description";
  lines[16] = "// source-line-016 https://example.com/items?token=fixture-query#fragment";
  lines[17] = "// source-line-017 authorization=fixture-value";
  lines[18] = "// source-line-018 C:\\fixture\\file.ts"; lines[20] += "\u0000";
  await writeFile(join(f.root, f.target.testFiles[0]!), lines.join("\n"));
  f.target = await validateRepairTarget(f.root, { sourceId: f.target.sourceId, adapterPath: f.target.adapterPath, testFiles: f.target.testFiles, files: f.target.files });
  const job = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!; const context = (await repairFixtureContext(f.root, job))!;
  assert.ok(context.length <= 3_000); assert.match(context, /redacted excerpt, omissions marked/u); assert.match(context, /original lines 13-28/u);
  assert.match(context, /original lines 29-77 omitted/u); assert.doesNotMatch(context, /fixture-query|fragment|fixture-value|C:\\fixture|\u0000/u);
  assert.match(context, /https:\/\/example.com\/items/u); assert.match(context, /\[credential redacted\]/u); assert.match(context, /\[local path\]/u);
  const identifiers = context.match(/source-line-\d+/gu)!; assert.equal(new Set(identifiers).size, identifiers.length);
  const dense = Array.from({ length: 80 }, (_, index) => `// dense-line-${String(index).padStart(3, "0")} description ${"x".repeat(100)}`).join("\n");
  await writeFile(join(f.root, f.target.testFiles[0]!), dense);
  const secondPath = "source-adapters.local/example/second.test.ts"; await writeFile(join(f.root, secondPath), "export {};");
  f.target = await validateRepairTarget(f.root, { sourceId: f.target.sourceId, adapterPath: f.target.adapterPath, testFiles: [...f.target.testFiles, secondPath], files: f.target.files });
  const denseJob = (await prepareJobs(f.root, [diagnostic], { targets: [f.target] })).jobs[0]!; const limited = (await repairFixtureContext(f.root, denseJob))!;
  assert.ok(limited.length <= 3_000); assert.match(limited, /excerpt truncated by fixture context limit/u); assert.match(limited, /1 additional approved test file\(s\) omitted/u); assert.doesNotMatch(limited, /complete redacted content/u);
});
