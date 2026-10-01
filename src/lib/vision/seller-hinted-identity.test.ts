import { describe, expect, it, vi } from "vitest";
import { PriceRouter } from "../pricing/router";
import { buildSoldSearchQuery } from "../pricing/providers/ebay-sold";
import type {
  ItemSignal,
  PriceResult,
  PricingProvider,
  PricingTier,
} from "../pricing/types";
import type { SellerContext } from "../pipeline/types";
import { createVisionPipelineStages } from "./pipeline";
import type { VisionGenerate, VisionGenerateResult } from "./extract";
import type { DownloadClient } from "./photos";
import { createDefaultPricer } from "../pricing/default-pricer";
import { createInMemoryTtlCache } from "../pricing/comp-cache";
import type { ApifySoldComp, RunApifySoldActor } from "../pricing/providers/apify-sold";
import { generateEbayListing } from "../listing/generate";
import { priceToConfidence } from "../confidence/from-price";

/**
 * Issue #1120 regression: a genuine, unmistakably branded item (Apple AirPods Pro,
 * photographed with its case, seller voice saying "the newest generation of AirPods
 * Pros") was priced at $30 by the terminal `llm-only` tier with zero sources.
 *
 * Cause chain proved in prod: the vision step hedged to "AirPods Pro-style" and left
 * `brand`/`model` null → `attributesToSignal` produced a signal with no identity →
 * `buildSoldSearchQuery` returned `null` → the eBay sold-comp tier declined by design
 * → the web tier declined → the LLM priced a generic earbud.
 *
 * This asserts the seam that actually broke: the seller's transcript must REACH the
 * vision call as an identity hint, and a hinted identity must carry into the pricing
 * signal far enough for the sold-comp tier to fire. The fake model here adopts the
 * seller-named identity ONLY when the transcript is delivered to it, so the test is
 * red exactly while the wiring is missing.
 */

const AIRPODS_TRANSCRIPT: SellerContext = {
  text: "These are the newest generation of AirPods Pros, barely used, with the case.",
  language: "en",
  provenance: "seller_voice",
  verification: "unverified",
};

/** What the prod run actually produced: a "-style" hedge with no brand or model. */
const HEDGED: VisionGenerateResult = {
  title: "White AirPods Pro-style Wireless Earbuds with Case",
  category: "true wireless earbuds with charging case",
  condition: "very-good",
  specs: ["wireless charging case", "in-ear"],
};

/**
 * A model that behaves like the real one: it withholds brand/model on its own, and
 * commits to the seller-named identity only when the photos are consistent with it
 * AND the transcript is actually handed to the call.
 */
function hintAwareGenerate(): VisionGenerate {
  return async (args) => {
    const hint = args.sellerContext?.text ?? "";
    if (/airpods pro/i.test(hint)) {
      return {
        ...HEDGED,
        title: "Apple AirPods Pro Wireless Earbuds with Charging Case",
        brand: "Apple",
        model: "AirPods Pro",
        identityHintUsed: true,
      };
    }
    return { ...HEDGED };
  };
}

function fakeDownloadClient(): DownloadClient {
  return {
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
            type: "image/jpeg",
          }),
          error: null,
        }),
      }),
    },
  };
}

/** A stub tier that handles whatever `handles` accepts, stamped with its own tier. */
function stubProvider(
  tier: PricingTier,
  handles: (signal: ItemSignal) => boolean,
): PricingProvider {
  return {
    tier,
    price: async (signal): Promise<PriceResult | null> => {
      if (!handles(signal)) return null;
      return {
        suggested: 180,
        range: { min: 150, max: 210 },
        confidence: 0.5,
        sources:
          tier === "llm-only"
            ? []
            : [{ url: `https://stub.example/${tier}`, kind: "sold-comp" }],
        tier,
      };
    },
  };
}

/**
 * The real routing decision under test: the sold tier declines exactly when the REAL
 * `buildSoldSearchQuery` cannot formulate a query from the signal, and `llm-only` is
 * the terminal catch-all — the same fall-through that produced the $30 estimate.
 */
