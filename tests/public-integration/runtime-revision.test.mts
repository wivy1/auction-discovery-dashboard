import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeRuntimeRevision } from "../../lib/runtime-revision.ts";

test("changing the local adapter configuration invalidates runtime admission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "auction-revision-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"revision-fixture"}\n');
    await writeFile(path.join(root, "source-adapters.local.ts"), "export default [];\n");
    const before = await computeRuntimeRevision(root);
    await writeFile(path.join(root, "source-adapters.local.ts"), "export default []; // updated local integration\n");
    const after = await computeRuntimeRevision(root);
    assert.notEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
