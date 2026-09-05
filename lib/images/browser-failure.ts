import { HttpError } from "../http";

export const browserImageFailureCodes = [
  "browser_http_403",
  "browser_http_401",
  "browser_no_match",
  "browser_network_failed",
  "browser_timeout",
  "browser_response_body_unavailable",
  "browser_too_large",
  "browser_contract_mismatch",
] as const;

export type BrowserImageFailureCode = typeof browserImageFailureCodes[number];

export const directImageFailureCodes = [
  "direct_http_401",
  "direct_http_403",
  "direct_http_404",
  "direct_http_429",
  "direct_http_error",
  "direct_network_failed",
  "direct_timeout",
  "direct_too_large",
  "direct_unsupported_type",
  "direct_signature_mismatch",
  "direct_contract_mismatch",
] as const;

export type DirectImageFailureCode = typeof directImageFailureCodes[number];


const browserImageFailureCodeSet = new Set<string>(browserImageFailureCodes);
const directImageFailureCodeSet = new Set<string>(directImageFailureCodes);
const allowedPayloadKeys = new Set([
  "acquisitionMethod",
  "errorCode",
  "message",
]);

export interface BrowserImageFailurePayload {
  acquisitionMethod: "browser";
  errorCode: BrowserImageFailureCode;
  message: string;
}


export interface DirectImageFailurePayload {
  acquisitionMethod: "direct";
  errorCode: DirectImageFailureCode;
  message: string;
}

export type ImageAcquisitionFailurePayload =
  | BrowserImageFailurePayload
  | DirectImageFailurePayload;

export function parseImageAcquisitionFailurePayload(
  value: unknown,
): ImageAcquisitionFailurePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      "Image acquisition failure payload must be an object",
      400,
      "invalid_failure_payload",
    );
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !allowedPayloadKeys.has(key))) {
    throw new HttpError(
      "Image acquisition failure payload contains an unsupported field",
      400,
      "invalid_failure_payload",
    );
  }
  const isBrowser = payload.acquisitionMethod === "browser";
  const isDirect = payload.acquisitionMethod === "direct";
  if (!isBrowser && !isDirect) {
    throw new HttpError(
      "acquisitionMethod must be browser or direct",
      400,
      "invalid_acquisition_method",
    );
  }
  const allowedCodes = isBrowser
    ? browserImageFailureCodeSet
    : directImageFailureCodeSet;
  if (
    typeof payload.errorCode !== "string" ||
    !allowedCodes.has(payload.errorCode)
  ) {
    throw new HttpError(
      "Image acquisition failure code is not supported for this method",
      400,
      "invalid_failure_code",
    );
  }
  if (typeof payload.message !== "string") {
    throw new HttpError(
      "Image acquisition failure message must be text",
      400,
      "invalid_failure_message",
    );
  }
  const message = payload.message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (!message) {
    throw new HttpError(
      "Image acquisition failure message must not be empty",
      400,
      "invalid_failure_message",
    );
  }

  return isBrowser
    ? {
        acquisitionMethod: "browser",
        errorCode: payload.errorCode as BrowserImageFailureCode,
        message,
      }
    : {
        acquisitionMethod: "direct",
        errorCode: payload.errorCode as DirectImageFailureCode,
        message,
      };
}

export function parseBrowserImageFailurePayload(
  value: unknown,
): BrowserImageFailurePayload {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).acquisitionMethod !== "browser"
  ) {
    throw new HttpError(
      "acquisitionMethod must be browser",
      400,
      "invalid_acquisition_method",
    );
  }
  const parsed = parseImageAcquisitionFailurePayload(value);
  if (parsed.acquisitionMethod !== "browser") {
    throw new HttpError(
      "acquisitionMethod must be browser",
      400,
      "invalid_acquisition_method",
    );
  }
  return parsed;
}
