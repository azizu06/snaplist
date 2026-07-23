import { describe, expect, it } from "vitest";
import { pricingEvidenceSnapshotInputSchema } from "./snapshot";

describe("pricing-evidence snapshot write contract", () => {
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
