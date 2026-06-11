import { describe, expect, it, vi } from "vitest";
import { priceResultSchema, type ItemSignal, type PriceResult } from "../pricing";
import { pipelineResultSchema, type ListingCopy } from "../pipeline/types";
import {
  createVisionPipeline,
  type CreateVisionPipelineOptions,
} from "./pipeline";
import type {
  ExtractItemAttributesInput,
  ExtractItemAttributesResult,
} from "./extract";
import type { SignedUrlClient } from "./photos";

/**
 * `createVisionPipeline` tests (offline). Extraction, pricing, listing generation, and
 * storage signing are ALL injected, so this exercises the real composition — photos →
 * signed URLs → extraction → pricing → listing → #31-calibrated confidence — without
 * network or DB. The integration wires #8 (pricing) + #9 (listing) behind the seam.
 */

/** A typed fake for the injected extraction (so `.mock.calls[0][0]` is well-typed). */
function fakeExtract(result: ExtractItemAttributesResult) {
  return vi.fn(
    async (input: ExtractItemAttributesInput): Promise<ExtractItemAttributesResult> => {
      void input;
      return result;
    },
  );
}

function fakeSignerClient(): SignedUrlClient {
  return {
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://signed/${path}` },
          error: null,
        }),
      }),
    },
  };
}

const STRONG_EXTRACTION: ExtractItemAttributesResult = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242920866",
    specs: ["wireless", "noise-cancelling"],
    title: "Sony WH-1000XM4 Headphones",
  },
  identification: {
    label: "Sony WH-1000XM4 Headphones",
    confident: true,
    evidence: 1,
  },
  model: "test-vision-model",
};

/** Canned offline price + listing so the wired pricer/generator never touch the network. */
const STUB_PRICE: PriceResult = priceResultSchema.parse({
  suggested: 50,
  range: { min: 40, max: 60 },
  confidence: 0.5,
  sources: [],
  tier: "llm-only",
});
const STUB_LISTING: ListingCopy = {
  platform: "ebay",
  title: "Sony WH-1000XM4 Headphones",
  description: "A description.",
  fields: { itemSpecifics: { Brand: "Sony" }, tags: ["sony"] },
};
/** The listing generator now returns its own model id (logged for provenance, #32). */
const STUB_LISTING_MODEL = "test-listing-model";

/** Build a pipeline with all real deps replaced by offline fakes; override per test. */
function makePipeline(overrides: Partial<CreateVisionPipelineOptions> = {}) {
  return createVisionPipeline({
    supabase: fakeSignerClient(),
    extract: fakeExtract(STRONG_EXTRACTION),
    priceItem: async () => STUB_PRICE,
    generateListing: async () => ({ copy: STUB_LISTING, model: STUB_LISTING_MODEL }),
    ...overrides,
  });
}

