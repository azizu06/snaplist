import { describe, expect, it, vi } from "vitest";
import { listingCopySchema, type ExtractedAttributes } from "../pipeline/types";
import type { FewShotExamples, ReferenceMatch } from "../rag";
import { EBAY_TITLE_MAX_LENGTH, ebayListingSchema, type EbayListing } from "./schema";
import {
  corpusReadKey,
  enforceTitleLength,
  generateEbayListing,
  listingHallucinatesAttributes,
  type ListingGenerate,
  type RetrieveFewShot,
} from "./generate";

/**
 * eBay listing generation CONTRACT tests (issue #9). Fully OFFLINE: BOTH the model
 * call (`generate`) and the few-shot grounding (`fewShot`/`retrieve`) are injected, so
 * no network / DB / key is touched. We assert the BOUNDARY behavior (AGENTS.md: test
 * platform constraints, not model quality):
 *
 *  - output validates against the eBay schema AND maps onto the `ListingCopy` seam;
 *  - the title-length cap (≤ 80) is GUARANTEED even when the model over-runs it;
 *  - required eBay fields (title, item specifics, description) are present;
 *  - NO attribute is invented beyond the validated core (brand/model reconciled);
 *  - generation is GROUNDED by the injected few-shot exemplars (retrieval is invoked).
 */

/** A strong, fully-resolved hero-domain item — the validated attribute core. */
const CORE: ExtractedAttributes = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  upc: "027242920866",
  specs: ["wireless", "noise-cancelling", "over-ear"],
  title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones",
};

/** A clean, in-spec eBay listing a well-behaved model would emit for CORE. */
const GOOD_LISTING: EbayListing = {
  title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones - Black, Good Condition",
  itemSpecifics: {
    Brand: "Sony",
    Model: "WH-1000XM4",
    Type: "electronics",
    Condition: "good",
  },
  description:
    "Sony WH-1000XM4 over-ear wireless headphones in good used condition. " +
    "Industry-leading noise cancelling, long battery life. Tested and working.",
  tags: ["sony", "headphones", "noise cancelling", "wireless"],
};

/** Build few-shot exemplars from raw content strings (the rag `fewShotExamples` shape). */
function fewShotOf(...contents: string[]): FewShotExamples {
  const matches: ReferenceMatch[] = contents.map((content, i) => ({
    sourceRef: `ref-${i}`,
    category: "electronics",
    price: 150,
    content,
    metadata: {},
    similarity: 1 - i * 0.1,
  }));
  return { matches, examples: contents };
}

const EXEMPLARS = fewShotOf(
  "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones — Black. Excellent used condition.",
  "Bose QuietComfort 35 II Noise Cancelling Headphones, Silver. Good used condition.",
);

/** A queue-backed fake `generate`: returns the next scripted listing per call. */
function scriptedGenerate(results: EbayListing[]): {
  generate: ListingGenerate;
  calls: Array<Parameters<ListingGenerate>[0]>;
} {
  const calls: Array<Parameters<ListingGenerate>[0]> = [];
  let i = 0;
  const generate: ListingGenerate = async (args) => {
    calls.push(args);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  };
  return { generate, calls };
}