function router(): (signal: ItemSignal) => Promise<PriceResult> {
  const priceRouter = new PriceRouter([
    stubProvider("ebay-sold", (signal) => buildSoldSearchQuery(signal) !== null),
    stubProvider("llm-only", () => true),
  ]);
  return (signal) => priceRouter.price(signal);
}

describe("issue #1120 — seller-hinted identity reaches the sold-comp tier", () => {
  it("routes the AirPods Pro run to the sold-comp tier instead of llm-only", async () => {
    const stages = createVisionPipelineStages({
      supabase: fakeDownloadClient(),
      generate: hintAwareGenerate(),
      priceItem: router(),
    });

    const identified = await stages.identify({
      photos: ["user-1/airpods-front.jpg", "user-1/airpods-case.jpg"],
      sellerContext: AIRPODS_TRANSCRIPT,
    });

    expect(identified.attributes.brand).toBe("Apple");
    expect(identified.attributes.model).toBe("AirPods Pro");

    const price = await stages.price({ attributes: identified.attributes });
    expect(price.tier).toBe("ebay-sold");
  });

  it("still prices photos-only when no transcript exists (honest fallback)", async () => {
    const stages = createVisionPipelineStages({
      supabase: fakeDownloadClient(),
      generate: hintAwareGenerate(),
      priceItem: router(),
    });

    const identified = await stages.identify({
      photos: ["user-1/airpods-front.jpg"],
    });
    const price = await stages.price({ attributes: identified.attributes });
    expect(price.tier).toBe("llm-only");
  });
});

