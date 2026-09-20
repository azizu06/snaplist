import { describe, expect, it } from "vitest";
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
