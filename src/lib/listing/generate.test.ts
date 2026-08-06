import { describe, expect, it, vi } from "vitest";
import { listingCopySchema, type ExtractedAttributes } from "../pipeline/types";
import type { FewShotExamples, ReferenceMatch } from "../rag";
import {
  EBAY_TITLE_MAX_LENGTH,
  ebayListingSchema,
  itemSpecificsFromPairs,
  type EbayListing,
} from "./schema";
import { itemSpecificsToPairs } from "./schema.testing";
import {
  fallbackEbayListing,
  corpusReadKey,
  enforceTitleLength,
  generateEbayListing,
  listingHallucinatesAttributes,
  type ListingGenerate,
  type RetrieveFewShot,
} from "./generate";
import { sellerCopyViolations } from "../seller-copy";

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
  title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones, Good Condition",
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

/**
 * A queue-backed fake `generate`: returns the next scripted listing per call.
 *
 * Cases are authored in the readable name→value shape, then emitted in the
 * MODEL-FACING ordered pair shape (#691) — the fake speaks exactly what a provider
 * returns against `ebayListingRawSchema`.
 */
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
    return { ...r, itemSpecifics: itemSpecificsToPairs(r.itemSpecifics) };
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

describe("listing/generate — seller-visible copy contract (#243)", () => {
  it("keeps a validated title in the factual fallback when stronger identity fields are absent", () => {
    expect(fallbackEbayListing({ title: "Vintage desk lamp" }).title).toBe(
      "Vintage desk lamp",
    );
  });

  it("retries a violating generated draft, then publishes only a core-built fallback", async () => {
    const violating: EbayListing = {
      ...GOOD_LISTING,
      title: "Sure! Sony WH-1000XM4 — not just headphones",
      description:
        "Ships fast with a charger. This premium listing is a must-have for a limited time.",
    };
    const { generate, calls } = scriptedGenerate([violating, violating]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(2);
    expect(listing).toEqual(fallbackEbayListing(CORE));
    expect(sellerCopyViolations(`${listing.title}\n${listing.description}`)).toEqual([]);
    expect(listing.description).not.toMatch(/charger|ship|limited/i);
  });

  it("does not let a digit-free invented accessory bypass the title schema", async () => {
    const inventedAccessory: EbayListing = {
      ...GOOD_LISTING,
      title: "Sony WH-1000XM4 Includes Charger",
    };
    const { generate, calls } = scriptedGenerate([inventedAccessory, inventedAccessory]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(2);
    expect(listing).toEqual(fallbackEbayListing(CORE));
    expect(listing.title).not.toMatch(/charger/i);
  });

  it("does not let a violating generated tag bypass the copy contract", async () => {
    const violatingTag: EbayListing = {
      ...GOOD_LISTING,
      tags: ["Ships fast"],
    };
    const { generate, calls } = scriptedGenerate([violatingTag, violatingTag]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(2);
    expect(listing).toEqual(fallbackEbayListing(CORE));
  });
});

describe("listing/generate — seller-voice hard-list repair (#669)", () => {
  it.each([
    ["em dash", "Sony WH-1000XM4 — good used condition."],
    ["en dash", "Sony WH-1000XM4 – good used condition."],
    ["don't miss", "Don't miss this Sony WH-1000XM4."],
    ["won't last", "This Sony WH-1000XM4 won't last."],
    ["grab yours", "Grab yours before it is gone."],
    ["must-have", "This is a must-have Sony WH-1000XM4."],
    ["look no further", "Look no further for Sony WH-1000XM4 headphones."],
    ["act fast", "Act fast for this Sony WH-1000XM4."],
    ["stunning", "Stunning Sony WH-1000XM4 headphones."],
    ["elevate", "Elevate your listening setup with these headphones."],
    ["boasts", "This headset boasts noise cancelling."],
    ["exquisite", "Exquisite condition for its age."],
    ["seamless", "Seamless wireless listening."],
    ["vibrant", "Vibrant black finish."],
    ["top-notch", "Top-notch noise cancelling."],
    ["sleek", "Sleek over-ear design."],
    ["gorgeous", "Gorgeous black headphones."],
    ["breathtaking", "Breathtaking sound quality."],
    ["whether you're X or Y", "Whether you're a collector or a casual listener, these work."],
    ["more than one exclamation mark", "Tested and working! Includes case!"],
  ])("retries then replaces a raw description with %s", async (_label, description) => {
    const violating: EbayListing = {
      ...fallbackEbayListing(CORE),
      description,
    };
    const { generate, calls } = scriptedGenerate([violating, violating]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(2);
    expect(listing).toEqual(fallbackEbayListing(CORE));
  });

  it("retries and falls back when an item-specific value contains a banned pattern", async () => {
    const violating: EbayListing = {
      ...fallbackEbayListing(CORE),
      description: "Sony WH-1000XM4 headphones in good used condition.",
      itemSpecifics: {
        ...fallbackEbayListing(CORE).itemSpecifics,
        Condition: "stunning",
      },
    };
    const { generate, calls } = scriptedGenerate([violating, violating]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(2);
    expect(listing).toEqual(fallbackEbayListing(CORE));
  });

  it("catches a banned value hiding in a DUPLICATE specific the record conversion drops (#691)", async () => {
    // The model emits two entries under one name. `itemSpecificsFromPairs` keeps the
    // first, so the banned second value never reaches the record — the seller-voice
    // check therefore has to run on the emitted PAIRS, not on the deduped record.
    const clean = fallbackEbayListing(CORE);
    // Distinguishing signal: the pass-through path KEEPS these tags, the
    // seller-voice fallback drops them. Without it the two paths are identical here.
    const smuggling = {
      ...clean,
      description: "Sony WH-1000XM4 headphones in good used condition.",
      tags: ["sony", "headphones"],
      itemSpecifics: [
        ...itemSpecificsToPairs(clean.itemSpecifics),
        { name: "Condition", value: "stunning" },
      ],
    };
    let calls = 0;
    const generate: ListingGenerate = async () => {
      calls += 1;
      return smuggling;
    };

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toBe(2); // violation detected → retried
    expect(listing).toEqual(fallbackEbayListing(CORE));
    expect(listing.tags).toEqual([]); // the model's tags did not survive
  });

  it("does not flag a banned adjective inside a longer word", async () => {
    const clean: EbayListing = {
      ...fallbackEbayListing(CORE),
      description: "These headphones are stunningly well kept and tested.",
    };
    const { generate, calls } = scriptedGenerate([clean]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(1);
    expect(listing).toEqual(fallbackEbayListing(CORE));
  });

  it("passes a clean raw listing through byte-identically", async () => {
    const clean = fallbackEbayListing(CORE);
    const { generate, calls } = scriptedGenerate([clean]);

    const { listing } = await generateEbayListing({
      attributes: CORE,
      fewShot: EXEMPLARS,
      generate,
      maxRetries: 1,
    });

    expect(calls).toHaveLength(1);
    expect(listing).toEqual(clean);
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
    expect(listingHallucinatesAttributes(lying.itemSpecifics, CORE)).toBe(true);
    expect(listingHallucinatesAttributes(GOOD_LISTING.itemSpecifics, CORE)).toBe(false);
  });

  it("detects a contradicting Brand whatever CASING the model chose (#697)", () => {
    // The dedupe key is case-insensitive but the retained record key keeps the first
    // occurrence's own casing, so a model that writes `brand` before `Brand` yields
    // `{ brand: "Bose" }` — the properly-cased, core-matching entry is dropped and the
    // contradicting one is what survives. A literal `specifics["Brand"]` lookup saw
    // nothing there and reported the listing clean, losing the retry nudge.
    const emitted = itemSpecificsFromPairs([
      { name: "brand", value: "Bose" },
      { name: "Brand", value: "Sony" },
    ]);
    expect(emitted).toEqual({ brand: "Bose" });
    expect(listingHallucinatesAttributes(emitted, CORE)).toBe(true);
    // The same insensitivity must not invent a hallucination: a lowercase key whose
    // value AGREES with the core is still clean.
    expect(
      listingHallucinatesAttributes({ brand: "Sony", model: "WH-1000XM4" }, CORE),
    ).toBe(false);
  });

  it("detects a brand invented when the core never established one", () => {
    const genericCore: ExtractedAttributes = { category: "electronics", title: "Headphones" };
    const invented: EbayListing = {
      title: "Premium Headphones",
      itemSpecifics: { Brand: "Sony", Type: "electronics" },
      description: "Headphones.",
      tags: [],
    };
    expect(listingHallucinatesAttributes(invented.itemSpecifics, genericCore)).toBe(true);
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
    expect(listingHallucinatesAttributes(listing.itemSpecifics, CORE)).toBe(false);
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
    expect(listingHallucinatesAttributes(listing.itemSpecifics, CORE)).toBe(false);
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

  it("fails open when enabled retrieval returns examples without matching corpus rows", async () => {
    const retrieve = vi.fn(async () => ({ matches: [], examples: ["stale copy"] }));
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
    const generate = vi.fn(async () => ({
      ...GOOD_LISTING,
      itemSpecifics: itemSpecificsToPairs(GOOD_LISTING.itemSpecifics),
    }));
    await generateEbayListing({ attributes: CORE, fewShot: EXEMPLARS, generate });
    expect(generate).toHaveBeenCalledOnce();
  });
});
