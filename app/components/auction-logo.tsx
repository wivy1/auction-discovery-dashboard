"use client";

import { useId } from "react";
import { DEFAULT_ACCENT_COLOR } from "./accent-theme";

const DEFAULT_FAVICON_ACCENT = DEFAULT_ACCENT_COLOR;
const DEFAULT_FAVICON_FOREGROUND = "#ffffff";

export const AUCTION_LOGO_OUTER_A_PATH =
  "M7.9 54.7 25.3 7.2C25.7 6.1 26.8 5.4 28 5.4h8c1.2 0 2.3.7 2.7 1.8l17.4 47.5c.5 1.4-.5 2.8-2 2.8H10c-1.6 0-2.6-1.4-2.1-2.8Z";
export const AUCTION_LOGO_APERTURE_PATH = "M32 15.5 48.1 57H15.9Z";
export const AUCTION_LOGO_HANDLE_PATH = "M38.6 47.1 46.1 55.5";
export const AUCTION_LOGO_LEFT_TRACE_X = 15.74;
export const AUCTION_LOGO_RIGHT_TRACE_X = 48.26;
export const AUCTION_LOGO_TRACE_TERMINAL_Y = 45.7;
export const AUCTION_LOGO_LEFT_TRACE_PATH = "M12.9 57 15.74 46.8";
export const AUCTION_LOGO_RIGHT_TRACE_PATH = "M51.1 57 48.26 46.8";

function safeFaviconColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
}

function auctionLogoMask(maskId: string): string {
  return `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#000000"/><path d="${AUCTION_LOGO_OUTER_A_PATH}" fill="#ffffff"/><path d="${AUCTION_LOGO_APERTURE_PATH}" fill="#000000"/><path d="${AUCTION_LOGO_HANDLE_PATH}" fill="none" stroke="#ffffff" stroke-width="4.6" stroke-linecap="round"/><circle cx="32" cy="39.7" r="9.6" fill="#ffffff"/><circle cx="32" cy="39.7" r="5.1" fill="#000000"/><path d="${AUCTION_LOGO_LEFT_TRACE_PATH}" fill="none" stroke="#000000" stroke-width="2.4" stroke-linecap="round"/><circle cx="${AUCTION_LOGO_LEFT_TRACE_X}" cy="${AUCTION_LOGO_TRACE_TERMINAL_Y}" r="2.5" fill="#000000"/><path d="${AUCTION_LOGO_RIGHT_TRACE_PATH}" fill="none" stroke="#000000" stroke-width="2.4" stroke-linecap="round"/><circle cx="${AUCTION_LOGO_RIGHT_TRACE_X}" cy="${AUCTION_LOGO_TRACE_TERMINAL_Y}" r="2.5" fill="#000000"/></mask>`;
}

export function createAuctionFaviconSvg(
  accentColor: string,
  foregroundColor: string,
): string {
  const accent = safeFaviconColor(accentColor, DEFAULT_FAVICON_ACCENT);
  const foreground = safeFaviconColor(foregroundColor, DEFAULT_FAVICON_FOREGROUND);
  const maskId = "auction-discovery-favicon-mask";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${auctionLogoMask(maskId)}<rect width="64" height="64" rx="14" fill="${accent}"/><rect width="64" height="64" fill="${foreground}" mask="url(#${maskId})"/></svg>`;
}

export function createAuctionFaviconHref(
  accentColor: string,
  foregroundColor: string,
): string {
  return `data:image/svg+xml,${encodeURIComponent(
    createAuctionFaviconSvg(accentColor, foregroundColor),
  )}`;
}

export function AuctionLogo({ className }: { className?: string }) {
  const maskId = `auction-logo-${useId().replaceAll(":", "")}`;
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="64"
        height="64"
      >
        <rect width="64" height="64" fill="#000000" />
        <path d={AUCTION_LOGO_OUTER_A_PATH} fill="#ffffff" />
        <path d={AUCTION_LOGO_APERTURE_PATH} fill="#000000" />
        <path
          d={AUCTION_LOGO_HANDLE_PATH}
          stroke="#ffffff"
          strokeWidth="4.6"
          strokeLinecap="round"
        />
        <circle cx="32" cy="39.7" r="9.6" fill="#ffffff" />
        <circle cx="32" cy="39.7" r="5.1" fill="#000000" />
        <path
          d={AUCTION_LOGO_LEFT_TRACE_PATH}
          stroke="#000000"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle
          cx={AUCTION_LOGO_LEFT_TRACE_X}
          cy={AUCTION_LOGO_TRACE_TERMINAL_Y}
          r="2.5"
          fill="#000000"
        />
        <path
          d={AUCTION_LOGO_RIGHT_TRACE_PATH}
          stroke="#000000"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle
          cx={AUCTION_LOGO_RIGHT_TRACE_X}
          cy={AUCTION_LOGO_TRACE_TERMINAL_Y}
          r="2.5"
          fill="#000000"
        />
      </mask>
      <rect width="64" height="64" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
