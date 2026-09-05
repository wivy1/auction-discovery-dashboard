import type { AiOutputProvenance, ProviderResult } from "./types";

export function provenanceFor<T>(
  result: ProviderResult<T>,
  promptVersion: string,
  inputHash: string,
): AiOutputProvenance {
  return Object.freeze({
    providerName: result.providerName,
    modelName: result.modelName,
    promptVersion,
    inputHash,
    generatedAt: result.generatedAt,
  });
}

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