describe("voice family with an unconfirmed keyboard variant", () => {
  it.each([
    ["So this is the Rainy 75 Pro, I think V3.", "Rainy 75 Pro"],
    ["This is my Raining 75, not sure which version.", "Raining 75"],
  ])("uses the seller-stated family from %j throughout the real pipeline and invokes bounded Apify research", async (text, sourceText) => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: [80, 90, 100].map((price, i) => ({
        url: `https://www.ebay.com/itm/12345678900${i}`,
        title: "WOBKEY Rainy75 Mechanical Keyboard",
        condition: "Pre-Owned",
        endedAt: "2026-09-29T12:00:00.000Z",
        soldPrice: String(price),
        soldCurrency: "USD",
        isBestOfferAccepted: false,
      })),
    }));
    const stages = createVisionPipelineStages({
      supabase: fakeDownloadClient(),
      generate: async () => ({
        title: "Compact 75% Mechanical Keyboard",
        category: "Mechanical keyboard",
        condition: "good",
        ambiguous: true,
        uncertaintyReason: "Version and trim are not confirmed.",
        sellerIdentity: {
          sourceText, brand: "WOBKEY", model: "Rainy75",
          contradicted: false, variantUncertain: true,
        },
      }),
      priceItem: createDefaultPricer({
        apifySold: {
          enabled: true, token: "offline-placeholder", runActor,
          cache: createInMemoryTtlCache<ApifySoldComp[]>(60_000, Date.now, "shared"),
          now: () => Date.parse("2026-09-30T12:00:00Z"),
        },
        ebaySold: { enabled: false },
        llmOnly: { estimatePrice: async () => ({ suggested: 90, min: 55, max: 120 }) },
      }),
      generateListing: async ({ attributes, sellerContext }) => {
        const result = await generateEbayListing({
          attributes, sellerContext, fewShot: { examples: [], matches: [] },
          generate: async () => ({ title: "Compact Mechanical Keyboard", description: "Keyboard.", itemSpecifics: [], tags: [] }),
        });
        return { copy: result.copy, model: result.model };
      },
    });
    const result = await stages.run({
      photos: ["user-1/keyboard-front.jpg", "user-1/keyboard-side.jpg"],
      sellerContext: { text, language: "en", provenance: "seller_voice", verification: "unverified" },
      autopilotEnabled: false,
    });
    expect(runActor).toHaveBeenCalledOnce();
    expect(runActor.mock.calls[0]?.[0]).toMatchObject({
      input: { keywords: ["WOBKEY Rainy75"], count: 30 },
      timeoutSecs: 120, waitSecs: 125, maxTotalChargeUsd: 0.25, requestRetries: 2, restartOnError: false,
    });
    expect(result.attributes).toMatchObject({ brand: "WOBKEY", model: "Rainy75", identitySource: "seller-stated" });
    expect(result.price.tier).toBe("ebay-sold");
    expect(result.listing.title).toContain("WOBKEY Rainy75");
    expect(result.listing.description).toMatch(/seller.*identif/i);
    expect(result.listing.description).not.toContain("V3");
    expect(result.identification?.label).toMatch(/seller-stated/i);
    expect(result.identification?.confident).toBe(false);
    expect(result.attributes.identityVariantUncertain).toBe(true);
    const photoIdentified = priceToConfidence({ ...result.attributes, identitySource: "photos" }, result.price, { autopilotEnabled: false });
    expect(result.confidence.score).toBeLessThan(photoIdentified.score);
  });

  it("retains the photo identity when the spoken keyboard family is contradicted", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({ status: "SUCCEEDED", items: [] }));
    const stages = createVisionPipelineStages({
      supabase: fakeDownloadClient(),
      generate: async () => ({
        brand: "Keychron", model: "K2", category: "Mechanical keyboard", condition: "good",
        title: "Keychron K2 Mechanical Keyboard", ambiguous: false,
        sellerIdentity: {
          sourceText: "Raining 75", brand: "WOBKEY", model: "Rainy75",
          contradicted: true, variantUncertain: true,
        },
      }),
      priceItem: createDefaultPricer({
        apifySold: {
          enabled: true, token: "offline-placeholder", runActor,
          cache: createInMemoryTtlCache<ApifySoldComp[]>(60_000, Date.now, "shared"),
        },
        ebaySold: { enabled: false },
        llmOnly: { estimatePrice: async () => ({ suggested: 90, min: 55, max: 120 }) },
      }),
    });
    const sellerContext: SellerContext = { text: "This is my Raining 75.", language: "en", provenance: "seller_voice", verification: "unverified" };
    const identified = await stages.identify({ photos: ["user-1/keychron-label.jpg"], sellerContext });
    await stages.price({ attributes: identified.attributes, sellerContext });
    expect(identified.attributes).toMatchObject({ brand: "Keychron", model: "K2", identitySource: "photos" });
    expect(runActor).toHaveBeenCalled();
    expect(runActor.mock.calls.map(([request]) => request.input.keywords)).toEqual([
      ["Keychron K2"], ["Keychron K2"], ["Keychron Mechanical keyboard"],
    ]);
    expect(JSON.stringify(runActor.mock.calls)).not.toContain("WOBKEY");
  });

  it("records a genuinely unusable identity skip without invoking paid research", async () => {
    const runActor = vi.fn<RunApifySoldActor>();
    const emitDiagnostic = vi.fn();
    const stages = createVisionPipelineStages({
      supabase: fakeDownloadClient(),
      generate: async () => ({ category: "Electronics", title: "Generic keyboard", ambiguous: true }),
      priceItem: createDefaultPricer({
        apifySold: { enabled: true, token: "offline-placeholder", runActor, emitDiagnostic },
        ebaySold: { enabled: false },
        llmOnly: { estimatePrice: async () => ({ suggested: 90, min: 55, max: 120 }) },
      }),
    });
    const identified = await stages.identify({ photos: ["user-1/generic-keyboard.jpg"] });
    const price = await stages.price({ attributes: identified.attributes });
    expect(runActor).not.toHaveBeenCalled();
    expect(price.tier).toBe("llm-only");
    expect(emitDiagnostic).toHaveBeenCalledWith("pricing.sold_comps.strategy_skipped", { strategy: "apify-sold", reason: "signal-not-identifiable" });
  });
});
