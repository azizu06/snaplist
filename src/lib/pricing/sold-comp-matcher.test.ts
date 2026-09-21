import { describe, expect, it } from "vitest";
import type { ItemSignal } from "./types";
import {
  classifySoldComp,
  conditionOnlyHead,
  normalizeSoldCompCondition,
  selectSoldCompEvidence,
  soldCompRetrievalReason,
  selectVerifiedSoldMatches,
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
    ["Seller Refurbished", "refurbished"],
    ["Certified Refurbished", "refurbished"],
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

  it("does not anchor refurbished evidence for a known-used seller item", () => {
    const signal: ItemSignal = {
      brand: "Apple",
      model: "iPhone 14 Pro",
      specs: ["256GB"],
      condition: "used",
      conditionKnown: true,
    };

    const match = classifySoldComp(
      candidate("Apple iPhone 14 Pro 256GB", "Certified Refurbished"),
      signal,
    );

    expect(match.compCondition).toBe("refurbished");
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

  it("downgrades bundled or multiple extra accessories for a standalone target", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "PS5 Console",
      condition: "good",
    };

    for (const title of [
      "Sony PS5 Console Bundle with 2 Controllers",
      "Sony PS5 Console with 2 Controllers",
    ]) {
      const match = classifySoldComp(candidate(title, "Pre-Owned"), signal);

      expect(match.classification).toBe("corroboration");
      expect(match.reasons).toContain("composition-mismatch");
    }
  });

  it("still rejects accessory-only bundle rows", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "PS5",
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Sony PS5 Controller Bundle", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("reject");
    expect(match.reasons).toContain("accessory-mismatch");
  });

  it("rejects accessory-only rows even when they include another accessory", () => {
    const cases: Array<{ signal: ItemSignal; title: string }> = [
      {
        signal: {
          brand: "Apple",
          model: "iPhone 14 Pro",
          condition: "good",
        },
        title: "iPhone 14 Pro Case with Screen Protector",
      },
      {
        signal: {
          brand: "Sony",
          model: "WH-1000XM4",
          condition: "good",
        },
        title: "WH-1000XM4 Replacement Ear Pads with Case",
      },
    ];

    for (const { signal, title } of cases) {
      const match = classifySoldComp(candidate(title, "Pre-Owned"), signal);

      expect(match.classification).toBe("reject");
      expect(match.reasons).toContain("accessory-mismatch");
    }
  });

  it("keeps a genuine target bundle when its composition matches", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "PS5 Console Bundle",
      specs: ["2 Controllers"],
      condition: "good",
    };

    const match = classifySoldComp(
      candidate("Sony PS5 Console Bundle with 2 Controllers", "Pre-Owned"),
      signal,
    );

    expect(match.classification).toBe("anchor");
    expect(match.reasons).not.toContain("composition-mismatch");
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

  it("matches independent free-form specs regardless of title order", () => {
    const signal: ItemSignal = {
      brand: "Sony",
      model: "WH-1000XM4",
      specs: ["wireless", "noise cancelling", "over ear"],
      condition: "good",
    };

    const match = classifySoldComp(
      candidate(
        "Sony WH-1000XM4 Over-Ear Wireless Noise Cancelling Headphones",
        "Pre-Owned",
      ),
      signal,
    );

    expect(match.classification).toBe("anchor");
    expect(match.reasons).toContain("spec-equivalent");
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

/**
 * Issue #1120 acceptance 3 — the EVIDENCE behind keeping the title-only skip.
 *
 * A sold query built from the vision TITLE alone would reach a signal with no
 * `brand`, `model` or `resolvedName`. The matcher does not reject such comps; it
 * cannot verify them either. Every candidate comes back `identity-unverified`
 * corroboration, never an `anchor` — and `selectVerifiedSoldMatches` keeps ONLY
 * anchors. So an identity-less sold query is guaranteed to yield zero verified
 * matches no matter what it retrieves, which is why the tier keeps declining
 * instead of spending a retrieval to reach an empty set. Loosening the matcher to
 * accept unanchored comps is out of scope by the issue's own exclusions.
 */
describe("sold-comp matcher — an identity-less signal can never anchor (#1120)", () => {
  const anchored: ItemSignal = {
    brand: "Apple",
    model: "AirPods Pro",
    category: "electronics",
    condition: "very-good",
  };
  const identityLess: ItemSignal = {
    category: "true wireless earbuds with charging case",
    condition: "very-good",
  };
  const exactComp = candidate(
    "Apple AirPods Pro Wireless Earbuds with Charging Case",
    "Used",
  );

  it("anchors an exact comp while an identity is present", () => {
    const match = classifySoldComp(exactComp, anchored);
    expect(match.classification).toBe("anchor");
    expect(selectVerifiedSoldMatches([match])).toHaveLength(1);
  });

  it("cannot anchor that same comp once the identity is gone", () => {
    const match = classifySoldComp(exactComp, identityLess);
    expect(match.classification).not.toBe("anchor");
    expect(match.reasons).toContain("identity-unverified");
    expect(selectVerifiedSoldMatches([match])).toHaveLength(0);
  });
});

/**
 * Issue #1138, the third seam the same root cause reached.
 *
 * Treating vision attribute prose as configuration starved the eBay query and
 * evicted real specs from it — but it also reached the matcher. An unverifiable
 * spec withholds identity verification (a seller who says "32GB" and a title that
 * never says so might be the 64GB variant), and prose like "White" or "charging
 * case" can essentially never be confirmed from a title. So every genuine sale of
 * the owner's AirPods Pro was demoted from anchor to corroboration, and
 * `selectVerifiedSoldMatches` keeps anchors only — the tier reported "no verified
 * sold matches" while holding five perfectly good comps.
 *
 * Only a spec the matcher could actually verify may withhold verification.
 */
describe("descriptive specs must not suppress anchors (#1138)", () => {
  const AIRPODS_COMPS = [
    { url: "https://www.ebay.com/itm/1", title: "Apple AirPods Pro with MagSafe Charging Case", price: 148, condition: "Pre-Owned" },
    { url: "https://www.ebay.com/itm/2", title: "Apple AirPods Pro Wireless Earbuds with Charging Case", price: 139.99, condition: "Pre-Owned" },
    { url: "https://www.ebay.com/itm/3", title: "Apple AirPods Pro - White - Very Good Condition", price: 152.5, condition: "Pre-Owned" },
  ];
  const signal = (specs: string[]): ItemSignal => ({
    brand: "Apple",
    model: "AirPods Pro",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    specs,
  });

  it("anchors genuine comps even when the vision step supplied prose specs", () => {
    const evidence = selectSoldCompEvidence(AIRPODS_COMPS, signal([
      "White",
      "charging case",
      "Silicone ear tips",
    ]));

    expect(evidence.anchors).toHaveLength(3);
    // Identical to the same comps with no specs at all: prose adds no
    // information, so it must subtract none either.
    expect(evidence.anchors).toHaveLength(
      selectSoldCompEvidence(AIRPODS_COMPS, signal([])).anchors.length,
    );
  });

  it("still withholds verification when a REAL configuration spec is unconfirmed", () => {
    // A seller-stated capacity the title never confirms may be the other variant,
    // which is exactly the demotion this gate exists for.
    const laptops = [
      { url: "https://www.ebay.com/itm/4", title: "Dell XPS 15 Laptop Core i7", price: 900, condition: "Pre-Owned" },
    ];
    const evidence = selectSoldCompEvidence(laptops, {
      brand: "Dell",
      model: "XPS 15",
      category: "electronics",
      condition: "very-good",
      conditionKnown: true,
      specs: ["1TB SSD"],
    });

    expect(evidence.anchors).toHaveLength(0);
    expect(evidence.corroboration).toHaveLength(1);
  });
});

/**
 * Issue #1138: "<accessory> for <product>" is an accessory listing.
 *
 * `accessoryMismatch` clears a comp whose accessory the seller's own identity
 * text also names — but `identityText` includes `signal.specs`, so vision prose
 * ("Silicone ear tips", "charging case") was unlocking the accessory list on the
 * seller's behalf. An $8.99 ear-tips listing anchored at full score against a
 * $148 pair of AirPods Pro.
 */
describe("compatibility listings are accessories (#1138)", () => {
  const signal: ItemSignal = {
    brand: "Apple",
    model: "AirPods Pro",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    // The seller's own prose must not license an accessory comp.
    specs: ["White", "charging case", "Silicone ear tips"],
  };

  it("rejects a listing whose identity appears only after 'for'", () => {
    const evidence = selectSoldCompEvidence(
      [
        { url: "https://www.ebay.com/itm/tips", title: "Silicone Ear Tips for Apple AirPods Pro - 3 Pairs S/M/L", price: 8.99, condition: "New" },
        { url: "https://www.ebay.com/itm/skin", title: "Protective Case Cover for Apple AirPods Pro Skin", price: 6.5, condition: "New" },
      ],
      signal,
    );

    expect(evidence.anchors).toHaveLength(0);
    expect(evidence.rejected.map((match) => match.reasons)).toEqual([
      expect.arrayContaining(["accessory-mismatch"]),
      expect.arrayContaining(["accessory-mismatch"]),
    ]);
  });

  it("does not catch a real item that merely says 'for parts'", () => {
    // The identity is stated UP FRONT, so this is the product; the parts rule —
    // not the accessory rule — is what should decide it.
    const evidence = selectSoldCompEvidence(
      [{ url: "https://www.ebay.com/itm/parts", title: "Apple AirPods Pro for Parts Not Working", price: 29.99, condition: "For parts or not working" }],
      signal,
    );

    expect(evidence.rejected).toHaveLength(1);
    expect(evidence.rejected[0]!.reasons).toContain("parts-mismatch");
    expect(evidence.rejected[0]!.reasons).not.toContain("accessory-mismatch");
  });

  it("keeps a genuine sale that bundles the accessory the seller also has", () => {
    const evidence = selectSoldCompEvidence(
      [{ url: "https://www.ebay.com/itm/real", title: "Apple AirPods Pro with MagSafe Charging Case", price: 148, condition: "Pre-Owned" }],
      signal,
    );

    expect(evidence.anchors).toHaveLength(1);
  });
});

/**
 * Issue #1138 round 1 review: `compatibilityListing` was too broad, and because
 * it rejects comps it changes prices.
 *
 * Requiring only "the identity appears after 'for' and not before it" catches
 * every seller who leads with condition language — "Tested Working for Apple
 * AirPods Pro", "Sold as-is for ..." — and those are the real item, often the
 * cheap end of it. Dropping them biases the median upward.
 *
 * The signal that actually means "accessory" is an accessory NOUN at the head of
 * the title, before the "for". That is what eBay sellers write, and it is the
 * matcher's own vocabulary rather than a new list.
 */
describe("compatibility listings need an accessory head (#1138 review)", () => {
  const signal: ItemSignal = {
    brand: "Apple",
    model: "AirPods Pro",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    specs: ["White", "charging case", "Silicone ear tips"],
  };
  const classify = (title: string) =>
    selectSoldCompEvidence(
      [{ url: `https://www.ebay.com/itm/${encodeURIComponent(title)}`, title, price: 145, condition: "Pre-Owned" }],
      signal,
    );

  it.each([
    "Tested Working for Apple AirPods Pro Wireless Earbuds",
    "Excellent Condition for Apple AirPods Pro",
    "Sold as-is for Apple AirPods Pro",
    "New Sealed for Apple AirPods Pro 2nd Gen",
  ])("never calls condition language an accessory: %s", (title) => {
    expect(classify(title).rejected.flatMap((match) => match.reasons)).not.toContain(
      "accessory-mismatch",
    );
  });

  it.each([
    "Tested Working for Apple AirPods Pro Wireless Earbuds",
    "Excellent Condition for Apple AirPods Pro",
    "New Sealed for Apple AirPods Pro 2nd Gen",
  ])("anchors the real item behind that condition language: %s", (title) => {
    expect(classify(title).anchors).toHaveLength(1);
  });

  it("leaves 'Sold as-is' to the parts rule, which is a different question", () => {
    // "as is" matches PARTS_RE, so this comp is rejected as `parts-mismatch`
    // against a very-good seller item. That is pre-existing, deliberate, and
    // unrelated to the accessory rule — the point here is only that the
    // accessory rule does not ALSO claim it.
    const evidence = classify("Sold as-is for Apple AirPods Pro");
    expect(evidence.rejected[0]!.reasons).toContain("parts-mismatch");
    expect(evidence.rejected[0]!.reasons).not.toContain("accessory-mismatch");
  });

  it.each([
    "Silicone Ear Tips for Apple AirPods Pro",
    "Charging Case for AirPods Pro",
    "Protective Case Cover for Apple AirPods Pro Skin",
  ])("still rejects an accessory head: %s", (title) => {
    const evidence = classify(title);
    expect(evidence.anchors).toHaveLength(0);
    expect(evidence.rejected[0]!.reasons).toContain("accessory-mismatch");
  });
});

/**
 * Issue #1138 round 1 review (P3): "every comp was demoted" is not
 * "every comp was rejected", and reporting the first as
 * `all-rejected:identity-unverified` names a reject reason no comp actually
 * carried. Corroboration means the comps were real and merely too weak to
 * anchor — a different operator response from a matcher that threw them out.
 */
describe("soldCompRetrievalReason distinguishes demotion from rejection (#1138 review)", () => {
  const evidence = (over: Partial<Parameters<typeof soldCompRetrievalReason>[0]>) =>
    soldCompRetrievalReason({ anchors: [], corroboration: [], rejected: [], ...over });
  const match = (reasons: string[]) =>
    ({ comp: { price: 1 }, classification: "reject", score: 0, sellerCondition: "unknown", compCondition: "unknown", reasons }) as never;

  it("reports no-anchors when comps survived but none anchored", () => {
    expect(evidence({ corroboration: [match(["spec-unverified"])] })).toBe("no-anchors");
  });

  it("reports the modal reject reason when comps were actually rejected", () => {
    expect(
      evidence({
        rejected: [
          match(["identity-mismatch"]),
          match(["identity-mismatch"]),
          match(["accessory-mismatch"]),
        ],
      }),
    ).toBe("all-rejected:identity-mismatch");
  });

  it("breaks a 1-vs-1 tie by declaration order, not by which arrived first", () => {
    // One reject each: the counts tie at 1. `Map` iterates in INSERTION order,
    // so reading the tally that way would return whichever comp the matcher
    // happened to classify first — here `quantity-mismatch`, which is declared
    // LAST of the two. SOLD_COMP_MATCH_REASONS decides instead, so the answer is
    // stable across two runs that differ only in candidate order.
    expect(
      evidence({ rejected: [match(["quantity-mismatch"]), match(["spec-conflict"])] }),
    ).toBe("all-rejected:spec-conflict");
    expect(
      evidence({ rejected: [match(["spec-conflict"]), match(["quantity-mismatch"])] }),
    ).toBe("all-rejected:spec-conflict");
  });

  it("reports no-candidates when the matcher was handed nothing", () => {
    expect(evidence({})).toBe("no-candidates");
  });

  it("reports nothing at all once a comp anchors", () => {
    expect(evidence({ anchors: [match([])], rejected: [match(["identity-mismatch"])] })).toBeNull();
  });
});

/**
 * Issue #1138 round 2 review: requiring an accessory NOUN in the head reopened
 * the pollution it was meant to close.
 *
 * `ACCESSORY_WORDS` is a curated list, not a taxonomy of everything sold "for"
 * something else, so "Battery for Dell XPS 15" and "Tempered Glass for iPhone 13"
 * cleared the head check and anchored a $9.99 accessory against the real item.
 * Widening the list would only move the boundary; there is no finite list of
 * accessory nouns.
 *
 * So the rule is inverted. "Identity only after ' for '" REJECTS by default —
 * that is what "for X" means on eBay — and the exemptions are the two narrow,
 * nameable cases: a head made purely of condition/grade/lot language, and a head
 * that declares the accessory is INCLUDED with the item.
 */
describe("compatibility listings reject by default (#1138 round 2)", () => {
  const classifyFor = (signal: ItemSignal, title: string, price = 9.99) =>
    selectSoldCompEvidence(
      [
        {
          url: `https://www.ebay.com/itm/${encodeURIComponent(title)}`,
          title,
          price,
          condition: "Pre-Owned",
        },
      ],
      signal,
    );

  const laptop: ItemSignal = {
    brand: "Dell",
    model: "XPS 15",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    specs: ["Silver", "32GB", "1TB SSD"],
  };
  const camera: ItemSignal = {
    brand: "Canon",
    model: "EOS R6",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    specs: ["Body only", "Black"],
  };
  const controller: ItemSignal = {
    brand: "Sony",
    model: "PS5 Controller",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    specs: ["White"],
  };
  const phone: ItemSignal = {
    brand: "Apple",
    model: "iPhone 13",
    category: "electronics",
    condition: "very-good",
    conditionKnown: true,
    specs: ["128GB", "Blue"],
  };

  const POLLUTANTS: [ItemSignal, string][] = [
    [laptop, "Battery for Dell XPS 15"],
    [camera, "Lens for Canon EOS R6"],
    [controller, "Skin for PS5 Controller"],
    [camera, "Manual for Canon EOS R6"],
    [phone, "Tempered Glass for iPhone 13"],
  ];

  it.each(POLLUTANTS)(
    "never anchors a $9.99 accessory against the real item: %#",
    (signal, title) => {
      expect(classifyFor(signal, title).anchors).toHaveLength(0);
    },
  );

  it.each(POLLUTANTS.filter(([, title]) => title !== "Lens for Canon EOS R6"))(
    "rejects it as an accessory, though its noun is not in ACCESSORY_WORDS: %#",
    (signal, title) => {
      expect(classifyFor(signal, title).rejected[0]!.reasons).toContain("accessory-mismatch");
    },
  );

  it("lets the spec rule decide the lens, which reaches the same outcome first", () => {
    // The seller's camera is "Body only", so a lens listing conflicts on specs
    // before the accessory rule is consulted. Both rules reject it; asserting
    // `accessory-mismatch` here would be asserting the wrong rule fired, so this
    // records which one actually does.
    const evidence = classifyFor(camera, "Lens for Canon EOS R6");
    expect(evidence.rejected[0]!.reasons).toContain("spec-conflict");
    expect(evidence.anchors).toHaveLength(0);
  });

  it.each([
    "Tested Working for Apple AirPods Pro",
    "Excellent Condition for Apple AirPods Pro",
    "New Sealed for Apple AirPods Pro 2nd Gen",
    "With Case for Apple AirPods Pro",
  ])("exempts a condition or included-accessory head: %s", (title) => {
    const airpods: ItemSignal = {
      brand: "Apple",
      model: "AirPods Pro",
      category: "electronics",
      condition: "very-good",
      conditionKnown: true,
      specs: ["White", "charging case"],
    };
    expect(
      classifyFor(airpods, title, 145).rejected.flatMap((match) => match.reasons),
    ).not.toContain("accessory-mismatch");
  });

  it.each([
    "Silicone Ear Tips for Apple AirPods Pro",
    "Charging Case for Apple AirPods Pro",
    "Replacement Left Bud for Apple AirPods Pro",
    "Box only for Apple AirPods Pro",
  ])("still rejects a genuine accessory head: %s", (title) => {
    const airpods: ItemSignal = {
      brand: "Apple",
      model: "AirPods Pro",
      category: "electronics",
      condition: "very-good",
      conditionKnown: true,
      specs: ["White", "charging case", "Silicone ear tips"],
    };
    const evidence = classifyFor(airpods, title);
    expect(evidence.anchors).toHaveLength(0);
    expect(evidence.rejected[0]!.reasons).toContain("accessory-mismatch");
  });
});


/**
 * The head exemption must stay tied to the condition vocabulary it claims to
 * reuse (#1138 round 2).
 *
 * `conditionOnlyHead` is a second reader of the same idea as
 * `normalizeSoldCompCondition`. If someone teaches the classifier a new grade
 * and not this, a real listing starts being called an accessory and its price
 * disappears — silently, because the comp is simply gone. This asserts the two
 * agree on every grade phrase that can lead a title.
 */
describe("the head exemption reuses the condition vocabulary (#1138 round 2)", () => {
  const GRADES = [
    "brand new",
    "new",
    "new with tags",
    "new without tags",
    "new in box",
    "factory sealed",
    "sealed",
    "unopened",
    "open box",
    "like new",
    "near mint",
    "mint condition",
    "refurbished",
    "remanufactured",
    "pre owned",
    "used",
    "very good",
    "good",
    "excellent",
    "acceptable",
    "fair",
    "poor",
    "heavily used",
  ];

  it.each(GRADES)("the condition classifier recognises %s", (grade) => {
    expect(normalizeSoldCompCondition(grade)).not.toBe("unknown");
  });

  it.each(GRADES)("and it clears the head check: %s", (grade) => {
    expect(conditionOnlyHead(grade)).toBe(true);
  });

  it.each(["box", "box only", "case", "silicone ear tips", "replacement left bud", "lens"])(
    "a scope or accessory noun does not clear it: %s",
    (head) => {
      expect(conditionOnlyHead(head)).toBe(false);
    },
  );

  it("an empty head is a compatibility claim, not condition language", () => {
    expect(conditionOnlyHead("")).toBe(false);
  });
});