describe("vision/pipeline — createVisionPipeline.run", () => {
  it("signs photos, extracts, prices, lists, and returns a schema-valid PipelineResult", async () => {
    const result = await makePipeline().run({ photos: ["u/a.jpg", "u/b.jpg"] });

    expect(pipelineResultSchema.safeParse(result).success).toBe(true);
    expect(priceResultSchema.safeParse(result.price).success).toBe(true);
    expect(result.attributes.model).toBe("WH-1000XM4");
    expect(result.model).toBe("test-vision-model");
  });

  it("passes the SIGNED image URLs (all of them) to extraction", async () => {
    const extract = fakeExtract(STRONG_EXTRACTION);
    await makePipeline({ extract }).run({ photos: ["u/a.jpg", "u/b.jpg"] });

    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0][0].images).toEqual([
      "https://signed/u/a.jpg",
      "https://signed/u/b.jpg",
    ]);
  });

  it("prices via the injected pricer and lists via the injected generator", async () => {
    const priceItem = vi.fn(async () => STUB_PRICE);
    const generateListing = vi.fn(async () => ({
      copy: STUB_LISTING,
      model: STUB_LISTING_MODEL,
    }));
    const result = await makePipeline({ priceItem, generateListing }).run({
      photos: ["u/a.jpg"],
    });
    expect(priceItem).toHaveBeenCalledOnce();
    expect(generateListing).toHaveBeenCalledOnce();
    expect(result.price).toEqual(STUB_PRICE);
    expect(result.listing).toEqual(STUB_LISTING);
  });

  it("surfaces the listing model separately from the vision model (#32 provenance)", async () => {
    // The result carries the vision model in `model` and the listing generator's own
    // model in `listingModel`, so a prediction's listing copy is attributable even when
    // LISTING_MODEL differs from the vision model. The pipeline must not collapse them.
    const result = await makePipeline({
      generateListing: async () => ({ copy: STUB_LISTING, model: "listing-gpt-5.5-mini" }),
    }).run({ photos: ["u/a.jpg"] });
    expect(result.model).toBe("test-vision-model");
    expect(result.listingModel).toBe("listing-gpt-5.5-mini");
  });

  it("surfaces the pricing model from the price result (#10 provenance), unset when deterministic", async () => {
    // A web-tier price stamps the comp-extraction model on the result; the pipeline
    // must thread it through as `pricingModel` so the prediction log can record it.
    const webPriced = await makePipeline({
      priceItem: async () => ({ ...STUB_PRICE, model: "pricing-gpt-5.5" }),
    }).run({ photos: ["u/a.jpg"] });
    expect(webPriced.pricingModel).toBe("pricing-gpt-5.5");
    // A deterministic tier (no pricing LLM) leaves it unset — logged as null, not faked.
    const deterministic = await makePipeline({
      priceItem: async () => STUB_PRICE,
    }).run({ photos: ["u/a.jpg"] });
    expect(deterministic.pricingModel).toBeUndefined();
  });

  it("routes the attribute-derived ItemSignal (incl. ISBN) to the pricer", async () => {
    const isbnExtraction: ExtractItemAttributesResult = {
      attributes: {
        isbn: "9780131103627",
        category: "books",
        title: "The C Programming Language",
      },
      identification: {
        label: "The C Programming Language",
        confident: true,
        evidence: 0.5,
      },
      model: "m",
    };
    const priceItem = vi.fn(async (_signal: ItemSignal) => STUB_PRICE);
    await makePipeline({ extract: fakeExtract(isbnExtraction), priceItem }).run({
      photos: ["u/a.jpg"],
    });
    expect(priceItem.mock.calls[0]?.[0].isbn).toBe("9780131103627");
  });

  it("surfaces the identification on the result (before pricing, for confirmation)", async () => {
    const result = await makePipeline().run({ photos: ["u/a.jpg"] });
    expect(result.identification?.confident).toBe(true);
    expect(result.identification?.label).toMatch(/Sony/);
  });

  it("propagates a flagged (low-confidence) identification and lands low confidence", async () => {
    const weak: ExtractItemAttributesResult = {
      attributes: { category: "home goods", title: "Unbranded item" },
      identification: {
        label: "Unidentified home goods item",
        confident: false,
        evidence: 0.25,
        reason: "Not enough strong identifiers.",
      },
      model: "test-vision-model",
    };
    const result = await makePipeline({ extract: fakeExtract(weak) }).run({
      photos: ["u/a.jpg"],
    });
    expect(result.identification?.confident).toBe(false);
    expect(result.confidence.band).toBe("low");
    expect(result.confidence.autopilotEligible).toBe(false);
  });

  it("keeps the model's self-reported ambiguity OUT of the confidence score (signal-based)", async () => {
    // Identical extracted evidence + identical price; only the model's self-report
    // differs. The user-facing identification flag must change, but the deterministic
    // confidence score must NOT — the composite depends on evidence, not LLM self-report.
    const attributes = {
      brand: "Sony",
      model: "WH-1000XM4",
      category: "electronics",
      condition: "good",
      upc: "027242920866",
    };
    const confidentExtraction: ExtractItemAttributesResult = {
      attributes,
      identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
      model: "m",
    };
    const modelUnsureExtraction: ExtractItemAttributesResult = {
      attributes,
      identification: {
        label: "Sony WH-1000XM4",
        confident: false,
        evidence: 1,
        reason: "Model flagged this identification as uncertain.",
      },
      model: "m",
    };
    const run = (e: ExtractItemAttributesResult) =>
      makePipeline({ extract: fakeExtract(e) }).run({ photos: ["u/a.jpg"] });

    const a = await run(confidentExtraction);
    const b = await run(modelUnsureExtraction);

    expect(b.confidence.score).toBe(a.confidence.score);
    expect(a.identification?.confident).toBe(true);
    expect(b.identification?.confident).toBe(false);
  });

  it("#31: a retail-derived ISBN price (no sold comp) is trusted at depreciation, not isbn", async () => {
    // Same strongly-identified book; the ONLY difference is the price's evidence: a
    // catalog lookup (retail-derived) vs a real sold comp. The retail-derived one must
    // NOT earn the top ISBN trust, so it scores lower and is not autopilot-eligible.
    const strongBook: ExtractItemAttributesResult = {
      attributes: {
        brand: "Prentice Hall",
        model: "2nd Edition",
        category: "books",
        isbn: "9780131103627",
        title: "The C Programming Language",
      },
      identification: { label: "K&R C", confident: true, evidence: 1 },
      model: "m",
    };
    const isbnRetail = priceResultSchema.parse({
      suggested: 12,
      range: { min: 8, max: 16 },
      confidence: 0.9,
      sources: [
        { url: "https://openlibrary.org/isbn/x.json", title: "Open Library", kind: "isbn-lookup" },
      ],
      tier: "isbn-lookup",
    });
    const isbnComped = priceResultSchema.parse({
      suggested: 12,
      range: { min: 8, max: 16 },
      confidence: 0.9,
      sources: [{ url: "https://example.com/sold/x", title: "Sold comp", kind: "sold-comp" }],
      tier: "isbn-lookup",
    });

    const retail = await makePipeline({
      extract: fakeExtract(strongBook),
      priceItem: async () => isbnRetail,
    }).run({ photos: ["u/a.jpg"] });
    const comped = await makePipeline({
      extract: fakeExtract(strongBook),
      priceItem: async () => isbnComped,
    }).run({ photos: ["u/a.jpg"] });

    // A real sold comp earns the top ISBN trust; the retail-derived estimate does not.
    expect(comped.confidence.score).toBeGreaterThan(retail.confidence.score);
    // And a retail-derived ISBN price is NOT autopilot-eligible on identity alone (#31).
    expect(retail.confidence.autopilotEligible).toBe(false);
    // The pricing tier logged is still the ISBN tier in both cases (identity is exact).
    expect(retail.price.tier).toBe("isbn-lookup");
  });

  it("#32: a branded-web price with only an asking comp is not autopilot-eligible", async () => {
    // Same fully-identified branded item; the ONLY difference is the price's evidence:
    // an asking-only comp vs a real sold comp. The pricing contract lets `branded-web`
    // cite asking-only/scattered sources, so without a sold comp it must NOT clear the
    // autopilot gate on identity alone — a sold comp earns the tight tier and outscores it.
    const brandedItem: ExtractItemAttributesResult = {
      attributes: {
        brand: "Sony",
        model: "WH-1000XM4",
        category: "electronics",
        condition: "good",
        upc: "027242920866",
        title: "Sony WH-1000XM4 Headphones",
      },
      identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
      model: "m",
    };
    const askingOnly = priceResultSchema.parse({
      suggested: 180,
      range: { min: 150, max: 210 },
      confidence: 0.7,
      sources: [
        { url: "https://example.com/ask/x", title: "Asking comp", kind: "asking-comp" },
      ],
      tier: "branded-web",
    });
    const soldComped = priceResultSchema.parse({
      suggested: 180,
      range: { min: 150, max: 210 },
      confidence: 0.7,
      sources: [{ url: "https://example.com/sold/x", title: "Sold comp", kind: "sold-comp" }],
      tier: "branded-web",
    });

    const asking = await makePipeline({
      extract: fakeExtract(brandedItem),
      priceItem: async () => askingOnly,
    }).run({ photos: ["u/a.jpg"] });
    const sold = await makePipeline({
      extract: fakeExtract(brandedItem),
      priceItem: async () => soldComped,
    }).run({ photos: ["u/a.jpg"] });

    // Asking-only branded-web evidence cannot auto-post on identification alone (#32)...
    expect(asking.confidence.autopilotEligible).toBe(false);
    // ...while a real sold comp earns the tight tier, scores strictly higher, and IS eligible.
    expect(sold.confidence.score).toBeGreaterThan(asking.confidence.score);
    expect(sold.confidence.autopilotEligible).toBe(true);
  });

  it("throws when given no photos", async () => {
    await expect(makePipeline().run({ photos: [] })).rejects.toThrow(
      /at least one photo/i,
    );
  });
});
