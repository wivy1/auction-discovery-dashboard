import { HttpError } from "./http";

export const LOCAL_COMPANION_CAPABILITY_HEADER =
  "x-auction-discovery-capability";
export const MAX_LOCAL_COMPANION_JSON_BYTES = 32 * 1024 * 1024;
export const ACQUIRED_PAGE_GZIP_OVERHEAD_BYTES = 64 * 1024;
export const MAX_ACQUIRED_PAGE_DECOMPRESSION_RATIO = 2_048;

export interface EncodedAcquiredPageBody {
  readonly encoding: "gzip-base64";
  readonly data: string;
  readonly decodedBytes: number;
}

export interface DecodedAcquiredPageBody {
  readonly body: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export function assertLocalCompanionRequest(
  request: Request,
  expectedCapability?: string,
): void {
  const url = new URL(request.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "localhost" ||
    url.port !== "3000"
  ) {
    throw new HttpError(
      "Local companion callback authority is invalid",
      403,
      "local_companion_authority",
    );
  }
  const expected = expectedCapability?.trim() ||
    process.env.AUCTION_DISCOVERY_IMAGE_TOKEN?.trim() ||
    "";
  const actual =
    request.headers.get(LOCAL_COMPANION_CAPABILITY_HEADER)?.trim() ?? "";
  if (
    expected.length < 32 ||
    actual.length !== expected.length ||
    !constantTimeTextEqual(actual, expected)
  ) {
    throw new HttpError(
      "Local companion capability is invalid",
      403,
      "local_companion_unauthorized",
    );
  }
}

export async function readBoundedJson<T>(
  request: Request,
  maxBytes: number,
): Promise<T> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_LOCAL_COMPANION_JSON_BYTES
  ) {
    throw new RangeError("Bounded JSON byte ceiling is invalid.");
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(
      "Local companion callbacks require JSON",
      415,
      "unsupported_media_type",
    );
  }
  const declared = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(
      "Local companion callback is too large",
      413,
      "request_too_large",
    );
  }
  if (!request.body) {
    throw new HttpError(
      "Local companion callback body is required",
      400,
      "invalid_json",
    );
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(
          "Local companion callback is too large",
          413,
          "request_too_large",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(
      "Local companion callback contains invalid JSON",
      400,
      "invalid_json",
    );
  }
}

export function declaredEncodedAcquiredPageBodyBytes(
  value: unknown,
  maxDecodedBytes: number,
  index = 0,
): number {
  if (
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > MAX_LOCAL_COMPANION_JSON_BYTES
  ) {
    throw new RangeError("Acquired page byte ceiling is invalid.");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.encoding !== "gzip-base64" ||
    typeof value.data !== "string" ||
    !Number.isSafeInteger(value.decodedBytes) ||
    (value.decodedBytes as number) < 1
  ) {
    throw invalidEncodedAcquiredPage(index);
  }
  if ((value.decodedBytes as number) > maxDecodedBytes) {
    throw oversizedEncodedAcquiredPage();
  }
  const maxCompressedBytes =
    maxDecodedBytes + ACQUIRED_PAGE_GZIP_OVERHEAD_BYTES;
  const maxEncodedCharacters = 4 * Math.ceil(maxCompressedBytes / 3);
  if (
    value.data.length < 4 ||
    value.data.length > maxEncodedCharacters
  ) {
    throw oversizedEncodedAcquiredPage();
  }
  return value.decodedBytes as number;
}

export async function decodeEncodedAcquiredPageBody(
  value: unknown,
  maxDecodedBytes: number,
  index = 0,
): Promise<DecodedAcquiredPageBody> {
  const decodedBytes = declaredEncodedAcquiredPageBodyBytes(
    value,
    maxDecodedBytes,
    index,
  );
  const encoded = value as EncodedAcquiredPageBody;
  const compressed = decodeCanonicalBase64(encoded.data, index);
  if (
    compressed.byteLength >
      maxDecodedBytes + ACQUIRED_PAGE_GZIP_OVERHEAD_BYTES ||
    decodedBytes >
      compressed.byteLength * MAX_ACQUIRED_PAGE_DECOMPRESSION_RATIO
  ) {
    throw oversizedEncodedAcquiredPage();
  }

  const compressedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const decompressor = new DecompressionStream("gzip") as unknown as
      TransformStream<Uint8Array, Uint8Array>;
    reader = compressedStream
      .pipeThrough(decompressor)
      .getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxDecodedBytes) {
        await reader.cancel().catch(() => undefined);
        throw oversizedEncodedAcquiredPage();
      }
      if (total > decodedBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidEncodedAcquiredPage(index);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidEncodedAcquiredPage(index);
  } finally {
    reader?.releaseLock();
  }
  if (total !== decodedBytes) {
    throw invalidEncodedAcquiredPage(index);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidEncodedAcquiredPage(index);
  }
  return { body, bytes };
}

function decodeCanonicalBase64(value: string, index: number): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw invalidEncodedAcquiredPage(index);
  }
  if (btoa(binary) !== value) {
    throw invalidEncodedAcquiredPage(index);
  }
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) {
    bytes[offset] = binary.charCodeAt(offset);
  }
  return bytes;
}

function invalidEncodedAcquiredPage(index: number): HttpError {
  return new HttpError(
    `Acquired source page ${index + 1} is invalid`,
    400,
    "invalid_source_acquisition_page",
  );
}

function oversizedEncodedAcquiredPage(): HttpError {
  return new HttpError(
    "Acquired source HTML exceeds its byte ceiling",
    413,
    "source_page_too_large",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  let different = 0;
  for (let index = 0; index < right.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}
