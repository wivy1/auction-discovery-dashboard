export interface ArchivedImage {
  sourceUrl: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface ValidatedImageBytes {
  readonly body: ArrayBuffer;
  readonly sha256: string;
  readonly contentHash: `sha256:${string}`;
  readonly byteSize: number;
  readonly contentType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly objectKey: string;
}

export type ImageArchiveAcquisitionMethod =
  | "browser"
  | "direct";

export interface ImageRedirectRule {
  readonly host: string;
  readonly pathPrefix: string;
}

export type ImageRequestExecutor = <T>(
  url: URL,
  handle: (response: Response) => Promise<T>,
) => Promise<T>;

export interface ArchivePrimaryImageInput {
  storage: R2Bucket;
  source: string;
  sourceListingId: string;
  imageUrl: string;
  canonicalSourceUrl?: string;
  representation?: "observed_thumbnail";
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedHosts?: readonly string[];
  allowedRedirectHosts?: readonly string[];
  allowedRedirectRules?: readonly ImageRedirectRule[];
  fetchImpl?: typeof fetch;
  requestExecutor?: ImageRequestExecutor;
  allowDeclaredContentTypeMismatch?: boolean;
}

export interface ArchiveImageBytesInput {
  storage: R2Bucket;
  source: string;
  sourceListingId: string;
  sourceUrl: string;
  canonicalSourceUrl?: string;
  representation?: "observed_thumbnail";
  body: ArrayBuffer | Uint8Array;
  declaredContentType?: string | null;
  acquisitionMethod: ImageArchiveAcquisitionMethod;
  maxBytes?: number;
  allowDeclaredContentTypeMismatch?: boolean;
  expectedContentHash?: string | null;
  expectedByteLength?: number | null;
}

export interface PrimaryImageArchiveTarget {
  readonly imageUrl: string;
  readonly canonicalSourceUrl?: string;
  readonly representation?: "observed_thumbnail";
}

/**
 * Uses only a thumbnail already normalized by the source adapter, and only
 * after the canonical representation proved unavailable or too large. The
 * canonical source URL remains attached to the archived thumbnail bytes.
 */
export function selectPrimaryImageArchiveTarget(input: {
  sourceUrl: string;
  thumbnailUrl: string | null;
  previousDownloadErrorCode: string | null | undefined;
}): PrimaryImageArchiveTarget {
  const useObservedThumbnail =
    input.previousDownloadErrorCode === "image_too_large" ||
    input.previousDownloadErrorCode === "image_http_404" ||
    input.previousDownloadErrorCode === "direct_too_large" ||
    input.previousDownloadErrorCode === "direct_http_404";
  if (
    !useObservedThumbnail ||
    !input.thumbnailUrl ||
    input.thumbnailUrl === input.sourceUrl
  ) {
    return { imageUrl: input.sourceUrl };
  }
  return {
    imageUrl: input.thumbnailUrl,
    canonicalSourceUrl: input.sourceUrl,
    representation: "observed_thumbnail",
  };
}

/**
 * Returns true only when one exact direct acquisition has exhausted every
 * representation authorized by the stored source evidence. Access and
 * transport failures remain outside this listing-local terminal boundary.
 */
export function primaryImageFailureExhaustsArchiveTargets(input: {
  sourceUrl: string;
  thumbnailUrl: string | null;
  attemptedRepresentation: "canonical" | "observed_thumbnail";
  errorCode: string;
}): boolean {
  if (input.errorCode !== "direct_http_404" && input.errorCode !== "direct_too_large") {
    return false;
  }
  if (input.attemptedRepresentation === "observed_thumbnail") return true;
  const next = selectPrimaryImageArchiveTarget({
    sourceUrl: input.sourceUrl,
    thumbnailUrl: input.thumbnailUrl,
    previousDownloadErrorCode: input.errorCode,
  });
  return next.representation !== "observed_thumbnail";
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function safeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: (bytes[offset + 5] << 8) + bytes[offset + 6],
          width: (bytes[offset + 7] << 8) + bytes[offset + 8],
        };
      }
      offset += 2 + length;
    }
  }

  return null;
}

export function detectImageContentType(bytes: Uint8Array): string | null {
  for (const contentType of Object.keys(CONTENT_TYPE_EXTENSIONS)) {
    if (hasImageSignature(bytes, contentType)) return contentType;
  }
  return null;
}

