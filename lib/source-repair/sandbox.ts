import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  assertNoSymlinks, containedPath, hash, isRecord, LIMITS,
  readOwned, sanitizeDiagnostic, writeJson, type ProcessReceipt, type RepairJob, type ValidationReceipt,
} from "./core.ts";
import { repairStorageAdmission } from "./storage.ts";
import { loadSourceParserEvidence } from "./evidence-local.ts";
import { type SourceParserEvidencePacket } from "./evidence.ts";
import { assertCurrentRepairTarget, repairTargetFiles } from "./config.ts";
import { replayFailureMatches, type ParserReplayResult } from "./replay.ts";

export const LINUX_NODE_HASH = "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c";
export type ProcessRunner = (executable: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maximumBytes: number;
  signal?: AbortSignal; onStdout?: (chunk: string) => void;
}) => Promise<ProcessReceipt>;

/** Only fixed trusted argument vectors enter the kill-on-close Windows host. */
export const runBoundedProcess: ProcessRunner = async (executable, args, options) => {
  const started = performance.now();
  const windows = process.platform === "win32";
  const configurationPath = windows ? join(options.env.TEMP ?? options.cwd, `p-${randomUUID().slice(0, 8)}.json`) : undefined;
  const exitReceipt = configurationPath ? join(dirname(configurationPath), `r-${randomUUID().slice(0, 8)}.json`) : undefined;
  if (configurationPath) await writeFile(configurationPath,
    JSON.stringify({ schemaVersion: "source-repair-process-v1", executable, args, cwd: options.cwd, env: options.env, exitReceipt }), { flag: "wx" });
  return new Promise((settle) => {
    const child = windows ? spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./process-host.ps1", import.meta.url)), "-ConfigurationPath", configurationPath!],
      { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }) :
      spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false });
    let stdout = ""; let stderr = ""; let bytes = 0; let timedOut = false; let outputLimited = false;
    // The Linux host observes EOF here; generated tests receive null stdin.
    child.stdin.on("error", () => undefined);
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const interrupt = () => { timedOut = true; stop(); };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    if (options.signal?.aborted) interrupt();
    const consume = (chunk: Buffer, channel: "stdout" | "stderr") => {
      bytes += chunk.length;
      if (bytes > options.maximumBytes) { outputLimited = true; stop(); return; }
      const text = chunk.toString("utf8");
      if (channel === "stdout") { stdout += text; options.onStdout?.(text); } else stderr += text;
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    child.stdout.on("error", (error) => { if (!stderr) stderr = sanitizeDiagnostic(error.message); stop(); });
    child.stderr.on("error", () => stop());
    child.once("error", (error) => { stderr = sanitizeDiagnostic(error.message); });
    child.once("close", (hostExitCode) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", interrupt);
      void (async () => {
        let exitCode = windows ? null : hostExitCode;
        if (exitReceipt) {
          try {
            const record: unknown = JSON.parse((await readFile(exitReceipt, "utf8")).replace(/^\uFEFF/u, ""));
            if (isRecord(record) && record.schemaVersion === "source-repair-process-exit-v1" && Number.isInteger(record.exitCode)) exitCode = record.exitCode as number;
          } catch { /* Missing trusted exit evidence never becomes success. */ }
        }
        if (configurationPath) await rm(configurationPath, { force: true }).catch(() => undefined);
        if (exitReceipt) await rm(exitReceipt, { force: true }).catch(() => undefined);
        settle({ exitCode, timedOut, outputLimited, stdout, stderr: sanitizeDiagnostic(stderr, 4_000), elapsedMs: Math.round(performance.now() - started) });
      })();
    });
  });
};
export function scrubEnvironment(temporary: string): NodeJS.ProcessEnv {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  return { SystemRoot: windows, WINDIR: windows, ComSpec: join(windows, "System32", "cmd.exe"),
    USERPROFILE: homedir(), HOME: homedir(), APPDATA: join(homedir(), "AppData", "Roaming"), LOCALAPPDATA: join(homedir(), "AppData", "Local"),
    PATH: [dirname(process.execPath), join(windows, "System32")].join(sep === "\\" ? ";" : ":"), PATHEXT: ".EXE",
    TEMP: temporary, TMP: temporary, TMPDIR: temporary, NO_COLOR: "1", TSX_DISABLE_CACHE: "1", NODE_ENV: "test" };
}
export function windowsToWslPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!/^[A-Za-z]:\//u.test(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) throw new Error("unsupported_wsl_path");
  return `/mnt/${normalized[0]!.toLowerCase()}${normalized.slice(2)}`;
}
async function pinnedNode(projectRoot: string): Promise<string> {
  const tree = containedPath(projectRoot, "work/source-repairs/toolchain/node-v24.18.0-linux-x64");
  await assertNoSymlinks(projectRoot, join(tree, "bin", "node"));
  if (!(await lstat(join(tree, "bin", "node"))).isFile()) throw new Error("sandbox_node_not_regular");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(join(tree, "bin", "node"))) digest.update(chunk as Buffer);
  if (digest.digest("hex") !== LINUX_NODE_HASH) throw new Error("sandbox_node_hash_mismatch");
  return tree;
}
async function copyTrustedTree(root: string, relativeDirectory: string, destination: string,
  state: { bytes: number; files: number }, allowed: RegExp): Promise<void> {
  const directory = containedPath(root, relativeDirectory); await assertNoSymlinks(root, directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("sandbox_symlink_not_allowed");
    if (entry.isDirectory()) { await copyTrustedTree(root, name, destination, state, allowed); continue; }
    if (!entry.isFile() || !allowed.test(entry.name)) continue;
    const source = containedPath(root, name); await assertNoSymlinks(root, source);
    const bytes = await readFile(source); state.bytes += bytes.length; state.files++;
    if (state.bytes > LIMITS.snapshotBytes || state.files > 2_000) throw new Error("sandbox_snapshot_limit");
    const target = containedPath(destination, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" });
  }
}
async function snapshotHash(root: string): Promise<string> {
  const files: string[] = [];
  let bytes = 0;
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("sandbox_snapshot_symlink");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const content = await readFile(path); bytes += content.length;
        if (bytes > LIMITS.snapshotBytes || files.length >= 2_000) throw new Error("sandbox_snapshot_limit");
        files.push(`${relative(root, path).replaceAll("\\", "/")}\0${hash(content)}`);
      }
    }
  };
  await visit(root); return hash(files.sort().join("\n"));
}
let dependencyVerification: Promise<{ path: string; sha256: string; version: string }> | undefined;
async function publishedHtmlDependency() {
  dependencyVerification ??= (async () => {
    const publicRoot = fileURLToPath(new URL("../../", import.meta.url));
    const require = createRequire(new URL("../../package.json", import.meta.url));
    const packagePath = require.resolve("linkedom/package.json");
    const metadata = JSON.parse(await readFile(packagePath, "utf8"));
    const project = JSON.parse(await readFile(join(publicRoot, "package.json"), "utf8"));
    if (metadata.name !== "linkedom" || metadata.version !== project.dependencies?.linkedom || metadata.exports?.["./worker"]?.import !== "./worker.js") throw new Error("sandbox_html_dependency_contract_invalid");
    const modules = await realpath(join(publicRoot, "node_modules"));
    const path = await realpath(join(dirname(packagePath), "worker.js"));
    if (!path.startsWith(modules + sep) || !(await lstat(path)).isFile()) throw new Error("sandbox_html_dependency_outside_public_modules");
    return { path, sha256: hash(await readFile(path)), version: metadata.version as string };
  })();
  return dependencyVerification;
}

