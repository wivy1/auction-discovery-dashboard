import { stableContentHash } from "./parsing";
import { createHash } from "node:crypto";
import type {
  SourceInventoryPageRequest,
  SourceInventoryPublisherLeadEvidenceInput,
  SourcePage,
  SourcePublisherEventLeadEvidence,
} from "./types";

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function observationTime(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 ||
    !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Publisher lead evidence lacks an exact source observation");
  }
  return new Date(value).toISOString();
}

export function normalizePublisherEventLeadEvidence(value: unknown): SourcePublisherEventLeadEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Publisher lead evidence has an invalid source-fact shape");
  }
  const record = value as Record<string, unknown>;
  const addressKind = record.kind === "unresolved_address_v1";
  const outboundKind = record.kind === "unresolved_outbound_v1";
  const sharedKind = record.kind === "shared_outbound_v1";
  if ((!addressKind && !outboundKind && !sharedKind) ||
    !exactKeys(record, ["kind", "publisherHost", "eventId", "canonicalUrl", addressKind ? "addressStatus" : "outboundStatus", "root", "event", ...(sharedKind ? ["peer"] : [])]) ||
    (addressKind ? record.addressStatus : record.outboundStatus) !== "unresolved" ||
    typeof record.publisherHost !== "string" || typeof record.eventId !== "string" ||
    typeof record.canonicalUrl !== "string" ||
    !exactKeys(record.root, addressKind ? ["url", "bodyHash", "fetchedAt", "inlineAddress", "renderedAddressText"] : ["url", "bodyHash", "fetchedAt"]) ||
    !exactKeys(record.event, addressKind ? ["bodyHash", "fetchedAt", "inlineAddress", "renderedAddressText"] : sharedKind ? ["bodyHash", "fetchedAt", "outboundTargetHash"] : ["bodyHash", "fetchedAt", "outbound"])) {
    throw new TypeError("Publisher lead evidence has an invalid source-fact shape");
  }
  const root = record.root;
  const event = record.event;
  const host = record.publisherHost;
  if (host.length < 1 || host.length > 253 || host !== host.trim().toLowerCase() ||
    record.eventId.length < 1 || record.eventId.length > 512 || record.eventId !== record.eventId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(record.eventId) || typeof root.url !== "string") {
    throw new TypeError("Publisher lead evidence has invalid publisher identity");
  }
  const canonicalUrl = (raw: string): string => {
    if (raw.length > 2048) throw new TypeError("Publisher lead evidence has an invalid first-party URL");
    let parsed: URL;
    try { parsed = new URL(raw); } catch {
      throw new TypeError("Publisher lead evidence has an invalid first-party URL");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== host || parsed.host !== host ||
      parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
      parsed.href !== raw) {
      throw new TypeError("Publisher lead evidence has an invalid first-party URL");
    }
    return raw;
  };
  const fact = (entry: Record<string, unknown>) => {
    if (typeof entry.bodyHash !== "string" || !/^fnv1a64:[0-9a-f]{16}$/u.test(entry.bodyHash)) {
      throw new TypeError("Publisher lead evidence lacks an exact source observation");
    }
    return { bodyHash: entry.bodyHash, fetchedAt: observationTime(entry.fetchedAt) };
  };
  const rootFact = fact(root);
  const eventFact = fact(event);
  if (Date.parse(eventFact.fetchedAt) < Date.parse(rootFact.fetchedAt)) {
    throw new TypeError("Publisher lead event observation precedes its root");
  }
  const common = { publisherHost: host, eventId: record.eventId, canonicalUrl: canonicalUrl(record.canonicalUrl) };
  const rootUrl = canonicalUrl(root.url);
  if (addressKind) {
    if (typeof root.renderedAddressText !== "string" || root.renderedAddressText.length < 1 || root.renderedAddressText.length > 1000 ||
      root.renderedAddressText !== root.renderedAddressText.trim() || root.inlineAddress !== null ||
      event.inlineAddress !== null || event.renderedAddressText !== null) {
      throw new TypeError("Publisher lead evidence has invalid unresolved address facts");
    }
    return Object.freeze({
      kind: "unresolved_address_v1", ...common, addressStatus: "unresolved",
      root: Object.freeze({ url: rootUrl, ...rootFact, inlineAddress: null, renderedAddressText: root.renderedAddressText }),
      event: Object.freeze({ ...eventFact, inlineAddress: null, renderedAddressText: null }),
    });
  }
  if (sharedKind) {
    const peer = record.peer;
    if (typeof event.outboundTargetHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(event.outboundTargetHash) ||
      !exactKeys(peer, ["eventId", "canonicalUrlHash"]) || typeof peer.eventId !== "string" ||
      peer.eventId.length < 1 || peer.eventId.length > 512 || peer.eventId !== peer.eventId.trim() ||
      /[\u0000-\u001f\u007f]/u.test(peer.eventId) || peer.eventId === common.eventId ||
      typeof peer.canonicalUrlHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(peer.canonicalUrlHash)) {
      throw new TypeError("Publisher lead evidence has invalid shared outbound facts");
    }
    return Object.freeze({
      kind: "shared_outbound_v1", ...common, outboundStatus: "unresolved",
      root: Object.freeze({ url: rootUrl, ...rootFact }),
      event: Object.freeze({ ...eventFact, outboundTargetHash: event.outboundTargetHash }),
      peer: Object.freeze({ eventId: peer.eventId, canonicalUrlHash: peer.canonicalUrlHash }),
    });
  }
  const outbound = event.outbound;
  if (!exactKeys(outbound, ["hrefHash", "https", "externalToPublisher", "queryPresent", "fragmentPresent", "credentialsPresent", "portPresent", "signedQueryKeyPresent"]) ||
    typeof outbound.hrefHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(outbound.hrefHash) ||
    outbound.https !== true || outbound.externalToPublisher !== true || outbound.queryPresent !== true || outbound.fragmentPresent !== true ||
    outbound.credentialsPresent !== false || outbound.portPresent !== false || outbound.signedQueryKeyPresent !== false) {
    throw new TypeError("Publisher lead evidence has invalid opaque outbound facts");
  }
  return Object.freeze({
    kind: "unresolved_outbound_v1", ...common, outboundStatus: "unresolved",
    root: Object.freeze({ url: rootUrl, ...rootFact }),
    event: Object.freeze({ ...eventFact, outbound: Object.freeze({
      hrefHash: outbound.hrefHash, https: true, externalToPublisher: true,
      queryPresent: true, fragmentPresent: true, credentialsPresent: false, portPresent: false, signedQueryKeyPresent: false,
    }) }),
  });
}

