import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepairConfig, loadRepairSettings } from "../lib/source-repair/config.ts";
import { listJobs, sanitizeDiagnostic } from "../lib/source-repair/core.ts";
import { invocationBounds } from "../lib/source-repair/diagnostics.ts";
import { RepairProgress } from "../lib/source-repair/progress.ts";
import { replayProposal, runRepairBatch } from "../lib/source-repair/workflow.ts";

type RepairEnvironment = Readonly<Record<string, string | undefined>>;
export function parseRepairArgs(argv: string[]): {
  action: "prepare" | "run" | "inspect" | "test"; since?: string; until?: string; job?: string; limit: number; quiet: boolean;
} {
  const action = argv[0];
  if (!["prepare", "run", "inspect", "test"].includes(action ?? "")) throw new Error("usage: repair <prepare|run|inspect|test> [--since ISO --until ISO] [--job SHA256] [--limit 1..2] [--quiet]");
  let since: string | undefined; let until: string | undefined; let job: string | undefined; let limit = 2; let quiet = false;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index]!;
    if (seen.has(name)) throw new Error("duplicate_repair_argument");
    seen.add(name);
    if (name === "--quiet") { quiet = true; continue; }
    const value = argv[++index]; if (!value) throw new Error("repair_argument_value_missing");
    if (name === "--since") since = value;
    else if (name === "--until") until = value;
    else if (name === "--job") job = value;
    else if (name === "--limit") limit = Number(value);
    else throw new Error("unknown_repair_argument");
  }
  if (action === "run" || action === "prepare") {
    if (!since || !until || job) throw new Error("repair_requires_current_invocation_since_and_until");
    ({ since, until } = invocationBounds(since, until));
  } else if (since || until) throw new Error("repair_invocation_bounds_not_applicable");
  if ((job && !/^[a-f0-9]{64}$/u.test(job)) || action === "test" && !job) throw new Error("repair_requires_valid_job_id");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) throw new Error("repair_batch_limit_invalid");
  return { action: action as "prepare" | "run" | "inspect" | "test", since, until, job, limit, quiet };
}
export async function repairMain(argv: string[], projectRoot = dirname(dirname(fileURLToPath(import.meta.url))),
  environment: RepairEnvironment = process.env): Promise<unknown> {
  const options = parseRepairArgs(argv);
  const progress = new RepairProgress(options.quiet);
  const cancellation = new AbortController();
  const stop = () => { cancellation.abort(); progress.finish(true); process.exitCode = 130; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    let result: unknown;
    if (options.action === "inspect") {
      const jobs = await listJobs(join(projectRoot, "work", "source-repairs"));
      result = { schemaVersion: "source-repair-inspection-v1", proposalOnly: true,
        jobs: options.job ? jobs.filter((job) => job.id === options.job) : jobs };
    } else if (options.action === "test") {
      progress.update("isolated tests");
      result = await replayProposal(projectRoot, options.job!, { signal: cancellation.signal });
    } else {
      const settings = await loadRepairSettings(projectRoot, environment);
      const config = await loadRepairConfig(projectRoot);
      const batch = await runRepairBatch(projectRoot, options.since!, options.until!, {
        noAi: options.action === "prepare" || settings.noAi, origin: settings.origin, model: settings.model,
        targets: config.available ? config.targets : [], limit: options.limit,
        progress: (phase) => progress.update(phase), signal: cancellation.signal,
      });
      if (!config.available) batch.skippedReason = config.reason;
      else if (settings.reason) batch.skippedReason = settings.reason;
      result = batch;
    }
    progress.finish(); return result;
  } catch (error) { progress.finish(true); throw error; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repairMain(process.argv.slice(2)).then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error: unknown) => { process.stdout.write(JSON.stringify({ schemaVersion: "source-repair-batch-v1", proposalOnly: true,
      error: sanitizeDiagnostic(error instanceof Error ? error.message : "repair_failed") }) + "\n"); process.exitCode = 1; });
}
