import { listSourceManifests } from "../lib/sources/registry.ts";
process.stdout.write(`${JSON.stringify(listSourceManifests().map(({ id }) => id))}\n`);
