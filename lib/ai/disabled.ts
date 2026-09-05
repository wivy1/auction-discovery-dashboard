import { AiProviderError } from "./errors";
import type { AiProviders, ProviderHealth } from "./types";

/** An inactive capability can be described safely without contacting a service. */
export function disabledAiProviders(): AiProviders {
  const unavailable = async (): Promise<never> => {
    throw new AiProviderError({
      code: "configuration",
      providerName: "disabled",
      message: "Text enrichment is not configured. Set both text and embedding provider/model settings before requesting enrichment.",
    });
  };
  const healthCheck = async (): Promise<ProviderHealth> => ({
    ok: false,
    providerName: "disabled",
    modelName: "",
    modelAvailable: false,
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
    message: "Optional text enrichment is not configured.",
  });
  const identity = { providerName: "disabled", modelName: "", healthCheck };
  return {
    text: { ...identity, generateText: unavailable, generateStructured: unavailable },
    embeddings: { ...identity, embed: unavailable },
  };
}