export function normalizePublisherLeadEvidenceEntries(
  value: unknown,
): readonly SourceInventoryPublisherLeadEvidenceInput[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError("Publisher lead evidence must contain at most twenty events");
  }
  const pageKeys = new Set<string>();
  const eventKeys = new Set<string>();
  const eventUrls = new Set<string>();
  const entries = value.map((entry: unknown) => {
    if (!exactKeys(entry, ["pageKey", "evidence"]) || typeof entry.pageKey !== "string" ||
      entry.pageKey.length < 1 || entry.pageKey.length > 1024 || entry.pageKey !== entry.pageKey.trim() ||
      /[\u0000-\u001f\u007f]/u.test(entry.pageKey)) {
      throw new TypeError("Publisher lead evidence has an invalid page binding");
    }
    const evidence = normalizePublisherEventLeadEvidence(entry.evidence);
    const eventKey = `${evidence.publisherHost}\u0000${evidence.eventId}`;
    if (pageKeys.has(entry.pageKey) || eventKeys.has(eventKey) || eventUrls.has(evidence.canonicalUrl)) {
      throw new TypeError("Publisher lead evidence repeats an event or page");
    }
    pageKeys.add(entry.pageKey);
    eventKeys.add(eventKey);
    eventUrls.add(evidence.canonicalUrl);
    return Object.freeze({ pageKey: entry.pageKey, evidence });
  });
  for (const { evidence } of entries) {
    if (evidence.kind !== "shared_outbound_v1") continue;
    const group = entries.map(entry => entry.evidence).filter(candidate =>
      candidate.kind === "shared_outbound_v1" && candidate.publisherHost === evidence.publisherHost &&
      candidate.event.outboundTargetHash === evidence.event.outboundTargetHash);
    const peer = group.find(candidate => candidate.eventId === evidence.peer.eventId);
    if (group.length !== 2 || peer?.kind !== "shared_outbound_v1" || peer.peer.eventId !== evidence.eventId ||
      peer.root.url !== evidence.root.url || peer.root.bodyHash !== evidence.root.bodyHash || peer.root.fetchedAt !== evidence.root.fetchedAt ||
      evidence.peer.canonicalUrlHash !== `sha256:${createHash("sha256").update(peer.canonicalUrl).digest("hex")}` ||
      peer.peer.canonicalUrlHash !== `sha256:${createHash("sha256").update(evidence.canonicalUrl).digest("hex")}`) {
      throw new TypeError("Publisher shared outbound evidence requires one reciprocal pair from the same root");
    }
  }
  return Object.freeze(entries.sort((left, right) => left.pageKey.localeCompare(right.pageKey)));
}

/** Bind parsed facts to completed zero-row pages and the actual source captures. */
export function bindPublisherLeadEvidence(input: {
  readonly entries: readonly SourceInventoryPublisherLeadEvidenceInput[];
  readonly plannedPages: readonly SourceInventoryPageRequest[];
  readonly pages: readonly SourcePage[];
  readonly roots: readonly SourcePage[];
  readonly pageRowCounts: ReadonlyMap<string, number>;
}): readonly SourceInventoryPublisherLeadEvidenceInput[] {
  const entries = normalizePublisherLeadEvidenceEntries(input.entries);
  for (const { pageKey, evidence } of entries) {
    const indexes = input.plannedPages.flatMap((page, index) => page.key === pageKey ? [index] : []);
    const index = indexes[0];
    const planned = index === undefined ? undefined : input.plannedPages[index];
    const page = index === undefined ? undefined : input.pages[index];
    if (indexes.length !== 1 || !planned || !page || planned.inventoryMember || planned.reviewCandidate ||
      planned.minimumListings !== 0 || planned.maximumListings !== 0 || input.pageRowCounts.get(pageKey) !== 0 ||
      planned.request.url !== evidence.canonicalUrl || page.url !== evidence.canonicalUrl ||
      stableContentHash(page.body) !== evidence.event.bodyHash ||
      observationTime(page.fetchedAt) !== evidence.event.fetchedAt ||
      !input.roots.some(root => root.url === evidence.root.url &&
        stableContentHash(root.body) === evidence.root.bodyHash &&
        observationTime(root.fetchedAt) === evidence.root.fetchedAt)) {
      throw new TypeError("Publisher lead evidence requires an exact completed zero-row source capture");
    }
  }
  return entries;
}
