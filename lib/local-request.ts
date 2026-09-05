import { HttpError } from "./http";

export const BROWSER_IMAGE_CLIENT_HEADER = "x-auction-discovery-image-client";
export const BROWSER_IMAGE_CLIENT_ID = "browser-sidecar-v1";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1";
}

export function assertLoopbackRequest(request: Request, capability: string): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new HttpError(`${capability} requires a local URL`, 403, "local_only");
  }

  if (!isLoopbackHostname(url.hostname)) {
    throw new HttpError(
      `${capability} is available only through localhost`,
      403,
      "local_only",
    );
  }
}

/**
 * The browser acquisition API is deliberately unavailable through non-local
 * hostnames and requires an explicit project-sidecar marker. It grants no
 * capability to fetch arbitrary URLs; it only gates local queue and upload
 * requests.
 */
export function assertLocalImageClient(request: Request): void {
  assertLoopbackRequest(request, "Image acquisition");
  if (request.headers.get(BROWSER_IMAGE_CLIENT_HEADER) !== BROWSER_IMAGE_CLIENT_ID) {
    throw new HttpError(
      "Image acquisition client marker is missing or invalid",
      403,
      "invalid_image_client",
    );
  }
}
