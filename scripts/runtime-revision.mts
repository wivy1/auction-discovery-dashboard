import { fileURLToPath } from "node:url";

import {
  computeRuntimeRevision,
  runtimeRevisionPayload,
} from "../lib/runtime-revision.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const revision = await computeRuntimeRevision(projectRoot);
process.stdout.write(`${JSON.stringify(runtimeRevisionPayload(revision))}\n`);
