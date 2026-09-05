import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (/\.test\.(?:mts|ts|mjs)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

const files = process.argv.slice(2);
const child = spawn(process.execPath, [
  "--import", "./scripts/node-runtime-preload.mjs", "--import", "tsx", "--test",
  ...files.length ? files : await collect("tests"),
], { stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
