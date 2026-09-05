import os from "node:os";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

try {
  loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// Some restricted Windows subprocesses cannot query the account database.
// Keep the normal OS identity unless that query fails; tsx only needs a cache key.
try {
  os.userInfo();
} catch {
  os.userInfo = () => ({ username: "auction-discovery", uid: -1, gid: -1, shell: null, homedir: os.homedir() });
}
