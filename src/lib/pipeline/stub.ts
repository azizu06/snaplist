import { computeConfidence, type ConfidenceSignals } from "../confidence/confidence";
import type { ItemSignal, PriceResult } from "../pricing";
import { priceResultSchema } from "../pricing";
import type {
  ExtractedAttributes,
  ListingCopy,
  Pipeline,
  PipelineInput,
  PipelineResult,
} from "./types";

/**
 * Walking-skeleton pipeline. Every AI layer is STUBBED with canned, deterministic
 * output so the end-to-end spine (upload → item → pipeline → listing → review) is
 * provable before any model is wired in. It implements the real `Pipeline` seam,
 * so the real vision/pricing/listing slices drop in WITHOUT touching callers.
 *
 * What is real vs stubbed here:
 *  - REAL: the confidence composite (`computeConfidence`) over the stub's signals,
 *    and the `PriceResult` shape (validated against the real `priceResultSchema`).
 *  - STUBBED: vision extraction (canned attributes), pricing (a canned, schema-
 *    valid `PriceResult`), and listing copy (templated from the attributes).
 *
 * The stub deliberately emits a recognizable hero-domain item (branded
 * electronics) so the confidence lands in a believable mid/high band, exercising
 * the real composite rather than a degenerate zero.
 */

const STUB_MODEL = "stub-pipeline-v1";

/** Canned attributes a real vision call would extract from the photo(s). */
function stubExtract(): ExtractedAttributes {
  return {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242920866",
    specs: ["wireless", "noise-cancelling", "over-ear"],
    title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones",
  };
}

/**
 * Pure mapping ExtractedAttributes → ItemSignal (the pricing router's input). The
 * real pipeline reuses this same mapping; only the producers/consumers on either
 * side become real. Exported so later slices and tests can verify the mapping.
 */
export function attributesToSignal(attrs: ExtractedAttributes): ItemSignal {
  return {
    isbn: attrs.isbn,
    upc: attrs.upc,
    brand: attrs.brand,
    model: attrs.model,
    category: attrs.category,
    condition: attrs.condition,
    conditionKnown: attrs.condition != null,
    // Key specs narrow the web-search query so comps cluster on the same
    // configuration (see ItemSignal.specs) — a query aid, never a price source.
    specs: attrs.specs,
    // attrs.title is the model-GENERATED display title — the vision prompt
    // produces one even for generic/ambiguous items ("Nike running shoes"),
    // so it is NOT identification and must not enable the branded web tier.
    // signal.resolvedName is reserved for externally resolved identities
    // (e.g. a future UPC-catalog lookup).
  };
}

/**
 * Canned price recommendation in the real `{ suggested, range, confidence,
 * sources[], tier }` shape (CONTEXT.md "Price recommendation"). The real
 * `PriceRouter` + tier providers replace this; the SHAPE does not change.
 */
function stubPrice(): PriceResult {
  const result: PriceResult = {
    suggested: 180,
    range: { min: 150, max: 210 },
    // Provisional; the canonical value is recomputed by computeConfidence below.
    confidence: 0.7,
    sources: [
      {
        url: "https://example.com/comp/sony-wh1000xm4-used",
        title: "Sony WH-1000XM4 (used) — comparable listing",
        kind: "asking-comp",
      },
    ],
    tier: "branded-web",
  };
  // Validate against the real contract so the stub can never drift from the seam.
  return priceResultSchema.parse(result);
}

/** Templated listing copy a real per-platform generator would produce. */
function stubListing(attrs: ExtractedAttributes, price: PriceResult): ListingCopy {
  const title = attrs.title ?? "Used item for sale";
  return {
    platform: "ebay",
    title,
    description:
      `${title} in ${attrs.condition ?? "used"} condition. ` +
      `${(attrs.specs ?? []).join(", ")}. ` +
      `Priced around $${price.suggested} (range $${price.range.min}–$${price.range.max}).`,
    fields: {
      brand: attrs.brand,
      model: attrs.model,
      category: attrs.category,
      condition: attrs.condition,
      tags: attrs.specs ?? [],
    },
  };
}

export class StubPipeline implements Pipeline {
  async run(input: PipelineInput): Promise<PipelineResult> {
    if (input.photos.length === 0) {
      throw new Error("StubPipeline requires at least one photo path");
    }

    const attributes = stubExtract();
    const price = stubPrice();

    // Real confidence composite over the stub's signals. Maps the pricing tier
    // ("branded-web") onto the confidence tier vocabulary ("web_wide": branded
    // web comps, asking-only → wide). The real pipeline derives `compAgreement`
    // from the actual comp dispersion; the stub passes a single mid value.
    const signals: ConfidenceSignals = {
      tier: "web_wide",
      compAgreement: 0.6,
      identification: {
        brandResolved: attributes.brand != null,
        modelResolved: attributes.model != null,
        barcodeDecoded: attributes.upc != null || attributes.isbn != null,
        categoryUnambiguous: attributes.category != null,
      },
    };
    const confidence = computeConfidence(signals, {
      autopilotEnabled: input.autopilotEnabled ?? true,
    });

    const listing = stubListing(attributes, price);

    return { attributes, price, confidence, listing, model: STUB_MODEL };
  }
}

/** Default seam binding the rest of the app imports. Swap here when real lands. */
export const pipeline: Pipeline = new StubPipeline();