function normalizedContentType(value: string | null | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized || null;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

export async function archiveImageBytes(input: ArchiveImageBytesInput): Promise<ArchivedImage> {
  const validated = await validateImageBytes({
    body: input.body,
    declaredContentType: input.declaredContentType,
    maxBytes: input.maxBytes,
    allowDeclaredContentTypeMismatch: input.allowDeclaredContentTypeMismatch,
    expectedContentHash: input.expectedContentHash,
    expectedByteLength: input.expectedByteLength,
  });
  const storageKey = legacyStorageKey(
    input.source,
    input.sourceListingId,
    validated.objectKey,
  );
  await storeValidatedImageBytes({
    storage: input.storage,
    source: input.source,
    sourceListingId: input.sourceListingId,
    sourceUrl: input.sourceUrl,
    canonicalSourceUrl: input.canonicalSourceUrl,
    representation: input.representation,
    acquisitionMethod: input.acquisitionMethod,
    declaredContentType: input.declaredContentType,
    validated,
    storageKey,
  });
  return archivedImage(input.sourceUrl, {
    ...validated,
    objectKey: storageKey,
  });
}

function legacyStorageKey(
  source: string,
  sourceListingId: string,
  contentAddressedKey: string,
): string {
  return [
    "images",
    safeSegment(source),
    safeSegment(sourceListingId),
    contentAddressedKey.slice(contentAddressedKey.lastIndexOf("/") + 1),
  ].join("/");
}

export async function validateImageBytes(input: {
  readonly body: ArrayBuffer | Uint8Array;
  readonly declaredContentType?: string | null;
  readonly maxBytes?: number;
  readonly allowDeclaredContentTypeMismatch?: boolean;
  readonly expectedContentHash?: string | null;
  readonly expectedByteLength?: number | null;
}): Promise<ValidatedImageBytes> {
  const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
  const bytes = input.body instanceof Uint8Array
    ? input.body
    : new Uint8Array(input.body);
  if (bytes.byteLength < 1) throw new Error("Image body is empty");
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Image exceeds the ${maxBytes}-byte archive limit`);
  }

  if (
    input.expectedByteLength != null &&
    input.expectedByteLength !== bytes.byteLength
  ) {
    throw new Error("Image byte length did not match the expected validated length");
  }

  const declaredContentType = normalizedContentType(input.declaredContentType);
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    if (declaredContentType && declaredContentType !== "application/octet-stream") {
      throw new Error(`Image bytes did not match ${declaredContentType}`);
    }
    throw new Error("Image bytes did not match a supported image type");
  }
  if (
    declaredContentType &&
    declaredContentType !== "application/octet-stream" &&
    declaredContentType !== contentType &&
    input.allowDeclaredContentTypeMismatch !== true
  ) {
    throw new Error(
      `Image bytes did not match ${declaredContentType} (detected ${contentType})`,
    );
  }

  const body = exactArrayBuffer(bytes);
  const sha256 = await sha256Hex(body);
  const contentHash = `sha256:${sha256}` as const;
  if (input.expectedContentHash != null && input.expectedContentHash !== contentHash) {
    throw new Error("Image content hash did not match the expected validated hash");
  }
  const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? "img";
  const objectKey = `images/content/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
  const dimensions = readImageDimensions(bytes);

  return Object.freeze({
    body,
    sha256,
    contentHash,
    byteSize: bytes.byteLength,
    contentType,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    objectKey,
  });
}

export async function storeValidatedImageBytes(input: {
  readonly storage: R2Bucket;
  readonly source: string;
  readonly sourceListingId: string;
  readonly sourceUrl: string;
  readonly canonicalSourceUrl?: string;
  readonly representation?: "observed_thumbnail";
  readonly acquisitionMethod: ImageArchiveAcquisitionMethod;
  readonly declaredContentType?: string | null;
  readonly validated: ValidatedImageBytes;
  readonly storageKey?: string;
  readonly includeSourceMetadata?: boolean;
}): Promise<void> {
  const declaredContentType = normalizedContentType(input.declaredContentType);
  await input.storage.put(input.storageKey ?? input.validated.objectKey, input.validated.body, {
    httpMetadata: { contentType: input.validated.contentType },
    customMetadata: {
      ...(input.includeSourceMetadata === false
        ? {}
        : {
            sourceUrl: input.sourceUrl,
            ...(input.canonicalSourceUrl
              ? { canonicalSourceUrl: input.canonicalSourceUrl }
              : {}),
            ...(input.representation
              ? { representation: input.representation }
              : {}),
            source: input.source,
            sourceListingId: input.sourceListingId,
          }),
      sha256: input.validated.sha256,
      acquisitionMethod: input.acquisitionMethod,
      ...(declaredContentType ? { declaredContentType } : {}),
      detectedContentType: input.validated.contentType,
    },
  });
}

function archivedImage(
  sourceUrl: string,
  validated: ValidatedImageBytes,
): ArchivedImage {
  return {
    sourceUrl,
    objectKey: validated.objectKey,
    sha256: validated.sha256,
    byteSize: validated.byteSize,
    contentType: validated.contentType,
    width: validated.width,
    height: validated.height,
  };
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  abort: AbortController,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (byteLength + value.byteLength > maxBytes) {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        throw new Error(`Primary image exceeds the ${maxBytes}-byte archive limit`);
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function archivePrimaryImage(input: ArchivePrimaryImageInput): Promise<ArchivedImage> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const originalUrl = new URL(input.imageUrl);
    if (
      originalUrl.protocol !== "https:" ||
      originalUrl.username ||
      originalUrl.password ||
      originalUrl.port ||
      originalUrl.hash
    ) {
      throw new Error(
        "Primary image URL must use HTTPS with the default authority and no fragment",
      );
    }
    const approvedInitialHosts = input.allowedHosts?.map((host) => host.toLowerCase());
    if (
      approvedInitialHosts &&
      !approvedInitialHosts.includes(originalUrl.hostname.toLowerCase())
    ) {
      throw new Error(`Primary image host ${originalUrl.hostname} is not approved`);
    }
    const allowedHosts = new Set([
      originalUrl.hostname.toLowerCase(),
      ...(input.allowedRedirectHosts ?? []).map((host) => host.toLowerCase()),
    ]);
    const maxRedirects = input.maxRedirects ?? 1;
    let currentUrl = originalUrl;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      let result: ImageRequestResult;
      try {
        result = await executeImageRequest(input, currentUrl, abort, async (response) => {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            return {
              kind: "redirect" as const,
              location: response.headers.get("location"),
            };
          }
          if (!response.ok) {
            throw new Error(`Primary image download failed with HTTP ${response.status}`);
          }

          const contentType = normalizedContentType(response.headers.get("content-type")) ??
            "application/octet-stream";
          if (
            contentType !== "application/octet-stream" &&
            !(contentType in CONTENT_TYPE_EXTENSIONS)
          ) {
            throw new Error(`Primary image response used unsupported type ${contentType}`);
          }

          const advertisedLength = Number.parseInt(
            response.headers.get("content-length") ?? "",
            10,
          );
          if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
            throw new Error(`Primary image exceeds the ${maxBytes}-byte archive limit`);
          }

          return {
            kind: "image" as const,
            contentType,
            body: await readBoundedResponseBody(response, maxBytes, abort),
          };
        });
      } catch (error) {
        if (redirectCount > 0) {
          throw new Error("Primary image redirected request failed");
        }
        throw error;
      }

      if (result.kind === "image") {
        return archiveImageBytes({
          storage: input.storage,
          source: input.source,
          sourceListingId: input.sourceListingId,
          sourceUrl: input.imageUrl,
          canonicalSourceUrl: input.canonicalSourceUrl,
          representation: input.representation,
          body: result.body,
          declaredContentType: result.contentType,
          acquisitionMethod: "direct",
          maxBytes,
          allowDeclaredContentTypeMismatch:
            input.allowDeclaredContentTypeMismatch,
        });
      }
      if (redirectCount >= maxRedirects) {
        throw new Error(`Primary image exceeded the ${maxRedirects}-redirect limit`);
      }
      const location = result.location;
      if (!location) throw new Error("Primary image redirect omitted Location");
      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new Error("Primary image redirect Location was invalid");
      }
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.port ||
        target.hash
      ) {
        throw new Error(
          "Primary image redirect must use HTTPS with the default authority and no fragment",
        );
      }
      const targetHost = target.hostname.toLowerCase();
      const configuredRedirectRules = input.allowedRedirectRules;
      const hostHasPathRule = configuredRedirectRules?.some(
        (rule) => rule.host.trim().toLowerCase() === targetHost,
      ) ?? false;
      const matchesPathRule = configuredRedirectRules?.some((rule) =>
        rule.pathPrefix.startsWith("/") &&
        rule.host.trim().toLowerCase() === targetHost &&
        target.pathname.startsWith(rule.pathPrefix)
      ) ?? false;
      const redirectApproved = configuredRedirectRules === undefined
        ? allowedHosts.has(targetHost)
        : matchesPathRule;
      if (!redirectApproved) {
        if (hostHasPathRule) {
          throw new Error(`Primary image redirect path is not approved for host ${target.hostname}`);
        }
        throw new Error(`Primary image redirect to unapproved host ${target.hostname || "unknown"}`);
      }
      currentUrl = target;
    }
    throw new Error("Primary image request did not return a response");
  } finally {
    clearTimeout(timer);
  }
}

type ImageRequestResult =
  | { readonly kind: "redirect"; readonly location: string | null }
  | {
      readonly kind: "image";
      readonly contentType: string;
      readonly body: Uint8Array;
    };

async function executeImageRequest<T>(
  input: ArchivePrimaryImageInput,
  url: URL,
  abort: AbortController,
  handle: (response: Response) => Promise<T>,
): Promise<T> {
  if (input.requestExecutor) {
    return input.requestExecutor(url, handle);
  }

  const response = await (input.fetchImpl ?? fetch)(url, {
    signal: abort.signal,
    redirect: "manual",
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
      "user-agent": "auction-discovery/0.1 (local image archive)",
    },
  });
  try {
    return await handle(response);
  } finally {
    cancelResponseBody(response);
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A consumed or locked body no longer needs cancellation.
  }
}

function hasImageSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (contentType === "image/gif") {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  if (contentType === "image/webp") {
    return bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }
  if (contentType === "image/avif") {
    if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return false;
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    return brand === "avif" || brand === "avis";
  }
  return false;
}