/** The compiler reads snapshot files and one fixed published dependency only. */
export async function bundleRepairEntries(copy: string, files: readonly string[]): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const compilerRequire = createRequire(require.resolve("tsx/package.json"));
  const esbuild = compilerRequire("esbuild") as {
    build: (options: Record<string, unknown>) => Promise<{ outputFiles: Array<{ path: string; contents: Uint8Array }>;
      metafile: { inputs: Record<string, unknown>; outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }> } }>;
    stop: () => void;
  };
  try {
    const builtins = new Set(builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : `node:${name}`]));
    const entries: Record<string, string> = {}; const outputs: string[] = [];
    for (let index = 0; index < files.length; index++) {
      const name = files[index]!; const output = name === "tests/source-repair-target/replay.ts" ? "replay" : `t${String(index).padStart(2, "0")}.test`;
      if (entries[output]) throw new Error("sandbox_duplicate_entry");
      entries[output] = containedPath(copy, name); outputs.push(`tests/source-repair-target/${output}.mjs`);
    }
    await assertNoSymlinks(copy, copy);
    const canonicalCopy = await realpath(copy);
    const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    const inside = (path: string) => key(resolve(path)).startsWith(key(resolve(copy)) + sep);
    const loaded = new Set<string>(); let loadedBytes = 0;
    const local = async (path: string) => {
      if (!inside(path)) throw new Error("sandbox_import_outside_snapshot");
      for (const candidate of [path, ...[".ts", ".mts", ".js", ".mjs", ".json"].map((extension) => path + extension), ...["index.ts", "index.mts", "index.js", "index.mjs"].map((name) => join(path, name))]) {
        if (!inside(candidate)) throw new Error("sandbox_import_outside_snapshot");
        await assertNoSymlinks(copy, candidate);
        try { if ((await lstat(candidate)).isFile()) return candidate; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      throw new Error("sandbox_import_not_in_snapshot");
    };
    const plugin = { name: "source-repair-contained-imports", setup(build: {
      onResolve: (filter: { filter: RegExp }, callback: (args: { path: string; importer: string; kind: string }) => Promise<unknown>) => void;
      onLoad: (filter: { filter: RegExp }, callback: (args: { path: string }) => Promise<unknown>) => void;
    }) { build.onResolve({ filter: /.*/ }, async (args) => {
      if (builtins.has(args.path)) return { path: args.path.startsWith("node:") ? args.path : `node:${args.path}`, external: true };
      if (args.path === "linkedom/worker") {
        const dependency = await publishedHtmlDependency();
        if (hash(await readFile(dependency.path)) !== dependency.sha256) throw new Error("sandbox_html_dependency_changed");
        return { path: dependency.path };
      }
      if (args.kind === "entry-point") return { path: await local(args.path) };
      if (!args.path.startsWith("./") && !args.path.startsWith("../")) throw new Error("sandbox_package_or_absolute_import_not_allowed");
      if (!inside(args.importer)) throw new Error("sandbox_dependency_import_not_allowed");
      return { path: await local(resolve(dirname(args.importer), args.path)) };
    });
    build.onLoad({ filter: /.*/ }, async ({ path }) => {
      const dependency = inside(path) ? undefined : await publishedHtmlDependency();
      if (dependency && key(path) !== key(dependency.path)) throw new Error("sandbox_loader_outside_snapshot");
      if (!dependency) await assertNoSymlinks(copy, path);
      const canonical = await realpath(path);
      if (!dependency && !key(canonical).startsWith(key(canonicalCopy) + sep) || dependency && key(canonical) !== key(dependency.path)) throw new Error("sandbox_loader_outside_snapshot");
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.size > LIMITS.snapshotBytes) throw new Error("sandbox_loader_file_limit");
      const bytes = await readFile(canonical);
      if (bytes.length !== stat.size || dependency && hash(bytes) !== dependency.sha256) throw new Error("sandbox_loader_input_changed");
      if (!loaded.has(key(canonical))) { loaded.add(key(canonical)); loadedBytes += bytes.length; }
      if (loadedBytes > LIMITS.snapshotBytes) throw new Error("sandbox_loader_total_limit");
      const extension = canonical.match(/\.(ts|mts|js|mjs|json)$/u)?.[1];
      if (!extension) throw new Error("sandbox_loader_not_allowed");
      const loader = extension === "json" ? "json" : extension === "ts" || extension === "mts" ? "ts" : "js";
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (loader !== "json") {
        const source = ts.createSourceFile(canonical, contents, ts.ScriptTarget.Latest, true, loader === "ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS);
        const inspect = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ts.isIdentifier(node.expression) && node.expression.text === "require" ||
            ts.isPropertyAccessExpression(node.expression) && (node.expression.name.text === "require" || ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "require"))) {
            const argument = node.arguments[0];
            if (!argument || !ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) throw new Error("sandbox_nonliteral_module_request");
          }
          ts.forEachChild(node, inspect);
        };
        inspect(source);
      }
      return { contents, loader, resolveDir: dirname(canonical) };
    }); } };
    const result = await esbuild.build({ absWorkingDir: copy, entryPoints: entries,
      outdir: join(copy, "tests", "source-repair-target"), outExtension: { ".js": ".mjs" }, bundle: true,
      format: "esm", target: "node24", platform: "node", write: false, metafile: true,
      sourcemap: false, logLevel: "silent", legalComments: "none", tsconfig: join(copy, "tsconfig.json"), plugins: [plugin] });
    for (const name of Object.keys(result.metafile.inputs)) {
      const canonical = await realpath(resolve(copy, name));
      if (!loaded.has(key(canonical))) throw new Error("sandbox_unapproved_compiler_input");
    }
    if (Object.values(result.metafile.outputs).some((output) => output.imports.some((item) => item.external && !builtins.has(item.path)))) throw new Error("parser_bundle_external_dependency");
    const expected = new Set(outputs.map((name) => key(containedPath(copy, name))));
    if (result.outputFiles.length !== outputs.length || Object.keys(result.metafile.outputs).length !== outputs.length ||
      Object.keys(result.metafile.outputs).some((name) => !expected.has(key(resolve(copy, name)))) ||
      result.outputFiles.some((output) => !expected.has(key(output.path)) || output.contents.length > LIMITS.snapshotBytes)) throw new Error("sandbox_unapproved_compiler_output");
    for (const output of result.outputFiles) { await assertNoSymlinks(copy, output.path); await writeFile(output.path, output.contents); }
    return outputs;
  } finally { esbuild.stop(); }
}

