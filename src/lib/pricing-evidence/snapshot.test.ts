import { describe, expect, it } from "vitest";
import { pricingEvidenceSnapshotInputSchema } from "./snapshot";

describe("pricing-evidence snapshot write contract", () => {
  it("keeps provider-supplied sold facts in the immutable retained row", () => {
    const sourceUrl = "https://www.ebay.com/itm/complete-sold-facts";
    const snapshot = pricingEvidenceSnapshotInputSchema.parse({
      schema_version: 1,
      item: { title: "Sony WH-1000XM4", condition: "Used" },
      price_result: {
        suggested: 142.5,
        range: { min: 142.5, max: 142.5 },
        confidence: 0.8,
        sources: [{ url: sourceUrl, title: "Verified sale", kind: "sold-comp" }],
        tier: "ebay-sold",
      },
      evidence: [{
        id: sourceUrl,
        sourceUrl,
        title: "Verified sale",
        price: 142.5,
        currency: "USD",
        condition: "Used",
        soldAt: 1_785_283_200,
        photoUrl: "https://i.ebayimg.com/images/g/complete/s-l500.jpg",
        size: "One size",
        format: "buy-it-now",
        shipping: { type: "paid", price: 8.95, currency: "USD" },
        kind: "sold-comparable",
        priceDisclosure: "displayed-sold-price",
      }],
    });

    expect(snapshot.evidence).toEqual([
      expect.objectContaining({
        photoUrl: "https://i.ebayimg.com/images/g/complete/s-l500.jpg",
        size: "One size",
        format: "buy-it-now",
        shipping: { type: "paid", price: 8.95, currency: "USD" },
      }),
    ]);
  });

  it("rejects a sixth verified sold match", () => {
    const evidence = Array.from({ length: 6 }, (_, index) => ({
      id: `sale-${index}`,
      sourceUrl: `https://www.ebay.com/itm/sale-${index}`,
      title: `Verified sale ${index}`,
      price: 100 + index,
      currency: "USD",
      kind: "sold-comparable" as const,
      priceDisclosure: "displayed-sold-price" as const,
    }));

    const result = pricingEvidenceSnapshotInputSchema.safeParse({
      schema_version: 1,
      item: { title: "Sony WH-1000XM4", condition: "Used" },
      price_result: {
        suggested: 102,
        range: { min: 100, max: 105 },
        confidence: 0.8,
        sources: evidence.map((record) => ({
          url: record.sourceUrl,
          title: record.title,
          kind: "sold-comp",
        })),
        tier: "ebay-sold",
      },
      evidence,
    });

    expect(result.success).toBe(false);
  });
});
