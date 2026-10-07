import { parseEnv } from "node:util";
import ts from "typescript";
import { hash, isRecord, LIMITS, readOwned } from "./core.ts";
import { loopbackOrigin } from "./diagnostics.ts";

export const SOURCE_REPAIR_CONFIG_SCHEMA = "source-repair-config-v1";
export const SOURCE_REPAIR_SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
export const TARGET_LIMITS = Object.freeze({ targets: 32, files: 64, bytes: 8_000_000, fileBytes: 2_000_000 });
export interface SourceRepairTarget { sourceId: string; adapterPath: string; testFiles: string[]; files: string[] }
export interface ValidatedRepairTarget extends SourceRepairTarget { targetHash: string; fileHashes: Record<string, string>; totalBytes: number }
export interface SourceRepairConfig { schemaVersion: typeof SOURCE_REPAIR_CONFIG_SCHEMA; targets: SourceRepairTarget[] }
export type RepairConfigResult = { available: true; targets: ValidatedRepairTarget[]; configHash: string } | { available: false; reason: string };
export interface RepairSettings { noAi: boolean; origin: string; model?: string; reason?: string }

const SELECTED_KEYS = ["SOURCE_REPAIR_ENABLED", "SOURCE_REPAIR_MODEL", "SOURCE_REPAIR_OLLAMA_URL", "AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "OLLAMA_BASE_URL"] as const;
const PRIVATE_PATH = /(?:^|[./_-])(?:env|secrets?|credentials?|cookies?|tokens?|passwords?|private[_-]?keys?|api[_-]?keys?|id_rsa)(?:[./_-]|$)/iu;
const INLINE_SECRET = /(?:["']?\b(?:authorization|cookie|set-cookie|api[_-]?key|token|(?:api|access|auth|refresh|id|client|session)[_-]?(?:token|key|secret)|password|secret|capability)\b["']?\s*[:=]\s*["'][^"'\r\n]+["'])|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu;
export function repairTargetFiles(target: SourceRepairTarget): string[] { return [...new Set([target.adapterPath, ...target.testFiles, ...target.files])].sort(); }
export function validateModelTag(value: string): string {
  const model = value.trim();
  if (!model || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(model) || model.includes("..") || model.includes("://")) throw new Error("repair_model_tag_invalid");
  if (/(?:^|[-:])cloud(?:$|[-:])/iu.test(model)) throw new Error("repair_model_must_be_local");
  return model;
}
export async function loadRepairSettings(projectRoot: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<RepairSettings> {
  let local: Readonly<Record<string, string | undefined>> = {};
  try { local = parseEnv(await readOwned(projectRoot, ".env.local", 65_536)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { noAi: true, origin: "http://127.0.0.1:11434", reason: "repair_settings_unavailable" }; }
  const selected = Object.fromEntries(SELECTED_KEYS.map((key) => [key, environment[key] !== undefined ? environment[key] : local[key]]));
  const optional = (value: string | undefined) => value?.trim() || undefined;
  const enabled = selected.SOURCE_REPAIR_ENABLED ?? "0";
  if (!["0", "1"].includes(enabled)) return { noAi: true, origin: "http://127.0.0.1:11434", reason: "repair_enabled_value_invalid" };
  let origin: string;
  try { origin = loopbackOrigin(optional(selected.SOURCE_REPAIR_OLLAMA_URL) ?? optional(selected.OLLAMA_BASE_URL) ?? "http://127.0.0.1:11434"); }
  catch { return { noAi: true, origin: "http://127.0.0.1:11434", reason: "repair_provider_configuration_invalid" }; }
  const rawModel = optional(selected.SOURCE_REPAIR_MODEL) ?? (selected.AI_TEXT_PROVIDER?.trim().toLowerCase() === "ollama" ? optional(selected.AI_TEXT_MODEL) : undefined);
  let model: string | undefined;
  if (rawModel !== undefined) try { model = validateModelTag(rawModel); } catch (error) { return { noAi: true, origin, reason: (error as Error).message }; }
  if (enabled === "1" && !model) return { noAi: true, origin, reason: "repair_model_required" };
  return { noAi: enabled === "0", origin, model };
}
function checkedPath(value: unknown, kind: "adapter" | "test" | "support"): string {
  if (typeof value !== "string" || value.length > 220 || !/^source-adapters\.local\/[A-Za-z0-9._/-]+$/u.test(value) ||
    value.split("/").some((part) => ["", ".", ".."].includes(part)) || PRIVATE_PATH.test(value)) throw new Error("repair_target_path_invalid");
  if (kind === "adapter" && !/\/adapter\.(?:ts|mts)$/u.test(value) || kind === "test" && !/\.test\.(?:ts|mts)$/u.test(value) ||
    kind === "support" && !/\.(?:ts|json|html|txt)$/u.test(value)) throw new Error("repair_target_extension_invalid");
  return value;
}
function checkedTarget(value: unknown): SourceRepairTarget {
  if (!isRecord(value) || Object.keys(value).sort().join() !== "adapterPath,files,sourceId,testFiles" || typeof value.sourceId !== "string" || !SOURCE_REPAIR_SOURCE_ID.test(value.sourceId) ||
    !Array.isArray(value.testFiles) || value.testFiles.length < 1 || !Array.isArray(value.files)) throw new Error("repair_target_contract_invalid");
  const target = { sourceId: value.sourceId, adapterPath: checkedPath(value.adapterPath, "adapter"), testFiles: value.testFiles.map((path) => checkedPath(path, "test")), files: value.files.map((path) => checkedPath(path, "support")) };
  if (new Set(target.testFiles).size !== target.testFiles.length || new Set(target.files).size !== target.files.length || repairTargetFiles(target).length > TARGET_LIMITS.files) throw new Error("repair_target_file_limit");
  return target;
}
function hasAdapterExport(text: string): boolean {
  const file = ts.createSourceFile("adapter.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
  const variables = new Set(file.statements.flatMap((statement) => ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []) : []));
  return file.statements.some((statement) => ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "adapter") ||
    ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some((element) => element.name.text === "adapter" && variables.has(element.propertyName?.text ?? element.name.text)));
}
export async function validateRepairTarget(projectRoot: string, input: unknown): Promise<ValidatedRepairTarget> {
  const target = checkedTarget(input); const fileHashes: Record<string, string> = {}; let totalBytes = 0;
  for (const path of repairTargetFiles(target)) {
    const text = await readOwned(projectRoot, path, path === target.adapterPath ? LIMITS.adapterBytes : TARGET_LIMITS.fileBytes);
    if (INLINE_SECRET.test(text)) throw new Error("repair_target_possible_secret");
    totalBytes += Buffer.byteLength(text); if (totalBytes > TARGET_LIMITS.bytes) throw new Error("repair_target_byte_limit");
    fileHashes[path] = hash(text);
    if (path === target.adapterPath && !hasAdapterExport(text)) throw new Error("repair_target_adapter_export_missing");
  }
  return { ...target, fileHashes, totalBytes, targetHash: hash(JSON.stringify({ ...target, fileHashes })) };
}
export async function assertCurrentRepairTarget(projectRoot: string, target: ValidatedRepairTarget): Promise<void> {
  const current = await validateRepairTarget(projectRoot, { sourceId: target.sourceId, adapterPath: target.adapterPath, testFiles: target.testFiles, files: target.files });
  if (current.targetHash !== target.targetHash || JSON.stringify(current.fileHashes) !== JSON.stringify(target.fileHashes)) throw new Error("repair_target_changed_since_preparation");
}
export async function loadRepairConfig(projectRoot: string): Promise<RepairConfigResult> {
  try {
    const value: unknown = JSON.parse(await readOwned(projectRoot, "source-repair.config.local.json", 65_536));
    if (!isRecord(value) || Object.keys(value).sort().join() !== "schemaVersion,targets" || value.schemaVersion !== SOURCE_REPAIR_CONFIG_SCHEMA ||
      !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > TARGET_LIMITS.targets) throw new Error("repair_config_contract_invalid");
    const targets = await Promise.all(value.targets.map((target) => validateRepairTarget(projectRoot, target)));
    if (new Set(targets.map((target) => target.sourceId)).size !== targets.length || new Set(targets.map((target) => target.adapterPath)).size !== targets.length) throw new Error("repair_config_duplicate_target");
    return { available: true, targets, configHash: hash(JSON.stringify(targets)) };
  } catch (error) { return { available: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "repair_config_missing" : error instanceof Error && /^repair_/u.test(error.message) ? error.message : "repair_config_unavailable" }; }
}
