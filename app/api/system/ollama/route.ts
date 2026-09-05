import { getConfig } from "../../../../lib/config";

export const dynamic = "force-dynamic";

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

function modelNamesMatch(installed: string, configured: string): boolean {
  return installed === configured ||
    (!configured.includes(":") && installed === `${configured}:latest`);
}

function jsonHealth(body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
  });
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Ollama model response was too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size error below is the useful health result.
      }
      throw new Error("Ollama model response was too large");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const config = getConfig();
    const baseUrl = new URL(config.ai.ollamaBaseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("OLLAMA_BASE_URL must use HTTP or HTTPS");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(new URL("/api/tags", baseUrl), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
      const body = await readLimitedText(response, 1_000_000);
      const payload = JSON.parse(body) as OllamaTagsResponse;
      const installed = (payload.models ?? [])
        .map((model) => model.name ?? model.model ?? "")
        .filter(Boolean);
      const textModelAvailable = installed.some((name) =>
        modelNamesMatch(name, config.ai.textModel)
      );
      const embeddingModelAvailable = installed.some((name) =>
        modelNamesMatch(name, config.ai.embeddingModel)
      );
      const modelsReady = textModelAvailable && embeddingModelAvailable;
      return jsonHealth({
        reachable: true,
        textModelAvailable,
        embeddingModelAvailable,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        message: modelsReady ? null : "One or more configured models are not installed",
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return jsonHealth({
      reachable: false,
      textModelAvailable: false,
      embeddingModelAvailable: false,
      latencyMs: null,
      checkedAt,
      message: error instanceof Error && error.name === "AbortError"
        ? "Ollama did not respond within 2.5 seconds"
        : error instanceof SyntaxError
          ? "Ollama returned invalid JSON"
          : "Ollama is unavailable",
    });
  }
}
