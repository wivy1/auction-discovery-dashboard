export function sourceCanBeEnabled(
  implementationStatus: string,
  permissionStatus: string,
): boolean {
  return implementationStatus === "ready" && permissionStatus === "allowed";
}

export type SourceRunMode = "normal" | "canary" | "continuation";

export function sourceCanRunInMode(
  implementationStatus: string,
  enabled: boolean,
  mode: SourceRunMode,
): boolean {
  return mode === "canary"
    ? implementationStatus !== "not_implemented"
    : implementationStatus === "ready" && enabled;
}
