import { describe, expect, it } from "vitest";
import {
  buyerQuestionCandidates,
  itemLabel,
  simulateBuyerQuestion,
} from "./simulate";
import type { ReplyGrounding } from "./types";

/**
 * Pure unit tests for the simulated buyer-question generator (issue #13). No
 * database, no network: determinism comes from the injected `random`.
 */

const fullGrounding: ReplyGrounding = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    specs: ["wireless", "noise-cancelling"],
    title: "Sony WH-1000XM4 Wireless Headphones",
  },
  listing: {
    title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones — Good",
    description: "Lightly used pair of WH-1000XM4s.",
  },
};

const bareGrounding: ReplyGrounding = { attributes: {}, listing: null };

describe("itemLabel", () => {
  it("prefers brand + model", () => {
    expect(itemLabel(fullGrounding)).toBe("Sony WH-1000XM4");
  });

  it("falls back to attribute title, then listing title, then a generic label", () => {
    expect(
      itemLabel({ attributes: { title: "Blue Mug" }, listing: null }),
    ).toBe("Blue Mug");
    expect(
      itemLabel({ attributes: {}, listing: { title: "Mystery Box", description: "" } }),
    ).toBe("Mystery Box");
    expect(itemLabel(bareGrounding)).toBe("the item");
  });
});

describe("buyerQuestionCandidates", () => {
  it("only offers attribute-specific questions when the fact exists", () => {
    const bare = buyerQuestionCandidates(bareGrounding);
    // Generic marketplace questions only — nothing referencing absent facts.
    expect(bare).toHaveLength(3);
    for (const q of bare) {
      expect(q).not.toContain("condition is");
      expect(q).not.toContain("genuine");
    }

    const full = buyerQuestionCandidates(fullGrounding);
    expect(full.some((q) => q.includes('"good"'))).toBe(true);
    expect(full.some((q) => q.includes("genuine Sony WH-1000XM4"))).toBe(true);
    expect(full.some((q) => q.includes('"wireless"'))).toBe(true);
  });

  it("grounds every candidate in the item label", () => {
    const generic = buyerQuestionCandidates(fullGrounding).slice(0, 3);
    for (const q of generic) {
      expect(q).toContain("Sony WH-1000XM4");
    }
  });
});

describe("simulateBuyerQuestion", () => {
  it("is deterministic under an injected random", () => {
    const first = simulateBuyerQuestion(fullGrounding, () => 0);
    expect(first).toBe(buyerQuestionCandidates(fullGrounding)[0]);

    const last = simulateBuyerQuestion(fullGrounding, () => 0.999999);
    const candidates = buyerQuestionCandidates(fullGrounding);
    expect(last).toBe(candidates[candidates.length - 1]);
  });

  it("clamps a degenerate random value into the candidate range", () => {
    expect(() => simulateBuyerQuestion(fullGrounding, () => 1)).not.toThrow();
    const q = simulateBuyerQuestion(fullGrounding, () => 1);
    expect(buyerQuestionCandidates(fullGrounding)).toContain(q);
  });
});
