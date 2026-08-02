import { describe, expect, it, vi } from "vitest";
import {
  priceResultSchema,
  type ItemSignal,
  type PriceResult,
  type RetailFinding,
  type SearchClient,
} from "../pricing";
import {
  pipelineResultSchema,
  type ExtractedAttributes,
  type ListingCopy,
} from "../pipeline/types";
import { priceToConfidence } from "../confidence/from-price";
import { createDefaultPricer } from "../pricing/default-pricer";
import { createInMemoryTtlCache } from "../pricing/comp-cache";
import type { EbaySoldComp } from "../pricing/providers/ebay-sold";
import {
  createVisionPipeline,
  type CreateVisionPipelineOptions,
} from "./pipeline";
import type {
  ExtractItemAttributesInput,
  ExtractItemAttributesResult,
} from "./extract";
import type {
  MeasureGenerate,
  ExtractGarmentMeasurementsResult,
} from "./measurements";
import type { DownloadClient } from "./photos";
import { attributesToSignal } from "../pipeline/stub";

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

function fakeDownloadClient(): DownloadClient {
  return {
    storage: {
      from: () => ({
        download: async (path: string) => {
          void path;
          // A tiny non-empty blob with a real media type — the pipeline reads the bytes
          // and passes them inline; the injected fake `extract` ignores the content.
          return {
            data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
              type: "image/jpeg",
            }),
            error: null,
          };
        },
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

/** A garment extraction (issue #104) — routes into the gated measurement call. */
const GARMENT_EXTRACTION: ExtractItemAttributesResult = {
  attributes: {
    brand: "Champion",
    category: "clothing hoodie",
    condition: "good",
    title: "Champion Hoodie",
  },
  identification: { label: "Champion Hoodie", confident: false, evidence: 0.5 },
  model: "test-vision-model",
};

/** Build a pipeline with all real deps replaced by offline fakes; override per test. */
function makePipeline(overrides: Partial<CreateVisionPipelineOptions> = {}) {
  return createVisionPipeline({
    supabase: fakeDownloadClient(),
    extract: fakeExtract(STRONG_EXTRACTION),
    priceItem: async () => STUB_PRICE,
    generateListing: async () => ({ copy: STUB_LISTING, model: STUB_LISTING_MODEL }),
    ...overrides,
  });
}

describe("vision/pipeline — garment measurements (issue #104)", () => {
  it("attaches gated measurement DRAFTS for a garment (auto-suggest kept, tape-gated refused, never confirmed)", async () => {
    const measureGenerate: MeasureGenerate = async () => ({
      garmentType: "hoodie",
      scaleReferenceFound: null,
      scaleReferenceKind: null,
      measurements: [
        { name: "pit_to_pit", value_in: 22, tolerance_in: 1.5, method: "prior-based" },
        // inseam is a bottom measurement AND has no tape → dropped for a top.
        { name: "inseam", value_in: 30, tolerance_in: 2, method: "prior-based" },
      ],
    });
    const result = await makePipeline({
      extract: fakeExtract(GARMENT_EXTRACTION),
      measureGenerate,
    }).run({ photos: ["u/a.jpg"] });

    const measures = result.attributes.measurements ?? [];
    expect(measures.map((m) => m.name)).toContain("pit_to_pit");
    expect(measures.map((m) => m.name)).not.toContain("inseam");
    // Draft-not-autofill: every measurement ships unconfirmed.
    expect(measures.every((m) => m.confirmed === false)).toBe(true);
    expect(pipelineResultSchema.safeParse(result).success).toBe(true);
  });

  it("never feeds unconfirmed measurement drafts into listing generation (#104 confirmed-on-review)", async () => {
    // The listing model treats its attribute input as "the ONLY allowed facts" and its
    // free-text description is not whitelisted — so an unconfirmed AI measurement must
    // never reach it. Drafts attach to the PERSISTED attributes after generation only.
    const measureGenerate: MeasureGenerate = async () => ({
      garmentType: "hoodie",
      scaleReferenceFound: null,
      scaleReferenceKind: null,
      measurements: [
        { name: "pit_to_pit", value_in: 22, tolerance_in: 1.5, method: "prior-based" },
      ],
    });
    const generateListing = vi.fn<
      (args: {
        attributes: ExtractedAttributes;
      }) => Promise<{ copy: ListingCopy; model: string }>
    >(async () => ({ copy: STUB_LISTING, model: STUB_LISTING_MODEL }));

    const result = await makePipeline({
      extract: fakeExtract(GARMENT_EXTRACTION),
      measureGenerate,
      generateListing,
    }).run({ photos: ["u/a.jpg"] });

    // The generator saw the measurement-free core...
    expect(generateListing).toHaveBeenCalledOnce();
    expect(generateListing.mock.calls[0]?.[0].attributes.measurements).toBeUndefined();
    // ...while the drafts still ride on the result for the review screen.
    expect((result.attributes.measurements ?? []).map((m) => m.name)).toContain("pit_to_pit");
  });

  it("keeps pricing and listing generation concurrent with auxiliary measurements", async () => {
    let releaseMeasurements!: () => void;
    const measurementGate = new Promise<void>((resolve) => {
      releaseMeasurements = resolve;
    });
    const measure = vi.fn(async (): Promise<ExtractGarmentMeasurementsResult> => {
      await measurementGate;
      return {
        measurements: [],
        tapeDetected: false,
        garmentType: "hoodie",
        model: "measurement-model",
      };
    });
    const priceItem = vi.fn(async () => STUB_PRICE);
    const generateListing = vi.fn(async () => ({
      copy: STUB_LISTING,
      model: STUB_LISTING_MODEL,
    }));

    const result = makePipeline({
      extract: fakeExtract(GARMENT_EXTRACTION),
      measure,
      priceItem,
      generateListing,
    }).run({ photos: ["u/a.jpg"] });

    await vi.waitFor(() => {
      expect(measure).toHaveBeenCalledOnce();
      expect(priceItem).toHaveBeenCalledOnce();
      expect(generateListing).toHaveBeenCalledOnce();
    });
    releaseMeasurements();
    await expect(result).resolves.toMatchObject({ listing: STUB_LISTING });
  });

  it("skips measurement extraction entirely for non-garments", async () => {
    const measure = vi.fn(
      async (): Promise<ExtractGarmentMeasurementsResult> => ({
        measurements: [],
        tapeDetected: false,
        garmentType: null,
        model: "m",
      }),
    );
    const result = await makePipeline({ measure }).run({ photos: ["u/a.jpg"] });
    expect(measure).not.toHaveBeenCalled(); // STRONG_EXTRACTION is electronics
    expect(result.attributes.measurements).toBeUndefined();
  });

  it("swallows a measurement failure — a garment still gets its price + listing", async () => {
    const measure = vi.fn(
      async (): Promise<ExtractGarmentMeasurementsResult> => {
        throw new Error("model down");
      },
    );
    const result = await makePipeline({
      extract: fakeExtract(GARMENT_EXTRACTION),
      measure,
    }).run({ photos: ["u/a.jpg"] });
    expect(measure).toHaveBeenCalledOnce();
    expect(result.attributes.measurements).toBeUndefined();
    expect(pipelineResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("vision/pipeline — createVisionPipeline.run", () => {
  it("downloads photos, extracts, prices, lists, and returns a schema-valid PipelineResult", async () => {
    const result = await makePipeline().run({ photos: ["u/a.jpg", "u/b.jpg"] });

    expect(pipelineResultSchema.safeParse(result).success).toBe(true);
    expect(priceResultSchema.safeParse(result.price).success).toBe(true);
    expect(result.attributes.model).toBe("WH-1000XM4");
    expect(result.model).toBe("test-vision-model");
  });

  it("passes the downloaded image BYTES (all of them) to extraction", async () => {
    const extract = fakeExtract(STRONG_EXTRACTION);
    await makePipeline({ extract }).run({ photos: ["u/a.jpg", "u/b.jpg"] });

    expect(extract).toHaveBeenCalledOnce();
    // Both photos resolve to inline bytes (not URLs) so Gemini/OpenAI receive image
    // data directly — never a private/loopback Storage URL the SDK would reject.
    expect(extract.mock.calls[0][0].images).toEqual([
      { data: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" },
      { data: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" },
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

  it("keeps passive ISBN and UPC recognition flowing from extraction into pricing", async () => {
    const barcodeExtraction: ExtractItemAttributesResult = {
      attributes: {
        isbn: "9780131103627",
        upc: "027242920866",
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
    const priceItem = vi.fn<(signal: ItemSignal) => Promise<PriceResult>>(
      async () => STUB_PRICE,
    );
    await makePipeline({ extract: fakeExtract(barcodeExtraction), priceItem }).run({
      photos: ["u/a.jpg"],
    });
    expect(priceItem.mock.calls[0]?.[0].isbn).toBe("9780131103627");
    expect(priceItem.mock.calls[0]?.[0].upc).toBe("027242920866");
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
      // Even a LOCKSTEP asking cluster (judged agreement 1) must not clear the
      // gate: tight asking prices prove sellers agree on what to ask, not what
      // buyers pay (#10 round-5).
      compAgreement: 1,
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

    // Asking-only branded-web evidence cannot be marked ready on identification alone (#32)...
    expect(asking.confidence.autopilotEligible).toBe(false);
    // ...while a real sold comp earns the first-class `sold` tier (#60), scores strictly
    // higher, and IS eligible.
    expect(sold.confidence.score).toBeGreaterThan(asking.confidence.score);
    expect(sold.confidence.autopilotEligible).toBe(true);
  });

  it("#10 round-4: a SCATTERED sold set stays web_wide and cannot be marked ready", async () => {
    // $60/$185/$420 sold comps: real sold evidence, but spread (max-min)/median
    // = 1.95 → judged agreement 0. Pre-fix, the sold-comp label alone earned the
    // high tier with a fixed 0.7 agreement (score ≥ 0.75 gate). Now the
    // provider's judged tightness rides on the result: a wide sold set maps to
    // web_wide (0.6·0.6 + 0.25·1 + 0.15·0 = 0.61) and stays sub-gate, while a
    // tight cluster earns the first-class `sold` tier (#60) and clears it.
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
    const soldSources = [
      { url: "https://example.com/sold/1", title: "Sold $60", kind: "sold-comp" },
      { url: "https://example.com/sold/2", title: "Sold $185", kind: "sold-comp" },
      { url: "https://example.com/sold/3", title: "Sold $420", kind: "sold-comp" },
    ];
    const scattered = priceResultSchema.parse({
      suggested: 185,
      range: { min: 60, max: 420 },
      confidence: 0.7,
      sources: soldSources,
      tier: "branded-web",
      compAgreement: 0, // spreadToAgreement(1.95)
    });
    const tight = priceResultSchema.parse({
      suggested: 185,
      range: { min: 178, max: 200 },
      confidence: 0.8,
      sources: soldSources,
      tier: "branded-web",
      compAgreement: 0.88, // spreadToAgreement(0.12)
    });

    const wide = await makePipeline({
      extract: fakeExtract(brandedItem),
      priceItem: async () => scattered,
    }).run({ photos: ["u/a.jpg"] });
    const clustered = await makePipeline({
      extract: fakeExtract(brandedItem),
      priceItem: async () => tight,
    }).run({ photos: ["u/a.jpg"] });

    expect(wide.confidence.autopilotEligible).toBe(false);
    expect(wide.confidence.score).toBeLessThan(0.75);
    expect(clustered.confidence.autopilotEligible).toBe(true);
    expect(clustered.confidence.score).toBeGreaterThan(wide.confidence.score);
  });

  it("#10 round-4: the generated display title is NOT identification (no resolvedName)", async () => {
    // The vision prompt generates a short title even for generic items, so
    // attributesToSignal must not map it into signal.resolvedName — otherwise
    // brand "Nike" + title "Nike running shoes" defeats the bare-brand
    // safeguard and prices an unidentified product from same-brand comps.
    const signal = attributesToSignal({
      brand: "Nike",
      category: "shoes",
      title: "Nike running shoes",
    });
    expect(signal.resolvedName).toBeUndefined();
    expect(signal.brand).toBe("Nike");
  });

  it("throws when given no photos", async () => {
    await expect(makePipeline().run({ photos: [] })).rejects.toThrow(
      /at least one photo/i,
    );
  });
});

// ---------------------------------------------------------------------------
// #11 — depreciation + llm-only fallback tiers, end-to-end through the REAL
// default pricer (every tier's network/model dep replaced by an offline fake).
// ---------------------------------------------------------------------------

describe("#11 — createDefaultPricer fallthrough (offline fakes)", () => {
  /** Per-call labels pushed by every fake, so the TIER ORDER itself is assertable. */
  function instrumentedPricer(args: {
    calls: string[];
    /** Retail findings the depreciation extractor returns ([] = tier declines). */
    retailFindings: RetailFinding[];
  }) {
    const { calls, retailFindings } = args;
    const emptyWebSearch: SearchClient = {
      async search() {
        calls.push("web-search");
        return []; // No comps anywhere → tiers 2/3 decline.
      },
    };
    const retailSearch: SearchClient = {
      async search() {
        calls.push("retail-search");
        return [{ url: "https://www.walmart.com/ip/r1", title: "new", snippet: "$100.00" }];
      },
    };
    return createDefaultPricer({
      isbn: {
        fetchJson: async () => {
          calls.push("isbn-lookup");
          return null; // Neither catalog API matches → tier 1 declines.
        },
      },
      // Inject the eBay-sold fetch seam so this OFFLINE suite never hits the
      // network: an empty results page → no sold comps → the tier declines.
      ebaySold: {
        fetchPage: async () => {
          calls.push("ebay-sold");
          return "";
        },
        cache: createInMemoryTtlCache<EbaySoldComp[]>(
          60_000,
          Date.now,
          "shared",
        ),
      },
      webSearch: { searchClient: emptyWebSearch },
      depreciation: {
        searchClient: retailSearch,
        extractRetail: async () => retailFindings,
        model: "test-retail-model",
      },
      llmOnly: {
        estimatePrice: async () => {
          calls.push("llm-estimate");
          return { suggested: 22, min: 12, max: 40 };
        },
        model: "test-estimator-model",
      },
    });
  }

  /** Carries signals for EVERY tier, so the whole chain is exercised in order. */
  const fullSignal: ItemSignal = {
    isbn: "9780131103627",
    upc: "027242920866",
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    conditionKnown: true,
  };

  it("falls through every tier IN PRD ORDER and ends at llm-only when all decline", async () => {
    const calls: string[] = [];
    const price = instrumentedPricer({ calls, retailFindings: [] });

    const result = await price(fullSignal);

    expect(result.tier).toBe("llm-only");
    expect(result.suggested).toBe(22);
    expect(priceResultSchema.safeParse(result).success).toBe(true);
    // The tiers were consulted in PRD priority order, each one only after the
    // previous declined. (branded-web is correctly SKIPPED: a UPC-bearing
    // signal is owned by the upc-aided tier — no duplicate web spend.)
    const order = calls.filter((label, i) => calls.indexOf(label) === i);
    expect(order).toEqual([
      "isbn-lookup",
      "ebay-sold",
      "web-search",
      "retail-search",
      "llm-estimate",
    ]);
  });

  it("depreciation fires BEFORE llm-only when a cited retail anchor exists", async () => {
    const calls: string[] = [];
    const price = instrumentedPricer({
      calls,
      retailFindings: [{ url: "https://www.walmart.com/ip/r1", title: "new", price: 100 }],
    });

    const result = await price(fullSignal);

    expect(result.tier).toBe("depreciation");
    // $100 retail × good (0.5) — deterministic math over the cited anchor.
    expect(result.suggested).toBe(50);
    expect(result.sources).toEqual([
      { url: "https://www.walmart.com/ip/r1", title: "new", kind: "retail-price" },
    ]);
    // The retail anchor came from LLM extraction → its model is the provenance.
    expect(result.model).toBe("test-retail-model");
    // The floor was never consulted — llm-only fires LAST, and only last.
    expect(calls).not.toContain("llm-estimate");
  });

  it("a GENERIC item lands a clearly low-confidence depreciation estimate end-to-end", async () => {
    // Acceptance: generic brand+category item (no model/UPC/ISBN, so tiers 1-3
    // decline by canHandle) where only a RETAIL price can be found → priced at
    // retail × condition factor, labeled LOW confidence, never autopilot.
    const calls: string[] = [];
    const generic: ExtractItemAttributesResult = {
      attributes: {
        brand: "Hamilton Beach",
        category: "kitchen",
        condition: "fair",
        title: "Hamilton Beach blender",
      },
      identification: {
        label: "Hamilton Beach blender",
        confident: false,
        evidence: 0.5,
        reason: "No model number visible.",
      },
      model: "test-vision-model",
    };
    const result = await makePipeline({
      extract: fakeExtract(generic),
      priceItem: instrumentedPricer({
        calls,
        retailFindings: [{ url: "https://www.walmart.com/ip/r1", price: 100 }],
      }),
    }).run({ photos: ["u/a.jpg"] });

    expect(result.price.tier).toBe("depreciation");
    expect(result.price.suggested).toBe(35); // $100 retail × fair (0.35).
    // Clearly labeled low confidence: the review page derives its band from
    // this persisted score, so "low" here is what the user sees.
    expect(result.confidence.band).toBe("low");
    expect(result.confidence.autopilotEligible).toBe(false);
    // Provenance flows to the prediction log: the retail EXTRACTION model.
    expect(result.pricingModel).toBe("test-retail-model");
  });

  it("an UNIDENTIFIABLE item ends at the llm-only floor, lowest confidence, end-to-end", async () => {
    // Acceptance: nothing searchable at all → every evidence tier declines and
    // the LLM-only floor fires LAST, with the lowest confidence band.
    const calls: string[] = [];
    const unidentifiable: ExtractItemAttributesResult = {
      attributes: { category: "home goods", condition: "good", title: "Unbranded item" },
      identification: {
        label: "Unidentified home goods item",
        confident: false,
        evidence: 0.25,
        reason: "Not enough strong identifiers.",
      },
      model: "test-vision-model",
    };
    const result = await makePipeline({
      extract: fakeExtract(unidentifiable),
      priceItem: instrumentedPricer({ calls, retailFindings: [] }),
    }).run({ photos: ["u/a.jpg"] });

    expect(result.price.tier).toBe("llm-only");
    expect(result.price.sources).toEqual([]); // No evidence is claimed.
    expect(result.confidence.band).toBe("low");
    expect(result.confidence.autopilotEligible).toBe(false);
    expect(result.pricingModel).toBe("test-estimator-model");
    // With no identity there was nothing to search — the floor caught it directly.
    expect(calls).toEqual(["llm-estimate"]);
  });

  it("the fallback tiers stay sub-gate even with PERFECT identification (no autopilot bypass)", async () => {
    // The composite arithmetic guarantees it (0.6·tierBase + 0.25·id +
    // 0.15·agreement: depreciation ≤ 0.64, llm-only ≤ 0.52, both < 0.75); this
    // pins the guarantee through the REAL pipeline mapping, with the strongest
    // possible extraction.
    const depreciationPrice = priceResultSchema.parse({
      suggested: 50,
      range: { min: 35, max: 65 },
      confidence: 0.35,
      sources: [{ url: "https://www.walmart.com/ip/r1", kind: "retail-price" }],
      tier: "depreciation",
    });
    const llmOnlyPrice = priceResultSchema.parse({
      suggested: 22,
      range: { min: 12, max: 40 },
      confidence: 0.2,
      sources: [],
      tier: "llm-only",
    });

    for (const price of [depreciationPrice, llmOnlyPrice]) {
      const result = await makePipeline({ priceItem: async () => price }).run({
        photos: ["u/a.jpg"],
      });
      expect(result.confidence.score).toBeLessThan(0.75);
      expect(result.confidence.band).not.toBe("high");
      expect(result.confidence.autopilotEligible).toBe(false);
    }
  });
});

describe("web_tight tier — strongly-corroborated asking clusters (web-search coverage lever)", () => {
  // A branded item identified at 3/4 (brand + model + category; no barcode).
  const attrs = { brand: "Sony", model: "WH-1000XM4", category: "electronics" };
  const askingFrom = (hosts: string[]) =>
    hosts.map((h, i) => ({ url: `https://${h}/listing/${i}`, kind: "asking-comp" as const }));
  const askingPrice = (compAgreement: number, hosts: string[]): PriceResult =>
    priceResultSchema.parse({
      suggested: 150,
      range: { min: 90, max: 220 },
      confidence: 0.6,
      tier: "branded-web",
      compAgreement,
      sources: askingFrom(hosts),
    });

  it("a TIGHT cluster of 4+ INDEPENDENT asking sources can clear the autopilot gate", () => {
    const c = priceToConfidence(
      attrs,
      askingPrice(0.9, ["ebay.com", "mercari.com", "swappa.com", "reverb.com"]),
    );
    expect(c.band).toBe("high");
    expect(c.autopilotEligible).toBe(true);
  });

  it("fewer than 4 independent asking sources stays sub-gate (web_wide, capped)", () => {
    const c = priceToConfidence(
      attrs,
      askingPrice(0.9, ["ebay.com", "mercari.com", "swappa.com"]),
    );
    expect(c.autopilotEligible).toBe(false);
  });

  it("5 sources from the SAME domain count as one — not independent corroboration", () => {
    const c = priceToConfidence(
      attrs,
      askingPrice(0.95, ["ebay.com", "ebay.com", "ebay.com", "ebay.com", "ebay.com"]),
    );
    expect(c.autopilotEligible).toBe(false);
  });

  it("a loosely-agreeing 4-source cluster does NOT clear (the bump is bounded, not a blank check)", () => {
    // Agreement exactly at the tightness floor: web_tight may fire, but a barely-
    // tight cluster is still queued for review (the score math gates it).
    const c = priceToConfidence(
      attrs,
      askingPrice(0.5, ["ebay.com", "mercari.com", "swappa.com", "reverb.com"]),
    );
    expect(c.autopilotEligible).toBe(false);
  });

  it("a single asking comp is still sub-gate (the #32 honesty guarantee holds)", () => {
    const c = priceToConfidence(attrs, askingPrice(1, ["ebay.com"]));
    expect(c.autopilotEligible).toBe(false);
  });
});
