import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acquireRepairLock, correctionProposalRequest, hash, isRecord, JOB_RECEIPT_BYTES, LIMITS, listJobs, prepareJobs, proposalRequest, readOwned,
  REPAIR_GENERATION_POLICY, sanitizeDiagnostic, validateProposal, writeJson, writeNewJson,
  type FailureDiagnostic, type ProcessReceipt, type RepairJob, type RepairResponseSchema, type ValidationReceipt,
} from "./core.ts";
import { currentFailures, discoveryEligibility, generateProposal, loopbackOrigin, ollamaEligibility } from "./diagnostics.ts";
import { validateIsolatedProposal } from "./sandbox.ts";
import { repairStorageAdmission, type StorageMeasure } from "./storage.ts";
import { loadSourceParserEvidence } from "./evidence-local.ts";
import { sourceParserEvidenceModelContext, type SourceParserEvidencePacket } from "./evidence.ts";
import { assertCurrentRepairTarget, loadRepairConfig, validateModelTag, type ValidatedRepairTarget } from "./config.ts";

export interface WorkflowOptions {
  limit?: number; noAi?: boolean; origin?: string; model?: string; targets?: ValidatedRepairTarget[]; fetchImpl?: typeof fetch;
  diagnostics?: FailureDiagnostic[];
  checkIdle?: () => Promise<{ eligible: boolean; reason: string }>;
  validate?: (root: string, job: RepairJob, candidate: string) => Promise<ValidationReceipt>;
  progress?: (stage: string) => void;
  signal?: AbortSignal;
  measureStorage?: StorageMeasure;
  loadEvidence?: typeof loadSourceParserEvidence;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function admittedJob(job: RepairJob, targets: ReadonlyMap<string, ValidatedRepairTarget>): boolean {
  const target = targets.get(job.sourceId);
  return Boolean(target && /^[a-f0-9]{64}$/u.test(job.targetHash ?? "") && /^[a-f0-9]{64}$/u.test(job.adapterHash ?? "") &&
    job.targetHash === target.targetHash && job.adapterPath === target.adapterPath && job.adapterHash === target.fileHashes[target.adapterPath] &&
    isRecord(job.target) && JSON.stringify(canonical(job.target)) === JSON.stringify(canonical(target)));
}
/** Capture/run timestamps are provenance, not permission for another inference. */
export function repairEvidenceIdentity(packet: SourceParserEvidencePacket): string {
  return hash(JSON.stringify(canonical({ schemaVersion: packet.schemaVersion, sourceId: packet.sourceId,
    sanitizedBodyHash: packet.sanitizedBodyHash, replay: { kind: packet.replay.kind, operation: packet.replay.operation ?? "parse_page",
      url: packet.replay.page.url, contentType: packet.replay.page.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null,
      expectedListings: packet.replay.expectedListings ?? null, plannedPage: packet.replay.plannedPage ?? null } })));
}
async function attachEvidence(root: string, diagnostics: FailureDiagnostic[], loader: typeof loadSourceParserEvidence): Promise<FailureDiagnostic[]> {
  const result: FailureDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic.sourceRunId || diagnostic.evidence !== "source_run") { result.push({ ...diagnostic, evidenceStatus: "source_run_id_missing" }); continue; }
    const loaded = await loader(root, diagnostic.sourceRunId, diagnostic.sourceId);
    result.push(loaded.available ? { ...diagnostic, evidenceKey: loaded.key, evidenceHash: loaded.artifactHash,
      evidenceIdentity: repairEvidenceIdentity(loaded.packet), evidenceStatus: "sanitized_packet_available" } : { ...diagnostic, evidenceStatus: loaded.reason });
  }
  return result;
}
async function jobEvidence(root: string, job: RepairJob, loader: typeof loadSourceParserEvidence): Promise<{ context?: string; reason?: string }> {
  if (!job.sourceRunId) return {};
  const loaded = await loader(root, job.sourceRunId, job.sourceId);
  if (!loaded.available) return job.evidenceHash ? { reason: loaded.reason } : {};
  if (loaded.artifactHash !== job.evidenceHash || loaded.key !== job.evidenceKey || repairEvidenceIdentity(loaded.packet) !== job.evidenceIdentity) return { reason: "evidence_changed_since_preparation" };
  return { context: sourceParserEvidenceModelContext(loaded.packet) };
}
export async function repairFixtureContext(root: string, job: RepairJob): Promise<string | undefined> {
  try {
    const maximum = 3_000;
    const files = await Promise.all(job.target.testFiles.map(async (path) => ({ path,
      text: sanitizeDiagnostic(await readOwned(root, path, 2_000_000), Number.MAX_SAFE_INTEGER, { preserveLineBreaks: true }) })));
    const complete = ({ path, text }: typeof files[number]) => `[BEGIN FILE ${path}; complete redacted content]\n${text}\n[END FILE ${path}]`;
    const all = files.map(complete).join("\n\n"); if (all.length <= maximum) return all;
    const terms = job.diagnostic.message.toLowerCase().match(/[a-z]{4,}/gu) ?? [];
    const chunks: string[] = [];
    for (const [index, file] of files.entries()) {
      const additional = files.length - index - 1;
      const remainingFiles = additional ? `[... ${additional} additional approved test file(s) omitted by fixture context limit ...]` : "";
      const separator = chunks.length ? 2 : 0;
      const capacity = maximum - chunks.join("\n\n").length - separator - (remainingFiles ? remainingFiles.length + 2 : 0);
      const full = complete(file);
      if (full.length <= capacity) { chunks.push(full); continue; }
      const header = `[BEGIN FILE ${file.path}; redacted excerpt, omissions marked]\n`;
      const footer = `\n[END FILE ${file.path}; excerpt]`;
      const truncated = "\n[... excerpt truncated by fixture context limit; remaining source omitted ...]";
      if (capacity < header.length + footer.length + truncated.length) {
        chunks.push(`[... ${files.length - index} approved test file(s) omitted by fixture context limit ...]`); break;
      }
      const lines = file.text.split("\n"); const ranges: Array<{ start: number; end: number }> = [];
      for (const [line, text] of lines.entries()) if (terms.some((term) => text.toLowerCase().includes(term))) {
        const start = Math.max(0, line - 3); const end = Math.min(lines.length, line + 5); const last = ranges.at(-1);
        if (last && start <= last.end) last.end = Math.max(last.end, end); else ranges.push({ start, end });
      }
      if (!ranges.length) ranges.push({ start: 0, end: Math.min(lines.length, 8) });
      const parts: string[] = []; let previous = 0;
      for (const range of ranges) {
        if (range.start > previous) parts.push(`[... original lines ${previous + 1}-${range.start} omitted ...]`);
        parts.push(`[original lines ${range.start + 1}-${range.end}]\n${lines.slice(range.start, range.end).join("\n")}`); previous = range.end;
      }
      if (previous < lines.length) parts.push(`[... original lines ${previous + 1}-${lines.length} omitted ...]`);
      const excerpt = header + parts.join("\n") + footer;
      const limited = excerpt.length > capacity;
      chunks.push(limited ? excerpt.slice(0, capacity - truncated.length - footer.length) + truncated + footer : excerpt);
      if (limited) { if (remainingFiles) chunks.push(remainingFiles); break; }
    }
    return chunks.join("\n\n");
  } catch { return undefined; }
}
const OWNERSHIP_CHECK_INTERVAL = 5_000;
async function generateWhileIdle(origin: string, prompt: string, schema: RepairResponseSchema, checkIdle: NonNullable<WorkflowOptions["checkIdle"]>, options: WorkflowOptions,
  job: RepairJob, onDispatch: () => void): Promise<string> {
  const control = new AbortController(); let pending: Promise<void> | undefined; let reason = "repair_cancelled";
  const cancel = () => control.abort(new Error("repair_cancelled"));
  if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setInterval(() => {
    if (pending || control.signal.aborted) return;
    pending = checkIdle().then((state) => {
      if (!state.eligible) { reason = state.reason; control.abort(new Error(reason)); }
    }).catch(() => { reason = "discovery_ownership_unavailable"; control.abort(new Error(reason)); })
      .finally(() => { pending = undefined; });
  }, OWNERSHIP_CHECK_INTERVAL);
  timer.unref();
  try { return await generateProposal(origin, prompt, options.fetchImpl, control.signal, schema, { model: job.model!, expectedDigest: job.modelDigest, onDispatch }); }
  catch (error) { if (control.signal.aborted) throw new Error(`generation_deferred:${reason}`); throw error; }
  finally { clearInterval(timer); options.signal?.removeEventListener("abort", cancel); if (pending) await pending; }
}
export interface BatchResult {
  schemaVersion: "source-repair-batch-v1"; proposalOnly: true;
  created: number; attempted: number; skippedReason?: string; jobs: RepairJob[];
  diagnostics?: FailureDiagnostic[];
}
function safeValidation(receipt: ValidationReceipt): ValidationReceipt {
  const result = { ...receipt };
  for (const key of ["baseline", "candidate", "containment", "replayBaseline", "replayCandidate"] as const) {
    const process = result[key];
    if (process) result[key] = { ...process, stdout: sanitizeDiagnostic(process.stdout, LIMITS.processBytes), stderr: sanitizeDiagnostic(process.stderr, 4_000) };
  }
  return result;
}
function validationSummary(id: string, receipt: ValidationReceipt): NonNullable<RepairJob["validation"]> {
  const { status, checkedAt, proposalOnly, liveFailureReproduced, reason, snapshotHash, candidateHash, testFiles, sandboxPath, evidenceHash } = receipt;
  return { status, checkedAt, proposalOnly, liveFailureReproduced, reason, snapshotHash, candidateHash, testFiles, sandboxPath, evidenceHash,
    receiptPath: `work/source-repairs/${id}/validation.json` };
}
async function saveValidation(root: string, job: RepairJob, receipt: ValidationReceipt): Promise<void> {
  const store = join(root, "work", "source-repairs");
  try {
    const previous = JSON.parse(await readOwned(store, `${job.id}/validation.json`, 2_000_000));
    await writeJson(store, `${job.id}/validation-history/${randomUUID()}.json`, previous);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeJson(store, `${job.id}/validation.json`, receipt);
  job.validation = validationSummary(job.id, receipt); job.state = receipt.status; job.reason = receipt.reason ?? receipt.status;
}
const requestCount = (job: RepairJob) => job.requestCount ?? (job.attempt ? 1 : 0);
const attemptPath = (job: RepairJob, number: number) => `${job.id}/attempts/${String(number).padStart(2, "0")}`;
const successfulProcess = (receipt?: ProcessReceipt) => Boolean(receipt && receipt.exitCode === 0 && !receipt.timedOut && !receipt.outputLimited);
const PROPOSAL_REJECTIONS = new Set(["proposal_contract_invalid", "proposal_edit_invalid", "proposal_before_not_in_schema", "edit_outside_supported_expression",
  "replacement_not_closed_expression", "replacement_outside_expression_grammar", "validation_contract_changed", "helper_call_structure_changed", "extraction_literal_kind_changed",
  "candidate_syntax_invalid", "edit_outside_extraction_literal", "replacement_not_extraction_literal"]);
const RESOURCE_OR_DEPENDENCY_FAILURE = /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|ENOENT|ENOSPC|EACCES|ENOMEM|EAGAIN|out of memory|heap limit|\bSIG(?:ABRT|KILL|XCPU|SEGV|BUS|TERM|INT|XFSZ|ILL|FPE|PIPE|QUIT|HUP)\b|ERR_TEST_TIMEOUT|testTimeoutFailure|resource.{0,40}(?:limit|exhaust)|cpu.{0,40}(?:limit|exceed)/iu;
function candidateFailureAllowsCorrection(job: RepairJob, receipt: ValidationReceipt): boolean {
  if (receipt.status !== "candidate_failed" || !successfulProcess(receipt.baseline) || !successfulProcess(receipt.containment)) return false;
  if (!/^[a-f0-9]{64}$/u.test(receipt.snapshotHash ?? "") || !/^[a-f0-9]{64}$/u.test(receipt.candidateHash ?? "")) return false;
  let containment: unknown; try { containment = JSON.parse(receipt.containment!.stdout.trim()); } catch { return false; }
  if (!isRecord(containment) || containment.schemaVersion !== "source-repair-containment-v2" ||
    ["fileDenied", "immutableDenied", "tempWritable", "networkDenied", "privateMountsAbsent", "environmentScrubbed", "networkControl"].some((key) => containment[key] !== true) ||
    containment.acceptedConnections !== 0 || typeof containment.count !== "number" || containment.count < 4) return false;
  if (job.evidenceHash && (!receipt.liveFailureReproduced || receipt.evidenceHash !== job.evidenceHash || !successfulProcess(receipt.replayBaseline))) return false;
  for (const process of [receipt.candidate, receipt.replayCandidate]) if (process && (process.timedOut || process.outputLimited || process.exitCode === null ||
    RESOURCE_OR_DEPENDENCY_FAILURE.test(`${process.stdout}\n${process.stderr}`))) return false;
  if (receipt.reason === "candidate_fixture_checks_failed") return Boolean(receipt.candidate && receipt.candidate.exitCode !== 0 && /not ok\b|# fail\s+[1-9]|✖/u.test(receipt.candidate.stdout));
  return receipt.reason === "candidate_saved_failure_replay_failed" && receipt.liveFailureReproduced && successfulProcess(receipt.candidate) && successfulProcess(receipt.replayCandidate);
}
function queueCorrection(job: RepairJob, kind: NonNullable<RepairJob["correction"]>["kind"], reason: string, feedback: string): boolean {
  if (job.generationPolicy !== REPAIR_GENERATION_POLICY || requestCount(job) < 1 || requestCount(job) >= LIMITS.requestsPerCase) return false;
  job.correction = { fromRequest: requestCount(job), createdAt: new Date().toISOString(), kind, reason: sanitizeDiagnostic(reason, 300), feedback: sanitizeDiagnostic(feedback, 4_000) };
  job.state = "correction_pending"; job.reason = job.correction.reason; return true;
}
async function recordValidation(root: string, job: RepairJob, receipt: ValidationReceipt): Promise<void> {
  const store = join(root, "work", "source-repairs");
  if (job.generationPolicy === REPAIR_GENERATION_POLICY && requestCount(job)) await writeNewJson(store, `${attemptPath(job, requestCount(job))}/validation-${randomUUID()}.json`, receipt);
  await saveValidation(root, job, receipt);
  if (candidateFailureAllowsCorrection(job, receipt)) {
    const process = receipt.reason === "candidate_fixture_checks_failed" ? receipt.candidate : receipt.replayCandidate;
    queueCorrection(job, "candidate_failure", receipt.reason!, JSON.stringify({ status: receipt.status, reason: receipt.reason,
      testFeedback: process?.stdout.slice(-2_500), errorFeedback: process?.stderr.slice(-1_000), instruction: "Repair only an original admitted site; preserve all validators and malformed or missing-value rejection, or abstain." }));
  }
}
async function validateSaved(root: string, job: RepairJob, base: string, checkIdle: NonNullable<WorkflowOptions["checkIdle"]>, options: WorkflowOptions): Promise<void> {
  const store = join(root, "work", "source-repairs");
  await assertCurrentRepairTarget(root, job.target);
  const evidence = await jobEvidence(root, job, options.loadEvidence ?? loadSourceParserEvidence);
  if (evidence.reason) { job.state = "validation_unavailable"; job.reason = evidence.reason; return; }
  const raw = await readOwned(store, `${job.id}/proposal.json`, LIMITS.outputBytes);
  const validated = validateProposal(raw, job, base);
  if (validated.abstained) { job.state = "abstained"; job.reason = "insufficient_evidence"; return; }
  const idle = await checkIdle();
  if (!idle.eligible) { job.state = "validation_deferred"; job.reason = idle.reason; return; }
  job.state = "validating"; job.validationAttempt = { pid: process.pid, startedAt: new Date().toISOString() };
  await writeJson(store, `${job.id}/job.json`, job);
  const receipt = safeValidation(await (options.validate ?? ((project, item, candidate) => validateIsolatedProposal(project, item, candidate, { signal: options.signal })))(root, job, validated.candidate));
  await recordValidation(root, job, receipt);
}
async function generateCase(root: string, job: RepairJob, base: string, origin: string,
  checkIdle: NonNullable<WorkflowOptions["checkIdle"]>, options: WorkflowOptions, result: BatchResult, limit: number): Promise<void> {
  const store = join(root, "work", "source-repairs");
  while (["prepared", "correction_pending"].includes(job.state)) {
    const count = requestCount(job); const allowance = job.generationPolicy === REPAIR_GENERATION_POLICY ? LIMITS.requestsPerCase : 1;
    if (!Number.isSafeInteger(count) || count < 0 || count >= allowance) { job.state = "generation_exhausted"; job.reason = "generation_request_allowance_exhausted"; return; }
    if (result.attempted >= limit) { result.skippedReason = "generation_request_budget_exhausted"; return; }
    const idle = await checkIdle();
    if (!idle.eligible || options.signal?.aborted) { result.skippedReason = options.signal?.aborted ? "repair_cancelled" : idle.reason; return; }
    try { await assertCurrentRepairTarget(root, job.target); } catch { job.state = "stale_target"; job.reason = "repair_target_changed_since_preparation"; return; }
    if (hash(await readOwned(root, job.adapterPath)) !== job.adapterHash) { job.state = "stale_base"; job.reason = "adapter_changed_since_failure"; return; }
    const evidence = await jobEvidence(root, job, options.loadEvidence ?? loadSourceParserEvidence);
    if (evidence.reason) { job.state = "proposal_unavailable"; job.reason = evidence.reason; return; }
    if (!options.model) { result.skippedReason = "repair_model_required"; return; }
    if (count > 0 && job.model !== options.model) { result.skippedReason = "repair_model_changed_since_reservation"; return; }
    const provider = await ollamaEligibility(origin, options.model, options.fetchImpl, options.signal);
    if (!provider.eligible || !provider.proof) { result.skippedReason = provider.reason; return; }
    if (count > 0 && job.modelDigest !== provider.proof.digest) { result.skippedReason = "repair_model_changed_since_reservation"; return; }
    let request: { prompt: string; schema: RepairResponseSchema };
    try {
      if (job.state === "correction_pending") {
        if (!job.correction || job.correction.fromRequest !== count) throw new Error("correction_receipt_unavailable");
        const previous: unknown = JSON.parse(await readOwned(store, `${attemptPath(job, count)}/input.json`, LIMITS.inputBytes + 4_000));
        if (!isRecord(previous) || typeof previous.prompt !== "string" || previous.promptHash !== hash(previous.prompt) || previous.adapterHash !== job.adapterHash || previous.requestNumber !== count) throw new Error("correction_input_unavailable");
        request = correctionProposalRequest(job, base, previous.prompt, job.correction.feedback);
      } else request = proposalRequest(job, base, { evidenceContext: evidence.context, fixtureContext: await repairFixtureContext(root, job) });
    } catch (error) { job.state = "proposal_unavailable"; job.reason = sanitizeDiagnostic((error as Error).message); return; }
    const number = count + 1; const path = attemptPath(job, number); const startedAt = new Date().toISOString();
    const kind = job.state === "correction_pending" ? "correction" : "initial";
    job.model = provider.proof.model; job.modelDigest = provider.proof.digest;
    job.requestCount = number; job.attempt ??= { startedAt, model: job.model, pid: process.pid }; job.attempt.pid = process.pid; job.state = "generating";
    // Durable reservation precedes dispatch; an interrupted unknown request is
    // never replayed merely because its response receipt is missing.
    await writeJson(store, `${job.id}/job.json`, job);
    await writeNewJson(store, `${path}/input.json`, { generationPolicy: job.generationPolicy ?? "legacy-single-attempt-v1", requestNumber: number, kind,
      startedAt, model: job.model, modelProof: provider.proof, targetHash: job.targetHash, adapterHash: job.adapterHash, evidenceHash: job.evidenceHash,
      promptHash: hash(request.prompt), promptBytes: Buffer.byteLength(request.prompt), prompt: request.prompt, responseSchema: request.schema });
    options.progress?.(kind === "correction" ? "correction" : "proposal"); let chatDispatched = false;
    let raw: string;
    try { raw = await generateWhileIdle(origin, request.prompt, request.schema, checkIdle, options, job, () => { chatDispatched = true; result.attempted++; job.dispatchedCount = (job.dispatchedCount ?? 0) + 1; }); }
    catch (error) {
      job.reason = sanitizeDiagnostic(error instanceof Error ? error.message : "generation_failed");
      job.state = job.reason.startsWith("generation_deferred:") ? "generation_deferred" : "generation_failed";
      await writeNewJson(store, `${path}/output.json`, { failure: job.reason, chatDispatched, responseBytes: 0 });
      await writeNewJson(store, `${path}/decision.json`, { status: job.state, reason: job.reason, checkedAt: new Date().toISOString() });
      await writeJson(store, `${job.id}/failed-proposal.json`, { reason: job.reason, responseHash: hash(""), responseBytes: 0, response: "" });
      return;
    }
    await writeNewJson(store, `${path}/output.json`, { chatDispatched, responseHash: hash(raw), responseBytes: Buffer.byteLength(raw), response: sanitizeDiagnostic(raw, LIMITS.outputBytes) });
    let validated: ReturnType<typeof validateProposal>;
    try { validated = validateProposal(raw, job, base, request.schema); }
    catch (error) {
      job.state = "proposal_rejected"; job.reason = sanitizeDiagnostic(error instanceof Error ? error.message : "proposal_failed");
      await writeNewJson(store, `${path}/decision.json`, { status: job.state, reason: job.reason, checkedAt: new Date().toISOString() });
      await writeJson(store, `${job.id}/failed-proposal.json`, { reason: job.reason, responseHash: hash(raw), responseBytes: Buffer.byteLength(raw), response: sanitizeDiagnostic(raw, LIMITS.outputBytes) });
      if (error instanceof SyntaxError || PROPOSAL_REJECTIONS.has(job.reason)) queueCorrection(job, "proposal_rejection", job.reason, JSON.stringify({ reason: job.reason,
        instruction: "before must exactly equal an original supplied site, never a declaration or outer guard/helper call. Preserve missing, number, object and array rejection. Use supported null-only data expressions only when evidence proves null, or abstain." }));
      await writeJson(store, `${job.id}/job.json`, job);
      continue;
    }
    await writeNewJson(store, `${path}/proposal.json`, validated.proposal);
    await writeNewJson(store, `${path}/decision.json`, { status: validated.abstained ? "abstained" : "proposal_accepted", checkedAt: new Date().toISOString() });
    await writeJson(store, `${job.id}/proposal.json`, validated.proposal);
    if (validated.abstained) { job.state = "abstained"; job.reason = "insufficient_evidence"; return; }
    job.state = "proposed"; await writeJson(store, `${job.id}/job.json`, job);
    const beforeTests = await checkIdle();
    if (!beforeTests.eligible) { job.state = "validation_deferred"; job.reason = beforeTests.reason; return; }
    job.state = "validating"; job.validationAttempt = { startedAt: new Date().toISOString(), pid: process.pid };
    await writeJson(store, `${job.id}/job.json`, job); options.progress?.("isolated tests");
    try {
      const receipt = safeValidation(await (options.validate ?? ((project, item, candidate) => validateIsolatedProposal(project, item, candidate, { signal: options.signal })))(root, job, validated.candidate));
      await recordValidation(root, job, receipt);
    } catch (error) {
      job.state = "validation_interrupted"; job.reason = sanitizeDiagnostic(error instanceof Error ? error.message : "validation_failed");
      await writeNewJson(store, `${path}/validation-error-${randomUUID()}.json`, { reason: job.reason, checkedAt: new Date().toISOString() });
    }
    await writeJson(store, `${job.id}/job.json`, job);
  }
}
export async function runRepairBatch(projectRoot: string, since: string, until: string, options: WorkflowOptions = {}): Promise<BatchResult> {
  const deadline = AbortSignal.timeout(LIMITS.batchMs);
  return executeRepairBatch(projectRoot, since, until, { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
}
async function executeRepairBatch(projectRoot: string, since: string, until: string, options: WorkflowOptions): Promise<BatchResult> {
  let origin: string | undefined;
  try { origin = loopbackOrigin(options.origin ?? process.env.SOURCE_REPAIR_OLLAMA_URL ?? "http://127.0.0.1:11434"); }
  catch { /* A provider configuration failure must not suppress diagnostics. */ }
  const limit = options.limit ?? LIMITS.jobs;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.jobs) throw new Error("repair_batch_limit_invalid");
  const result: BatchResult = { schemaVersion: "source-repair-batch-v1", proposalOnly: true, created: 0, attempted: 0, jobs: [] };
  if (!options.targets?.length) { result.skippedReason = "repair_config_missing"; return result; }
  const targets = options.targets;
  let modelReason: string | undefined;
  if (options.model) try { options = { ...options, model: validateModelTag(options.model) }; } catch (error) { modelReason = (error as Error).message; }
  else modelReason = "repair_model_required";
  const noAi = options.noAi !== false || Boolean(modelReason);
  options.progress?.("diagnostics");
  const sourceIds = new Set(targets.map((target) => target.sourceId));
  const diagnostics = await attachEvidence(projectRoot, (options.diagnostics ?? await currentFailures(projectRoot, since, until)).filter((diagnostic) => sourceIds.has(diagnostic.sourceId)), options.loadEvidence ?? loadSourceParserEvidence);
  const budget = Math.min(diagnostics.length, LIMITS.diagnostics) * LIMITS.profiles * (LIMITS.adapterBytes + JOB_RECEIPT_BYTES) +
    limit * (LIMITS.snapshotBytes + 12 * LIMITS.processBytes + LIMITS.inputBytes + LIMITS.outputBytes + JOB_RECEIPT_BYTES);
  const storage = await repairStorageAdmission(projectRoot, budget, options.measureStorage);
  if (!storage.eligible) {
    result.skippedReason = storage.reason;
    result.diagnostics = diagnostics.map((item) => ({ ...item, message: sanitizeDiagnostic(item.message), errorCode: sanitizeDiagnostic(item.errorCode, 120) }));
    return result;
  }
  const checkIdle = options.checkIdle ?? (() => discoveryEligibility(projectRoot));
  const firstIdle = noAi ? undefined : await checkIdle();
  const firstProvider = !noAi && firstIdle?.eligible && origin ? await ollamaEligibility(origin, options.model!, options.fetchImpl, options.signal) : undefined;
  const release = await acquireRepairLock(projectRoot);
  if (!release) { result.skippedReason = "repair_lock_held"; return result; }
  try {
    const prepared = await prepareJobs(projectRoot, diagnostics, options);
    result.created = prepared.created; result.jobs = [...new Map(prepared.jobs.map((job) => [job.id, job])).values()];
    const approved = new Map(targets.map((target) => [target.sourceId, target]));
    if (result.jobs.some((job) => !admittedJob(job, approved))) {
      result.jobs = result.jobs.filter((job) => admittedJob(job, approved)); result.skippedReason = "repair_saved_receipt_invalid"; return result;
    }
    if (prepared.skippedReason) { result.skippedReason = prepared.skippedReason; return result; }
    if (noAi) { result.skippedReason = options.noAi !== false ? "proposal_generation_disabled" : modelReason; return result; }
    if (!origin) { result.skippedReason = "repair_provider_configuration_invalid"; return result; }
    if (!firstIdle?.eligible) { result.skippedReason = firstIdle?.reason ?? "discovery_ownership_unavailable"; return result; }
    options.progress?.("eligibility");
    // Lock acquisition must not turn stale eligibility into permission to infer.
    const idle = await checkIdle();
    if (!idle.eligible) { result.skippedReason = idle.reason; return result; }
    const store = join(projectRoot, "work", "source-repairs");
    const saved = await listJobs(store);
    if (saved.some((job) => !admittedJob(job, approved) && ["proposed", "validation_deferred", "validating", "validation_interrupted", "generating", "correction_pending"].includes(job.state))) result.skippedReason = "repair_saved_receipt_invalid";
    const savedPending = saved.filter((job) => admittedJob(job, approved) && ["proposed", "validation_deferred", "validating", "validation_interrupted", "generating", "correction_pending"].includes(job.state));
    result.jobs = [...new Map([...result.jobs, ...savedPending].map((job) => [job.id, job])).values()];
    const jobs = [...result.jobs]
      .filter((job) => job.disposition === "parser_proposal" && (job.state === "prepared" && !job.attempt || ["proposed", "validation_deferred", "validating", "validation_interrupted", "generating", "correction_pending"].includes(job.state))).slice(0, limit);
    for (const job of jobs) {
      if (options.signal?.aborted) { result.skippedReason = "repair_cancelled"; break; }
      // A new discovery or external Ollama consumer can claim ownership between jobs.
      const nextIdle = await checkIdle();
      if (!nextIdle.eligible) { result.skippedReason = nextIdle.reason; break; }
      try { await assertCurrentRepairTarget(projectRoot, job.target); } catch { job.state = "stale_target"; job.reason = "repair_target_changed_since_preparation"; await writeJson(store, `${job.id}/job.json`, job); continue; }
      const base = await readOwned(projectRoot, job.adapterPath);
      if (hash(base) !== job.adapterHash) { job.state = "stale_base"; job.reason = "adapter_changed_since_failure"; await writeJson(store, `${job.id}/job.json`, job); continue; }
      if (job.state === "generating") {
        let dead = false;
        if (job.attempt?.pid) try { process.kill(job.attempt.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        job.state = dead ? "generation_interrupted" : "generation_unconfirmed";
        job.reason = dead ? "prior_generation_owner_dead_no_completed_receipt" : "previous_generation_has_no_completed_receipt";
        await writeJson(store, `${job.id}/job.json`, job); continue;
      }
      if (["proposed", "validation_deferred", "validating", "validation_interrupted"].includes(job.state)) {
        options.progress?.("isolated tests");
        try { await validateSaved(projectRoot, job, base, checkIdle, options); }
        catch (error) { job.state = "validation_interrupted"; job.reason = sanitizeDiagnostic(error instanceof Error ? error.message : "validation_failed"); }
        await writeJson(store, `${job.id}/job.json`, job); if (job.state !== "correction_pending") continue;
      }
      if (!firstProvider?.eligible) { result.skippedReason = firstProvider?.reason ?? "ollama_unavailable"; continue; }
      await generateCase(projectRoot, job, base, origin, checkIdle, options, result, limit);
      await writeJson(store, `${job.id}/job.json`, job);
    }
    return result;
  } finally { await release(); }
}
export async function replayProposal(projectRoot: string, id: string, options: { signal?: AbortSignal } = {}): Promise<RepairJob> {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("invalid_job_id");
  const idle = await discoveryEligibility(projectRoot); if (!idle.eligible) throw new Error(idle.reason);
  const release = await acquireRepairLock(projectRoot); if (!release) throw new Error("repair_lock_held");
  try {
    const job = (await listJobs(join(projectRoot, "work", "source-repairs"))).find((item) => item.id === id);
    if (!job || job.disposition !== "parser_proposal") throw new Error("parser_proposal_not_found");
    const config = await loadRepairConfig(projectRoot);
    if (!config.available || !admittedJob(job, new Map(config.targets.map((target) => [target.sourceId, target])))) throw new Error("repair_target_not_currently_approved");
    await assertCurrentRepairTarget(projectRoot, job.target);
    const confirmed = await discoveryEligibility(projectRoot); if (!confirmed.eligible) throw new Error(confirmed.reason);
    const base = await readOwned(projectRoot, job.adapterPath);
    const evidence = await jobEvidence(projectRoot, job, loadSourceParserEvidence); if (evidence.reason) throw new Error(evidence.reason);
    const { candidate, abstained } = validateProposal(await readOwned(projectRoot, `work/source-repairs/${id}/proposal.json`, LIMITS.outputBytes), job, base);
    if (abstained) throw new Error("proposal_abstained_no_candidate");
    const validation = safeValidation(await validateIsolatedProposal(projectRoot, job, candidate, options));
    await saveValidation(projectRoot, job, validation);
    await writeJson(join(projectRoot, "work", "source-repairs"), `${id}/job.json`, job);
    return job;
  } finally { await release(); }
}
