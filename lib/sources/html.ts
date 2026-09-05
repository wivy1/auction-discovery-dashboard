import { parseHTML } from "linkedom/worker";
import type { NormalizedListingStub } from "../domain/listings";
import { createGenericSource, type GenericListingFacts, type GenericMappingContext, type GenericSourceOptions } from "./generic";
import { SourceAdapterError, type SourceAdapter, type SourcePage } from "./types";

export type SourceHtmlElement = NonNullable<ReturnType<ReturnType<typeof parseHTML>["document"]["querySelector"]>>;

export interface HtmlSourceOptions extends GenericSourceOptions {
  readonly browser?: { readonly readySelector: string };
  readonly inventorySelector: string;
  /** Evaluated inside the one inventory container. */
  readonly listingSelector: string;
  /** Source-owned marker inside the inventory container proving zero listings. */
  readonly emptySelector: string;
  readonly mapListing: (element: SourceHtmlElement, context: GenericMappingContext) => GenericListingFacts;
  readonly detail?: {
    readonly url?: (stub: NormalizedListingStub) => string;
    readonly selector: string;
    readonly mapListing: HtmlSourceOptions["mapListing"];
  };
}

export function createHtmlSource(options: HtmlSourceOptions): SourceAdapter {
  return createHtmlAdapter(options, "direct");
}

/** The companion must acquire ordinary rendered HTML using a headless browser. */
export function createHeadlessBrowserSource(options: HtmlSourceOptions): SourceAdapter {
  if (options.inlineDetails !== true || options.detail) {
    throw new TypeError("The generic browser executor requires complete inline details and does not acquire separate detail pages.");
  }
  const readySelector = options.browser?.readySelector ?? options.inventorySelector;
  if (typeof readySelector !== "string" || !readySelector.trim()) throw new TypeError("A browser readiness selector is required.");
  return Object.freeze({ ...createHtmlAdapter(options, "isolated_browser"), browser: Object.freeze({ readySelector }) });
}

function createHtmlAdapter(options: HtmlSourceOptions, acquisition: "direct" | "isolated_browser"): SourceAdapter {
  for (const selector of [options.inventorySelector, options.listingSelector, options.emptySelector, options.detail?.selector]) {
    if (selector !== undefined && (typeof selector !== "string" || !selector.trim())) {
      throw new TypeError("HTML source selectors must be nonempty strings.");
    }
  }
  const document = (page: SourcePage) => parseHTML(page.body).document;
  const one = (elements: ArrayLike<SourceHtmlElement>, role: string): SourceHtmlElement => {
    if (elements.length !== 1) throw new SourceAdapterError(options.id, `HTML ${role} must match exactly one element.`);
    return elements[0]!;
  };
  return createGenericSource(options, "html", acquisition, {
    parseInventory: (page, context) => {
      const container = one(document(page).querySelectorAll(options.inventorySelector), "inventory container");
      const rows = [...container.querySelectorAll(options.listingSelector)];
      const empty = container.querySelector(options.emptySelector) !== null;
      if (rows.length === 0 && !empty) throw new SourceAdapterError(options.id, "HTML has neither listings nor the explicit empty-inventory marker.");
      if (rows.length > 0 && empty) throw new SourceAdapterError(options.id, "HTML contains contradictory listing and empty-inventory evidence.");
      if (rows.length > (options.maximumListings ?? 1_000)) throw new SourceAdapterError(options.id, "HTML inventory exceeds its listing ceiling.");
      return rows.map((row) => options.mapListing(row, context));
    },
    ...(options.detail ? {
      detail: {
        url: options.detail.url,
        parse: (page, context) => options.detail!.mapListing(one(document(page).querySelectorAll(options.detail!.selector), "detail container"), context),
      },
    } : {}),
  });
}