describe("listing/generate — corpusReadKey never uses the service role (#57)", () => {
  it("reads the global corpus with the ANON key, never the RLS-bypassing service role", () => {
    // The request-path retrieval must not bypass RLS even when the service-role
    // secret is configured (it is, for the eval/seed jobs).
    expect(
      corpusReadKey({
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
        SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toBe("anon-key");
    expect(
      corpusReadKey({
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon",
      }),
    ).toBe("public-anon");
    // With ONLY a service-role key, it declines (no anon) rather than bypass RLS.
    expect(corpusReadKey({ SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" })).toBeUndefined();
  });
});

describe("listing/generate — valid output maps onto ListingCopy (ebay)", () => {
  it("returns a schema-valid eBay listing mapped onto the ListingCopy seam", async () => {
    const { generate } = scriptedGenerate([GOOD_LISTING]);
    const { listing, copy } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
    });

    expect(ebayListingSchema.safeParse(listing).success).toBe(true);
    // Maps onto the generic, persistable contract with platform "ebay".
    expect(listingCopySchema.safeParse(copy).success).toBe(true);
    expect(copy.platform).toBe("ebay");
    expect(copy.title).toBe(listing.title);
    expect(copy.fields.itemSpecifics).toEqual(listing.itemSpecifics);
    expect(copy.fields.tags).toEqual(listing.tags);
  });

  it("carries title / item specifics / description / tags from the core", async () => {
    const { generate } = scriptedGenerate([GOOD_LISTING]);
    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
    });
    expect(listing.title).toMatch(/Sony/);
    expect(listing.itemSpecifics.Brand).toBe("Sony");
    expect(listing.itemSpecifics.Model).toBe("WH-1000XM4");
    expect(listing.description.length).toBeGreaterThan(0);
    expect(listing.tags.length).toBeGreaterThan(0);
  });
});

describe("listing/generate — eBay title-length constraint (≤ 80) is guaranteed", () => {
  it("truncates an over-length model title so the RETURNED title fits the cap", async () => {
    const overLong: EbayListing = {
      ...GOOD_LISTING,
      // 100+ chars — well over the 80-char eBay cap.
      title:
        "Sony WH-1000XM4 Wireless Bluetooth Noise-Cancelling Over-Ear Headphones Black Excellent Used Condition Tested",
    };
    const { generate } = scriptedGenerate([overLong]);
    const { listing, copy } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      // No retry: even a single over-length response must be repaired deterministically.
      maxRetries: 0,
    });
    expect(listing.title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
    expect(copy.title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
    // Still recognizably the same item (kept the leading keywords).
    expect(listing.title).toMatch(/Sony WH-1000XM4/);
  });

  it("enforceTitleLength truncates on a word boundary and is idempotent for valid titles", () => {
    const short = "Sony WH-1000XM4 Headphones";
    expect(enforceTitleLength(short)).toBe(short);

    const long = "a".repeat(40) + " " + "b".repeat(60);
    const cut = enforceTitleLength(long);
    expect(cut.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
    expect(cut.endsWith(" ")).toBe(false);
  });
});

describe("listing/generate — required eBay fields present (validation)", () => {
  it("retries then fails clearly when the model never yields required item specifics", async () => {
    // A model that always returns empty item specifics violates the eBay required-field
    // rule. With a core that ALSO has no brand/model/category/condition, reconciliation
    // cannot backfill specifics, so the listing stays invalid → clear throw.
    const emptyCore: ExtractedAttributes = { title: "Mystery item" };
    const noSpecifics: EbayListing = {
      title: "Mystery item for sale",
      itemSpecifics: {},
      description: "An item.",
      tags: [],
    };
    const { generate, calls } = scriptedGenerate([noSpecifics]);
    await expect(
      generateEbayListing({
        attributes: emptyCore,
        fewShot: EXEMPLARS,
        generate,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/specific|valid|constraint|fail/i);
    expect(calls.length).toBe(3); // 1 initial + 2 retries
  });

  it("backfills required item specifics from the core when the model omits them", async () => {
    // Model omits specifics, but the core HAS brand/model/category/condition →
    // reconciliation supplies them so the eBay required-field rule is satisfied.
    const omitted: EbayListing = {
      title: "Sony WH-1000XM4 Headphones - Good Condition",
      itemSpecifics: {},
      description: "Sony over-ear headphones, good condition.",
      tags: ["sony"],
    };
    const { generate } = scriptedGenerate([omitted]);
    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 0,
    });
    expect(Object.keys(listing.itemSpecifics).length).toBeGreaterThan(0);
    expect(listing.itemSpecifics.Brand).toBe("Sony");
  });

  it("throws after exhausting retries when the model call ALWAYS throws", async () => {
    let n = 0;
    const generate: ListingGenerate = async () => {
      n += 1;
      throw new Error("NoObjectGeneratedError: persistent failure");
    };
    await expect(
      generateEbayListing({
        attributes: CORE,
        fewShot: EXEMPLARS,
        generate,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/fail|valid|attempt/i);
    expect(n).toBe(3); // 1 initial + 2 retries
  });
});

describe("listing/generate — no attributes invented beyond the validated core", () => {
  it("detects a hallucinated brand/model that contradicts the core", () => {
    const lying: EbayListing = {
      ...GOOD_LISTING,
      itemSpecifics: { ...GOOD_LISTING.itemSpecifics, Brand: "Bose", Model: "QC45" },
    };
    expect(listingHallucinatesAttributes(lying, CORE)).toBe(true);
    expect(listingHallucinatesAttributes(GOOD_LISTING, CORE)).toBe(false);
  });

  it("detects a brand invented when the core never established one", () => {
    const genericCore: ExtractedAttributes = { category: "electronics", title: "Headphones" };
    const invented: EbayListing = {
      title: "Premium Headphones",
      itemSpecifics: { Brand: "Sony", Type: "electronics" },
      description: "Headphones.",
      tags: [],
    };
    expect(listingHallucinatesAttributes(invented, genericCore)).toBe(true);
  });

  it("retries on a hallucinated brand and returns the compliant retry", async () => {
    const lying: EbayListing = {
      ...GOOD_LISTING,
      itemSpecifics: { ...GOOD_LISTING.itemSpecifics, Brand: "Bose" },
    };
    const { generate, calls } = scriptedGenerate([lying, GOOD_LISTING]);
    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });
    expect(calls.length).toBe(2); // hallucinated → retried
    expect(listing.itemSpecifics.Brand).toBe("Sony"); // back to the core's truth
    expect(listingHallucinatesAttributes(listing, CORE)).toBe(false);
  });

  it("reconciles away a hallucinated brand even if the model never complies", async () => {
    // Model keeps inventing a different brand on every attempt. The returned listing is
    // STILL clean because reconciliation strips/overwrites identity specifics to the core.
    const lying: EbayListing = {
      ...GOOD_LISTING,
      itemSpecifics: { ...GOOD_LISTING.itemSpecifics, Brand: "Bose" },
    };
    const { generate } = scriptedGenerate([lying]);
    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 2,
    });
    // Whatever the model said, the returned listing's brand is the core's brand.
    expect(listing.itemSpecifics.Brand).toBe("Sony");
    expect(listingHallucinatesAttributes(listing, CORE)).toBe(false);
  });

  it("drops item specifics not backed by the core (Color, Storage, Manufacturer, …)", async () => {
    // The model emits valid Brand/Model but ALSO invents non-identity specifics the core
    // never established. Reconciliation whitelists to the core-backed set, so the invented
    // specifics never reach the returned listing — enforcing "no attributes beyond the
    // validated core" for ALL keys, not just brand/model.
    const withInvented: EbayListing = {
      ...GOOD_LISTING,
      itemSpecifics: {
        ...GOOD_LISTING.itemSpecifics,
        Color: "Red",
        "Storage Capacity": "1 TB",
        Manufacturer: "Definitely Not Sony",
      },
    };
    const { generate } = scriptedGenerate([withInvented]);
    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 0,
    });
    // Only the core-backed specifics survive; every invented key is gone.
    expect(listing.itemSpecifics).toEqual({
      Brand: "Sony",
      Model: "WH-1000XM4",
      Type: "electronics",
      Condition: "good",
    });
    expect(listing.itemSpecifics.Color).toBeUndefined();
    expect(listing.itemSpecifics["Storage Capacity"]).toBeUndefined();
    expect(listing.itemSpecifics.Manufacturer).toBeUndefined();
  });
});

