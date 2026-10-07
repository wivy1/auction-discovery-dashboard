import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";

export const REPAIR_STORE_LIMITS = Object.freeze({ bytes: 1_073_741_824, minimumFreeBytes: 536_870_912 });
export type StorageMeasure = (projectRoot: string) => Promise<{ usedBytes: number; freeBytes: number }>;
const measureStore: StorageMeasure = async (projectRoot) => {
  let usedBytes = 0; let entries = 0;
  const visit = async (path: string) => {
    const stat = await lstat(path);
    if (++entries > 50_000) throw new Error("repair_store_measurement_limit");
    if (stat.isSymbolicLink() || stat.isFile()) { usedBytes += stat.size; return; }
    if (stat.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  await visit(join(projectRoot, "work", "source-repairs")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const filesystem = await statfs(projectRoot);
  return { usedBytes, freeBytes: filesystem.bavail * filesystem.bsize };
};
/** Optional repair work stops before adding bytes; existing evidence is retained. */
export async function repairStorageAdmission(projectRoot: string, reservedBytes: number, measure: StorageMeasure = measureStore): Promise<{ eligible: boolean; reason: string }> {
  try {
    const { usedBytes, freeBytes } = await measure(projectRoot);
    if (![usedBytes, freeBytes, reservedBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid_storage_measurement");
    if (usedBytes + reservedBytes > REPAIR_STORE_LIMITS.bytes) return { eligible: false, reason: "repair_store_byte_limit" };
    if (freeBytes - reservedBytes < REPAIR_STORE_LIMITS.minimumFreeBytes) return { eligible: false, reason: "repair_store_free_space_limit" };
    return { eligible: true, reason: "repair_storage_available" };
  } catch { return { eligible: false, reason: "repair_store_measurement_unavailable" }; }
}
