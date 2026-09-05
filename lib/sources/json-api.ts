import type { NormalizedListingStub } from "../domain/listings";
import { createGenericSource, type GenericListingFacts, type GenericMappingContext, type GenericSourceOptions } from "./generic";
import { SourceAdapterError, type SourceAdapter } from "./types";

export type JsonFieldPath = readonly (string | number)[];
export interface JsonApiSourceOptions extends GenericSourceOptions {
  /** Omit for a top-level array. Missing/non-array data is a failure, never empty inventory. */
  readonly itemsPath?: JsonFieldPath;
  /** When present, must equal the raw array length, including ended records. */
  readonly totalPath?: JsonFieldPath;
  readonly mapListing: (item: Readonly<Record<string, unknown>>, context: GenericMappingContext) => GenericListingFacts;
  readonly detail?: {
    readonly url?: (stub: NormalizedListingStub) => string;
    readonly itemPath?: JsonFieldPath;
    readonly mapListing: JsonApiSourceOptions["mapListing"];
  };
}

export function createJsonApiSource(options: JsonApiSourceOptions): SourceAdapter {
  const parse = (body: string): unknown => {
    try { return JSON.parse(body) as unknown; }
    catch { throw new SourceAdapterError(options.id, "Source returned malformed JSON."); }
  };
  return createGenericSource(options, "json_api", "direct", {
    parseInventory: (page, context) => {
      const value = parse(page.body);
      const rows = readJsonField(value, options.itemsPath ?? []);
      if (!Array.isArray(rows)) throw new SourceAdapterError(options.id, "Inventory JSON does not contain the configured array.");
      if (options.totalPath) {
        const total = readJsonField(value, options.totalPath);
        if (!Number.isSafeInteger(total) || total !== rows.length) {
          throw new SourceAdapterError(options.id, "Inventory JSON total does not prove a complete document.");
        }
      }
      if (rows.length > (options.maximumListings ?? 1_000)) throw new SourceAdapterError(options.id, "Inventory JSON exceeds its listing ceiling.");
      return rows.map((row) => options.mapListing(record(row, options.id), context));
    },
    ...(options.detail ? {
      detail: {
        url: options.detail.url,
        parse: (page, context) => options.detail!.mapListing(record(readJsonField(parse(page.body), options.detail!.itemPath ?? []), options.id), context),
      },
    } : {}),
  });
}

export function readJsonField(value: unknown, path: JsonFieldPath): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function record(value: unknown, sourceId: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceAdapterError(sourceId, "A listing JSON value must be an object.");
  }
  return value as Record<string, unknown>;
}
