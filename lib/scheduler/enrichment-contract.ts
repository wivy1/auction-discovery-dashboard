/**
 * A queue-backed enrichment session keeps one model residency across at most
 * 100 listings. Production evidence puts a complete session near 40 minutes;
 * one hour retains cold-start/failure headroom without reserving most of the
 * five-hour discovery workflow for a single callback.
 */
export const ENRICHMENT_CALLBACK_TIMEOUT_MS = 60 * 60_000;
