import { describe, expect, it } from "vitest";
import type { ItemSignal } from "./types";
import {
  classifySoldComp,
  normalizeSoldCompCondition,
  selectSoldCompEvidence,
  type SoldCompCandidate,
} from "./sold-comp-matcher";

const candidate = (
  title: string,
  condition?: string,
  extras: Partial<SoldCompCandidate> = {},
): SoldCompCandidate => ({
  title,
  price: 100,
  ...(condition ? { condition } : {}),
  ...extras,
});

describe("normalizeSoldCompCondition", () => {
  it.each([
    ["Brand New", "new"],
    ["New with tags", "new"],
    ["Open box", "open-box"],
    ["Like New", "like-new"],
    ["Pre-Owned", "used-good"],
    ["Very Good", "used-good"],
    ["Good", "used-good"],
    ["Acceptable", "used-fair"],
    ["For parts or not working", "parts"],
    [undefined, "unknown"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeSoldCompCondition(input)).toBe(expected);
  });
});

describe("classifySoldComp", () => {
  it("accepts equivalent generation and storage expressions as an anchor", () => {
    const signal: ItemSignal = {
      brand: "Amazon",
      model: "Kindle Paperwhite 11th Generation",
      specs: ["128GB"],
      condition: "like new",
      conditionKnown: true,
    };

    const match = classifySoldComp(
      candidate("Amazon Kindle Paperwhite 11th Gen 128 GB Wi-Fi", "Like New"),
      signal,
    );

    expect(match.classification).toBe("anchor");
    expect(match.reasons).toContain("identity-equivalent");
    expect(match.reasons).toContain("condition-same");
  });

  it("allows a nearby condition as a lower-weight anchor", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "like new",
      conditionKnown: true,
    };

    const match = classifySoldComp(
      candidate("Apple iPhone 14 Pro 256 GB", "Open Box"),
      signal,
    );

    expect(match.classification).toBe("anchor");
    expect(match.score).toBeLessThan(1);
    expect(match.reasons).toContain("condition-adjacent");
  });

  it("keeps a distant but valid condition only as corroboration", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "new",
      conditionKnown: true,
    };

    const match = classifySoldComp(
      candidate("Apple iPhone 14 Pro 256GB", "Used"),
      signal,
    );

    expect(match.classification).toBe("corroboration");
    expect(match.reasons).toContain("condition-distant");
  });

  it("does not anchor known-new evidence when the seller condition is unknown", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "WH-1000XM4",
    };

    const match = classifySoldComp(
      candidate("Sony WH-1000XM4 Wireless Headphones", "Brand New"),
      signal,
    );

    expect(match.classification).toBe("corroboration");
    expect(match.reasons).toContain("condition-unknown");
  });

  it("does not reject new inventory merely because the old pipeline was used-first", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "WH-1000XM4",
      condition: "brand new",
      conditionKnown: true,
    };

    expect(
      classifySoldComp(
        candidate("NEW Sony WH-1000XM4 Wireless Headphones", "Brand New"),
        signal,
      ).classification,
    ).toBe("anchor");
  });

  it("rejects a materially different model variant", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Apple iPhone 14 Pro Max 256GB", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("reject");
    expect(match.reasons).toContain("variant-conflict");
  });

  it("rejects a contradictory capacity while accepting spacing equivalents", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "good",
    };

    expect(
      classifySoldComp(
        candidate("Apple iPhone 14 Pro 128 GB", "Pre-Owned"),
        signal,
      ).reasons,
    ).toContain("spec-conflict");
  });

  it("keeps an accessory that is the seller's actual product but rejects its case", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "DualSense Wireless Controller",
      category: "video-games",
      condition: "good",
    };

    expect(
      classifySoldComp(
        candidate("Sony DualSense Wireless Controller White", "Used"),
        signal,
      ).classification,
    ).toBe("anchor");
    expect(
      classifySoldComp(
        candidate("Case for Sony DualSense Wireless Controller", "Used"),
        signal,
      ).reasons,
    ).toContain("accessory-mismatch");
  });

  it("keeps an included accessory without treating it as an accessory-only sale", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "PS5",
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Sony PS5 Disc Console with DualSense Controller", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("anchor");
    expect(match.reasons).not.toContain("accessory-mismatch");
  });

  it("keeps material but missing specs out of the price-anchor set", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Apple iPhone 14 Pro Smartphone", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("corroboration");
    expect(match.reasons).toContain("spec-unverified");
  });

  it.each([
    ["Body Only", "Canon EOS 80D Body Only"],
    ["Complete", "LEGO 75192 Millennium Falcon Complete Set"],
    ["Sealed", "LEGO 40516 Everyone Is Awesome Factory Sealed"],
  ])("recognizes %s composition evidence instead of treating it as missing", (spec, title) => {
    const signal: ItemSignal = {
      brand: spec === "Body Only" ? "Canon" : "LEGO",
      model: spec === "Body Only" ? "EOS 80D" : title.includes("75192")
        ? "75192 Millennium Falcon"
        : "40516 Everyone Is Awesome",
      specs: [spec],
      condition: spec === "Sealed" ? "new" : "good",
    };

    const match = classifySoldComp(
      candidate(title, spec === "Sealed" ? "Brand New" : "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("anchor");
    expect(match.reasons).toContain("spec-equivalent");
  });

  it("requires barcode-only evidence to expose the exact identifier before anchoring", () => {
    const signal: ItemSignal = {
      isbn: "9780140328721",
      condition: "good",
    };

    expect(
      classifySoldComp(candidate("Matilda by Roald Dahl Paperback", "Pre-Owned"), signal)
        .classification,
    ).toBe("corroboration");
    expect(
      classifySoldComp(
        candidate("Matilda by Roald Dahl ISBN 9780140328721", "Pre-Owned"),
        signal,
      ).classification,
    ).toBe("anchor");
  });

  it("rejects youth sizing when the seller's sneaker is not a youth variant", () => {
    const signal: ItemSignal = {
      brand: "Adidas",
      model: "Yeezy Boost 350 V2 Zebra",
      specs: ["Size 10"],
      category: "sneakers",
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Adidas Yeezy Boost 350 V2 Zebra Youth GS Size 10", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("reject");
    expect(match.reasons).toContain("spec-conflict");
  });

  it("rejects a materially different apparel form even when the brand matches", () => {
    const signal: ItemSignal = {
      brand: "Patagonia",
      model: "Better Sweater Jacket",
      specs: ["Full Zip"],
      category: "clothing",
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Patagonia Better Sweater Vest Full Zip", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("reject");
    expect(match.reasons).toContain("variant-conflict");
  });

  it("treats jacket as a compatible form for a full-zip sweater identity", () => {
    const signal: ItemSignal = {
      brand: "Patagonia",
      model: "Better Sweater Full Zip",
      specs: ["Mens Medium"],
      category: "clothing",
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Patagonia Better Sweater Full Zip Jacket Mens Medium", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("anchor");
  });

  it("downgrades an incomplete identity to corroboration instead of hard rejection", () => {
    const signal: ItemSignal = {
      brand: "Leatherman",
      model: "Wave Plus Multitool",
      condition: "good",
    };

    const match = classifySoldComp(candidate("Leatherman Wave+", "Used"), signal);

    expect(match.classification).not.toBe("reject");
  });

  it("rejects conflicting shoe sizes but accepts common size syntax", () => {
    const signal: ItemSignal = {
      brand: "Adidas",
      model: "Yeezy Boost 350 V2 Zebra",
      specs: ["Size 10"],
      condition: "good",
    };

    expect(
      classifySoldComp(
        candidate("Adidas Yeezy Boost 350 V2 Zebra Sz 10", "Used"),
        signal,
      ).classification,
    ).toBe("anchor");
    expect(
      classifySoldComp(
        candidate("Adidas Yeezy Boost 350 V2 Zebra Size 10.5", "Used"),
        signal,
      ).reasons,
    ).toContain("spec-conflict");
  });

  it("rejects multi-unit, parts-only, and undisclosed Best Offer evidence", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "WH-1000XM4",
      condition: "good",
    };

    expect(
      classifySoldComp(candidate("Sony WH-1000XM4 2 Pack", "Used"), signal).reasons,
    ).toContain("quantity-mismatch");
    expect(
      classifySoldComp(candidate("Sony WH-1000XM4 For Parts", "For parts"), signal)
        .reasons,
    ).toContain("parts-mismatch");
    expect(
      classifySoldComp(
        candidate("Sony WH-1000XM4", "Used", {
          priceDisclosure: "asking-price-not-accepted-amount",
        }),
        signal,
      ).reasons,
    ).toContain("accepted-price-unknown");
  });
});

describe("selectSoldCompEvidence", () => {
  it("separates price anchors from weaker corroboration and rejected noise", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "like new",
      conditionKnown: true,
    };
    const comps = [
      candidate("Apple iPhone 14 Pro 256GB", "Like New", { price: 700 }),
      candidate("Apple iPhone 14 Pro 256 GB", "Open Box", { price: 740 }),
      candidate("Apple iPhone 14 Pro 256GB", "Acceptable", { price: 560 }),
      candidate("Apple iPhone 14 Pro Max 256GB", "Like New", { price: 920 }),
    ];

    const selected = selectSoldCompEvidence(comps, signal);

    expect(selected.anchors.map((entry) => entry.comp.price)).toEqual([700, 740]);
    expect(selected.corroboration.map((entry) => entry.comp.price)).toEqual([560]);
    expect(selected.rejected.map((entry) => entry.comp.price)).toEqual([920]);
  });
});
