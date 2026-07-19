import { describe, it, expect, vi } from "vitest";
import { PriceRouter } from "./router";
import { priceResultSchema, type ItemSignal, type PriceResult, type PricingProvider, type PricingTier } from "./types";

/**
 * Test-only stub provider for exercising the router seam. Kept inline in the test
 * file (not under src/lib) so test scaffolding can never leak into a runtime
 * bundle. Builds a provider that HANDLES the signal (canned PriceResult stamped
 * with its tier) or DECLINES (null) so the router falls through.
 */
function makeStubProvider(
  tier: PricingTier,
  handles: (signal: ItemSignal) => boolean,
): PricingProvider {
  return {
    tier,
    price: async (signal: ItemSignal): Promise<PriceResult | null> => {
      if (!handles(signal)) return null;
      return {
        suggested: 10,
        range: { min: 5, max: 15 },
        confidence: 0.5,
        sources: [{ url: `https://stub.example/${tier}`, kind: tier }],
        tier,
      };
    },
  };
}

/**
 * Router behaviour is the primary pricing seam (PRD Testing Decisions): with
 * stubbed providers, assert the correct TIER is selected per ItemSignal and
 * that the router falls through in PRD priority order when a higher tier
 * DECLINES (returns null). The router takes its provider list by injection, so
 * a tier can be added/replaced without touching the router.
 */

const isbnSignal: ItemSignal = { isbn: "9780140328721" };
const upcSignal: ItemSignal = { upc: "036000291452", category: "kitchen" };
const brandedSignal: ItemSignal = { brand: "Sony", model: "WH-1000XM4", category: "electronics" };
const genericSignal: ItemSignal = { category: "home decor", conditionKnown: true };
const bareSignal: ItemSignal = {};

/** A full chain of providers, one per tier, that all handle their input. */
function fullChain(): PricingProvider[] {
  return [
    makeStubProvider("isbn-lookup", (s) => Boolean(s.isbn)),
    makeStubProvider("upc-aided-web", (s) => Boolean(s.upc)),
    makeStubProvider("branded-web", (s) => Boolean(s.brand && s.model)),
    makeStubProvider("depreciation", () => true),
    makeStubProvider("llm-only", () => true),
  ];
}

describe("PriceRouter tier selection", () => {
  it("selects the ISBN tier when an ISBN is present", async () => {
    const router = new PriceRouter(fullChain());
    const result = await router.price(isbnSignal);
    expect(result.tier).toBe("isbn-lookup");
  });

  it("selects the UPC-aided web tier when only a UPC is present", async () => {
    const router = new PriceRouter(fullChain());
    const result = await router.price(upcSignal);
    expect(result.tier).toBe("upc-aided-web");
  });

  it("selects the branded web tier for a recognizable brand+model", async () => {
    const router = new PriceRouter(fullChain());
    const result = await router.price(brandedSignal);
    expect(result.tier).toBe("branded-web");
  });

  it("falls to depreciation for a generic item", async () => {
    const router = new PriceRouter(fullChain());
    const result = await router.price(genericSignal);
    expect(result.tier).toBe("depreciation");
  });

  it("falls to llm-only as the ultimate fallback", async () => {
    // Only the llm-only provider handles anything.
    const router = new PriceRouter([
      makeStubProvider("isbn-lookup", () => false),
      makeStubProvider("upc-aided-web", () => false),
      makeStubProvider("branded-web", () => false),
      makeStubProvider("depreciation", () => false),
      makeStubProvider("llm-only", () => true),
    ]);
    const result = await router.price(bareSignal);
    expect(result.tier).toBe("llm-only");
  });
});

describe("PriceRouter fallthrough", () => {
  it("tries providers in the injected order and returns the first non-null", async () => {
    const calls: PricingTier[] = [];
    const spy = (tier: PricingTier, handles: boolean): PricingProvider => {
      const base = makeStubProvider(tier, () => handles);
      return {
        tier,
        price: async (s) => {
          calls.push(tier);
          return base.price(s);
        },
      };
    };

    // isbn declines, upc-aided declines, branded handles -> branded wins,
    // and the lower tiers must NOT be consulted.
    const router = new PriceRouter([
      spy("isbn-lookup", false),
      spy("upc-aided-web", false),
      spy("branded-web", true),
      spy("depreciation", true),
      spy("llm-only", true),
    ]);

    const result = await router.price(brandedSignal);
    expect(result.tier).toBe("branded-web");
    expect(calls).toEqual(["isbn-lookup", "upc-aided-web", "branded-web"]);
  });

  it("respects injected order even if it differs from PRD order (router is order-agnostic)", async () => {
    // The router does not hardcode priority; the caller supplies ordering.
    const router = new PriceRouter([
      makeStubProvider("llm-only", () => true),
      makeStubProvider("isbn-lookup", () => true),
    ]);
    const result = await router.price(isbnSignal);
    expect(result.tier).toBe("llm-only");
  });

  it("throws when every provider declines (no tier can price the item)", async () => {
    const router = new PriceRouter([
      makeStubProvider("isbn-lookup", () => false),
      makeStubProvider("llm-only", () => false),
    ]);
    await expect(router.price(bareSignal)).rejects.toThrow();
  });

  it("throws when constructed with no providers", () => {
    expect(() => new PriceRouter([])).toThrow();
  });
});

describe("PriceRouter contract & extensibility", () => {
  it("returns a result that validates against the PriceResult schema", async () => {
    const router = new PriceRouter(fullChain());
    const result = await router.price(brandedSignal);
    expect(() => priceResultSchema.parse(result)).not.toThrow();
  });

  it("a new provider can be added without changing the router", async () => {
    // A hypothetical extra tier reusing an existing identifier, injected ahead
    // of the rest — no router code changes, just a different provider list.
    const custom: PricingProvider = {
      tier: "branded-web",
      price: async (): Promise<PriceResult> => ({
        suggested: 999,
        range: { min: 900, max: 1100 },
        confidence: 0.5,
        sources: [{ url: "https://comps.example/sold" }],
        tier: "branded-web",
      }),
    };
    const router = new PriceRouter([custom, ...fullChain()]);
    const result = await router.price(brandedSignal);
    expect(result.suggested).toBe(999);
    expect(result.tier).toBe("branded-web");
  });

  it("treats a thrown provider as a hard error, not a silent decline", async () => {
    const boom: PricingProvider = {
      tier: "isbn-lookup",
      price: vi.fn(async () => {
        throw new Error("upstream isbn API down");
      }),
    };
    const router = new PriceRouter([boom, makeStubProvider("llm-only", () => true)]);
    await expect(router.price(isbnSignal)).rejects.toThrow(/isbn API down/);
  });

  it("throws if a provider returns a result stamped with a different tier", async () => {
    const mislabeled: PricingProvider = {
      tier: "isbn-lookup",
      price: async () => ({
        suggested: 10,
        range: { min: 5, max: 15 },
        confidence: 0.5,
        sources: [{ url: "https://x.example" }],
        tier: "branded-web",
      }),
    };
    const router = new PriceRouter([mislabeled]);
    await expect(router.price(isbnSignal)).rejects.toThrow(/tier/);
  });
});