const CANARY = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
const checks = JSON.parse(readFileSync(new URL('./canary.json', import.meta.url), 'utf8'));
const results = [];
for (const path of checks.sentinels) for (const action of ['read', 'write']) {
  try { if (action === 'read') readFileSync(path); else writeFileSync(path, 'containment breached'); results.push(false); }
  catch (error) { results.push(['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(error.code)); }
}
let immutableDenied = false;
try { writeFileSync(new URL('./immutable-sentinel.txt', import.meta.url), 'containment breached'); } catch (error) { immutableDenied = ['EACCES', 'EPERM', 'EROFS'].includes(error.code); }
writeFileSync('/tmp/control.txt', 'permitted tmpfs write');
const tempWritable = readFileSync('/tmp/control.txt', 'utf8') === 'permitted tmpfs write';
const networkDenied = await new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port: checks.port });
  const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1800);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  socket.once('error', error => { clearTimeout(timer); resolve(['EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH'].includes(error.code)); });
});
const privateMountsAbsent = !existsSync('/mnt') && !existsSync('/home') && !existsSync('/run');
const environmentKeys = Object.keys(process.env);
const environmentScrubbed = environmentKeys.every(key => ['PATH','TMPDIR','PWD'].includes(key)) && (!process.env.PWD || process.env.PWD === '/sandbox');
console.log(JSON.stringify({ schemaVersion: 'source-repair-containment-v2', fileDenied: results.every(Boolean), immutableDenied, tempWritable, networkDenied, privateMountsAbsent, environmentScrubbed, environmentKeys, count: results.length }));
if (!results.every(Boolean) || !immutableDenied || !tempWritable || !networkDenied || !privateMountsAbsent || !environmentScrubbed) process.exitCode = 2;
`;

// Entry and operation come from immutable host metadata, never model output.
const PARSER_REPLAY = String.raw`import { readFileSync } from 'node:fs';
import { getSourceAdapter } from '../../lib/sources/registry';
import { replaySourceParserEvidence } from '../../lib/source-repair/replay';
const input = JSON.parse(readFileSync(new URL('../../parser-replay.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(await replaySourceParserEvidence(getSourceAdapter(input.sourceId), input.packet)));
`;

function parserReplayResult(process: ProcessReceipt, packet: SourceParserEvidencePacket): ParserReplayResult | undefined {
  if (process.exitCode !== 0 || process.timedOut || process.outputLimited) return undefined;
  let value: unknown; try { value = JSON.parse(process.stdout.trim()); } catch { return undefined; }
  if (!isRecord(value) || value.schemaVersion !== "source-parser-replay-result-v1" || value.sourceId !== packet.sourceId ||
      value.sourceRunId !== packet.sourceRunId || value.bodyHash !== packet.sanitizedBodyHash ||
      value.operation !== (packet.replay.operation ?? "parse_page") ||
      !["bounded", "limited"].includes(String(value.countContext))) return undefined;
  if (value.outcome === "parsed") {
    if (!Number.isSafeInteger(value.listingCount) || (value.listingCount as number) < 0) return undefined;
  } else if (value.outcome === "error") {
    if (!isRecord(value.error) || typeof value.error.name !== "string" || typeof value.error.message !== "string") return undefined;
  } else return undefined;
  return value as unknown as ParserReplayResult;
}

export interface LinuxSandbox {
  area: string; copy: string; temporary: string; nodeTree: string; host: string; configuration: string;
  testFiles: string[];
}

const CONTRACT_TESTS = String.raw`import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getSourceAdapter } from '../../lib/sources/registry';
const target = JSON.parse(readFileSync(new URL('../../target-contract.json', import.meta.url), 'utf8'));
const adapter = getSourceAdapter(target.sourceId);
test('immutable source target contract', () => {
  assert.equal(adapter.manifest.id, target.sourceId);
  assert.equal(adapter.manifest.enabledByDefault, false);
  assert.equal(adapter.manifest.inventoryScope, 'current');
  assert.ok(['json_api','html'].includes(adapter.manifest.transport));
  assert.ok(Array.isArray(adapter.manifest.requests.allowedHosts) && adapter.manifest.requests.allowedHosts.length > 0);
  assert.equal(typeof adapter.parseDiscoveryPage, 'function');
  const plans = adapter.planDiscovery(); assert.ok(Array.isArray(plans));
  assert.deepEqual(plans, adapter.planDiscovery());
  for (const plan of plans) { assert.equal(typeof plan.url, 'string'); assert.ok(['discovery','api','detail'].includes(plan.kind)); }
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  console.log('source-repair-contract-v1 ' + JSON.stringify({ schemaVersion:'source-repair-contract-v1', sourceId:target.sourceId,
    manifestHash:digest(adapter.manifest), discoveryPlanHash:digest(plans) }));
});
`;

/** Copies only public library code and the exact operator-approved target union. */
export async function createRepairSnapshot(projectRoot: string, job: RepairJob, copy: string): Promise<string[]> {
  await assertCurrentRepairTarget(projectRoot, job.target);
  if (job.targetHash !== job.target.targetHash || job.sourceId !== job.target.sourceId || job.adapterPath !== job.target.adapterPath ||
      job.adapterHash !== job.target.fileHashes[job.adapterPath]) throw new Error("sandbox_target_job_mismatch");
  const state = { bytes: 0, files: 0 };
  await copyTrustedTree(projectRoot, "lib", copy, state, /\.(?:ts|json)$/u);
  for (const name of repairTargetFiles(job.target)) {
    const source = containedPath(projectRoot, name); await assertNoSymlinks(projectRoot, source);
    const bytes = await readFile(source);
    if (hash(bytes) !== job.target.fileHashes[name]) throw new Error("sandbox_target_changed_during_copy");
    state.bytes += bytes.length; state.files++;
    if (state.bytes > LIMITS.snapshotBytes || state.files > 2_000) throw new Error("sandbox_snapshot_limit");
    const destination = containedPath(copy, name); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: "wx" });
  }
  const registry = containedPath(copy, "lib/sources/registry.ts");
  const specifier = JSON.stringify(`../../${job.adapterPath}`);
  await writeFile(registry, `import { adapter } from ${specifier};\nexport { adapter };\nexport const sourceRegistry = new Map([[${JSON.stringify(job.sourceId)}, adapter]]);\nexport function getSourceAdapter(id: string) { if (id !== ${JSON.stringify(job.sourceId)}) throw new Error('sandbox_source_identity_mismatch'); return adapter; }\nexport function findSourceAdapter(id: string) { return sourceRegistry.get(id); }\nexport function listSourceManifests() { return [adapter.manifest]; }\n`);
  await writeFile(join(copy, "package.json"), '{"private":true,"type":"module"}\n', { flag: "wx" });
  await writeFile(join(copy, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"}}\n', { flag: "wx" });
  await writeJson(copy, "target-contract.json", { sourceId: job.sourceId });
  const contract = containedPath(copy, "tests/source-repair-target/contracts.test.ts"); await mkdir(dirname(contract), { recursive: true }); await writeFile(contract, CONTRACT_TESTS, { flag: "wx" });
  return [...job.target.testFiles, "tests/source-repair-target/contracts.test.ts"];
}
export async function createLinuxSandbox(projectRoot: string, job: RepairJob): Promise<LinuxSandbox> {
  const storage = await repairStorageAdmission(projectRoot, LIMITS.snapshotBytes + 3 * LIMITS.processBytes);
  if (!storage.eligible) throw new Error(storage.reason);
  const nodeTree = await pinnedNode(projectRoot);
  const area = containedPath(projectRoot, `work/source-repairs/sandboxes/${randomUUID().slice(0, 12)}`);
  const copy = join(area, "copy"); const temporary = join(area, "temp");
  if (process.platform === "win32" && copy.length > 240) throw new Error("sandbox_working_directory_too_long");
  await assertNoSymlinks(projectRoot, area); await mkdir(copy, { recursive: true }); await mkdir(temporary);
  const testFiles = await createRepairSnapshot(projectRoot, job, copy);
  await writeFile(join(copy, "canary.mjs"), CANARY, { flag: "wx" });
  await writeFile(join(copy, "immutable-sentinel.txt"), "immutable parser policy\n", { flag: "wx" });
  const canaryDirectory = join(projectRoot, "work", "source-repairs", "canaries");
  await assertNoSymlinks(projectRoot, canaryDirectory); await mkdir(canaryDirectory, { recursive: true });
  const sentinels = [join(canaryDirectory, `${randomUUID().slice(0, 8)}.txt`), join(area, "outside-sentinel.txt")];
  for (const path of sentinels) await writeFile(path, "protected repair canary\n");
  await writeJson(copy, "canary.json", { sentinels: sentinels.map(windowsToWslPath) });
  const host = join(area, "linux-host.mjs");
  await writeFile(host, await readFile(fileURLToPath(new URL("./linux-host.mjs", import.meta.url))), { flag: "wx" });
  const configuration = join(temporary, "linux.json");
  await writeJson(temporary, "linux.json", { schemaVersion: "source-repair-linux-host-v1", copy: windowsToWslPath(copy), node: windowsToWslPath(nodeTree),
    tests: testFiles.map((_name, index) => `tests/source-repair-target/t${String(index).padStart(2, "0")}.test.mjs`), sentinels: sentinels.map(windowsToWslPath), timeoutMs: 70_000, maximumBytes: LIMITS.processBytes });
  return { area, copy, temporary, nodeTree, host, configuration, testFiles };
}
export async function runLinuxSandbox(sandbox: LinuxSandbox, mode: "canary" | "fixtures" | "replay" | "lifetime_fixture", options: {
  runner?: ProcessRunner; signal?: AbortSignal; timeoutMs?: number; onStdout?: (chunk: string) => void;
} = {}): Promise<ProcessReceipt> {
  return (options.runner ?? runBoundedProcess)(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe"),
    ["-d", "Ubuntu", "--", `${windowsToWslPath(sandbox.nodeTree)}/bin/node`, windowsToWslPath(sandbox.host), mode, windowsToWslPath(sandbox.configuration)],
    { cwd: sandbox.copy, env: scrubEnvironment(sandbox.temporary), timeoutMs: options.timeoutMs ?? LIMITS.processMs,
      maximumBytes: LIMITS.processBytes, signal: options.signal, onStdout: options.onStdout });
}
export async function validateIsolatedProposal(projectRoot: string, job: RepairJob, candidate: string,
  options: { runner?: ProcessRunner; signal?: AbortSignal } = {}): Promise<ValidationReceipt> {
  const receipt: ValidationReceipt = { status: "sandbox_unavailable", checkedAt: new Date().toISOString(), proposalOnly: true, liveFailureReproduced: false };
  try {
    const original = await readOwned(projectRoot, job.adapterPath);
    if (hash(original) !== job.adapterHash) { receipt.status = "stale_base"; receipt.reason = "adapter_changed_since_failure"; return receipt; }
    await assertCurrentRepairTarget(projectRoot, job.target);
    if (job.adapterPath !== job.target.adapterPath || job.targetHash !== job.target.targetHash) { receipt.reason = "source_adapter_target_mismatch"; return receipt; }
    let packet: SourceParserEvidencePacket | undefined;
    let replayMissingReason = "current_live_failure_reproducer_not_available";
    if (job.sourceRunId && job.evidenceHash && job.evidenceKey) {
      const evidence = await loadSourceParserEvidence(projectRoot, job.sourceRunId, job.sourceId);
      if (!evidence.available) replayMissingReason = `parser_evidence_unavailable:${evidence.reason}`;
      else if (evidence.artifactHash !== job.evidenceHash || evidence.key !== job.evidenceKey) replayMissingReason = "parser_evidence_job_link_mismatch";
      else if (evidence.packet.diagnostic.errorCode !== job.diagnostic.errorCode ||
          evidence.packet.diagnostic.message !== sanitizeDiagnostic(job.diagnostic.message)) replayMissingReason = "parser_evidence_diagnostic_mismatch";
      else { packet = evidence.packet; receipt.evidenceHash = evidence.artifactHash; }
    }
    const sandbox = await createLinuxSandbox(projectRoot, job);
    receipt.sandboxPath = relative(projectRoot, sandbox.copy).replaceAll("\\", "/");
    receipt.testFiles = sandbox.testFiles;
    const entries = [...receipt.testFiles];
    if (packet) {
      await writeJson(sandbox.copy, "parser-replay.json", { sourceId: job.sourceId, sourceRunId: job.sourceRunId, packet });
      await writeFile(join(sandbox.copy, "tests", "source-repair-target", "replay.ts"), PARSER_REPLAY, { flag: "wx" });
      entries.push("tests/source-repair-target/replay.ts");
    }
    await bundleRepairEntries(sandbox.copy, entries);
    receipt.containment = await runLinuxSandbox(sandbox, "canary", options);
    let result: unknown; try { result = JSON.parse(receipt.containment.stdout.trim()); } catch { /* unavailable */ }
    const config = JSON.parse(await readFile(sandbox.configuration, "utf8")) as { sentinels: string[] };
    const unchanged = (await Promise.all(config.sentinels.map((path) => readFile(path.replace(/^\/mnt\/([a-z])/u, (_match: string, drive: string) => `${drive.toUpperCase()}:`), "utf8")))).every((text) => text === "protected repair canary\n");
    if (receipt.containment.exitCode !== 0 || receipt.containment.timedOut || receipt.containment.outputLimited || !isContainmentReceipt(result) || !unchanged ||
      await readFile(join(sandbox.copy, "immutable-sentinel.txt"), "utf8") !== "immutable parser policy\n") {
      receipt.reason = "containment_canary_failed"; return receipt;
    }
    receipt.snapshotHash = await snapshotHash(sandbox.copy);
    receipt.baseline = await runLinuxSandbox(sandbox, "fixtures", options);
    if (await snapshotHash(sandbox.copy) !== receipt.snapshotHash) throw new Error("trusted_snapshot_changed");
    if (receipt.baseline.exitCode !== 0 || receipt.baseline.timedOut || receipt.baseline.outputLimited) { receipt.status = "baseline_failed"; receipt.reason = "existing_fixture_checks_did_not_pass"; return receipt; }
    if (packet) {
      receipt.replayBaseline = await runLinuxSandbox(sandbox, "replay", options);
      if (await snapshotHash(sandbox.copy) !== receipt.snapshotHash) throw new Error("trusted_snapshot_changed");
      const result = parserReplayResult(receipt.replayBaseline, packet);
      receipt.liveFailureReproduced = Boolean(result && replayFailureMatches(result, packet));
      if (!receipt.liveFailureReproduced) {
        replayMissingReason = Object.values(packet.metadata.redactions).some((count) => count > 0)
          ? "original_error_mismatch_after_sanitization" : "original_error_not_reproduced";
      }
    }
    await writeFile(containedPath(sandbox.copy, job.adapterPath), candidate);
    await bundleRepairEntries(sandbox.copy, entries);
    receipt.candidateHash = await snapshotHash(sandbox.copy);
    receipt.candidate = await runLinuxSandbox(sandbox, "fixtures", options);
    if (await snapshotHash(sandbox.copy) !== receipt.candidateHash) throw new Error("candidate_modified_immutable_snapshot");
    if (receipt.candidate.exitCode !== 0 || receipt.candidate.timedOut || receipt.candidate.outputLimited) {
      receipt.status = "candidate_failed"; receipt.reason = "candidate_fixture_checks_failed"; return receipt;
    }
    const contracts = (process: ProcessReceipt) => [...process.stdout.matchAll(/source-repair-contract-v1\s+(\{[^\r\n]*?\})/gu)].map((match) => match[1]);
    const baselineContract = contracts(receipt.baseline); const candidateContract = contracts(receipt.candidate);
    if (baselineContract.length !== 1 || candidateContract.length !== 1 || baselineContract[0] !== candidateContract[0]) {
      receipt.status = "candidate_failed"; receipt.reason = "candidate_source_contract_changed"; return receipt;
    }
    receipt.status = "fixtures_passed_reproducer_missing"; receipt.reason = replayMissingReason;
    if (packet && receipt.liveFailureReproduced) {
      receipt.replayCandidate = await runLinuxSandbox(sandbox, "replay", options);
      if (await snapshotHash(sandbox.copy) !== receipt.candidateHash) throw new Error("candidate_modified_immutable_snapshot");
      const result = parserReplayResult(receipt.replayCandidate, packet);
      if (result?.outcome !== "parsed") { receipt.status = "candidate_failed"; receipt.reason = "candidate_saved_failure_replay_failed"; }
      else if (result.countContext !== "bounded") { receipt.status = "replay_limited"; receipt.reason = "replay_count_context_insufficient"; }
      else { receipt.status = "replay_and_fixtures_passed"; receipt.reason = "saved_failure_reproduced_and_candidate_checks_passed"; }
    }
    await assertCurrentRepairTarget(projectRoot, job.target);
    return receipt;
  } catch (error) { receipt.reason = sanitizeDiagnostic(error instanceof Error ? error.message : "sandbox_setup_failed"); return receipt; }
}
function isContainmentReceipt(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === "source-repair-containment-v2" && value.fileDenied === true && value.immutableDenied === true &&
    value.tempWritable === true && value.networkDenied === true && value.privateMountsAbsent === true && value.environmentScrubbed === true &&
    value.networkControl === true && value.acceptedConnections === 0 && typeof value.count === "number" && value.count >= 4;
}