describe("listing/generate — grounded by injected few-shot retrieval", () => {
  it("skips optional example retrieval by default and still generates the listing", async () => {
    vi.stubEnv("LISTING_EXAMPLE_RETRIEVAL_ENABLED", "");
    const retrieve = vi.fn(async () => EXEMPLARS);
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);

    try {
      const result = await generateEbayListing({
        attributes: CORE,
        retrieve,
        generate,
      });

      expect(retrieve).not.toHaveBeenCalled();
      expect(calls[0].fewShot).toEqual({ matches: [], examples: [] });
      expect(ebayListingSchema.safeParse(result.listing).success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("invokes the injected `retrieve` and passes the exemplars to the model", async () => {
    const retrieve = vi.fn(async () => EXEMPLARS);
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);
    await generateEbayListing({
      attributes: CORE,
      retrieve,
      generate,
      listingExampleRetrieval: { enabled: true },
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledWith(CORE);
    // The grounding exemplars actually reach the model call.
    expect(calls[0].fewShot.examples).toEqual(EXEMPLARS.examples);
  });

  it("fails open to no examples when enabled retrieval throws", async () => {
    const retrieve = vi.fn(async (): Promise<FewShotExamples> => {
      throw new Error("embedding provider unavailable");
    });
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);

    const result = await generateEbayListing({
      attributes: CORE,
      retrieve,
      generate,
      listingExampleRetrieval: { enabled: true },
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(calls[0].fewShot).toEqual({ matches: [], examples: [] });
    expect(ebayListingSchema.safeParse(result.listing).success).toBe(true);
  });

  it("generates without examples when the enabled corpus is empty", async () => {
    const retrieve = vi.fn(async () => fewShotOf());
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);

    const result = await generateEbayListing({
      attributes: CORE,
      retrieve,
      generate,
      listingExampleRetrieval: { enabled: true },
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(calls[0].fewShot).toEqual({ matches: [], examples: [] });
    expect(ebayListingSchema.safeParse(result.listing).success).toBe(true);
  });

  it("fails open to no examples when enabled retrieval returns an incompatible value", async () => {
    const retrieve = vi.fn(async () => null) as unknown as RetrieveFewShot;
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);

    const result = await generateEbayListing({
      attributes: CORE,
      retrieve,
      generate,
      listingExampleRetrieval: { enabled: true },
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(calls[0].fewShot).toEqual({ matches: [], examples: [] });
    expect(ebayListingSchema.safeParse(result.listing).success).toBe(true);
  });

  it("fails open to no examples when enabled retrieval times out", async () => {
    const retrieve = vi.fn(() => new Promise<FewShotExamples>(() => {}));
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);

    const result = await generateEbayListing({
      attributes: CORE,
      retrieve,
      generate,
      listingExampleRetrieval: { enabled: true, timeoutMs: 5 },
    });

    expect(retrieve).toHaveBeenCalledOnce();
    expect(calls[0].fewShot).toEqual({ matches: [], examples: [] });
    expect(ebayListingSchema.safeParse(result.listing).success).toBe(true);
  });

  it("prefers explicit `fewShot` over calling `retrieve`", async () => {
    const retrieve = vi.fn(async () => fewShotOf("SHOULD NOT BE USED"));
    const { generate, calls } = scriptedGenerate([GOOD_LISTING]);
    await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      retrieve,
      generate,
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(calls[0].fewShot.examples).toEqual(EXEMPLARS.examples);
  });

  it("does not touch the network when generate + few-shot are injected (offline)", async () => {
    const generate = vi.fn(async () => GOOD_LISTING);
    await generateEbayListing({ attributes: CORE, fewShot: EXEMPLARS, generate });
    expect(generate).toHaveBeenCalledOnce();
  });
});
