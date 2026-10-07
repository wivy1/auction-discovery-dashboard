import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
export async function fixture<T>(action: (root: string) => Promise<T>): Promise<T> {
  const area = join(projectRoot, "work", "source-repair-entrypoint-tests");
  await mkdir(area, { recursive: true }); const root = await mkdtemp(join(area, "case-"));
  try { return await action(root); }
  finally { assert.ok(resolve(root).startsWith(resolve(area) + sep)); await rm(root, { recursive: true, force: true }); }
}
export function powershell(file: string, root: string, args: string[] = [], environment: Readonly<Record<string, string | undefined>> = {}) {
  const executable = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}
export async function setupFixture(root: string, source: string, pnpmExit = 0): Promise<string> {
  const scripts = join(root, "scripts"); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, "setup.ps1"), source);
  const fakeNode = join(scripts, "fixture-node.cmd"); const fakePnpm = join(scripts, "fixture-pnpm.cmd");
  await writeFile(fakeNode, "@echo off\r\necho v24.18.0\r\nexit /b 0\r\n");
  await writeFile(fakePnpm, `@echo off\r\nexit /b ${pnpmExit}\r\n`);
  await writeFile(join(scripts, "runtime.ps1"), `$script:ProjectRoot=${psLiteral(root)}\n$script:NodeExe=${psLiteral(fakeNode)}\n$script:PnpmExe=${psLiteral(fakePnpm)}\n`);
  await writeFile(join(root, "source-adapters.example.ts"), "export const sourceAdapters = [];\n");
  await writeFile(join(root, "source-repair.config.example.json"), '{"schemaVersion":"source-repair-config-v1","targets":[]}\n');
  return join(scripts, "setup.ps1");
}
