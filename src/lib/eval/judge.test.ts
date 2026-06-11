import { describe, expect, it } from "vitest";
import {
  createHeuristicJudge,
  judgeAgreement,
  judgeScoresSchema,
  validateJudge,
  type HumanLabeledListing,
  type JudgeFn,
  type JudgeScores,
} from "./judge";
import { JUDGE_HUMAN_LABELS } from "./fixtures";
import type { JudgedListing } from "./types";

const strongListing: JudgedListing = {
  title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones Black Tested",
  description:
    "Sony WH-1000XM4 over-ear headphones in good used condition. Light wear on the ear " +
    "cushions, no scratches. 30-hour battery, multipoint Bluetooth. Includes case and cables.",
  itemSpecifics: { Brand: "Sony", Model: "WH-1000XM4" },
};

const strongAttrs = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
};

describe("createHeuristicJudge", () => {
  const judge = createHeuristicJudge();

  it("is deterministic and emits schema-valid 1-5 integer scores", async () => {
    const a = await judge({ listing: strongListing, attributes: strongAttrs });
    const b = await judge({ listing: strongListing, attributes: strongAttrs });
    expect(a).toEqual(b);
    expect(judgeScoresSchema.parse(a)).toEqual(a);
  });

  it("scores a strong, grounded listing at the top of the rubric", async () => {
    const scores = await judge({ listing: strongListing, attributes: strongAttrs });
    expect(scores).toEqual({ title: 5, description: 5, grounded: 5, overall: 5 });
  });

  it("caps grounded low when specifics assert a brand the core never established", async () => {
    const scores = await judge({
      listing: {
        title: "Starbucks Ceramic Coffee Mug 12oz White Kitchen",
        description: "White ceramic mug, 12 oz. Clean, no chips or cracks.",
        itemSpecifics: { Brand: "Starbucks" },
      },
      attributes: { category: "generic", condition: "good" },
    });
    expect(scores.grounded).toBe(2);
  });

  it("caps grounded low when the structured model contradicts the core", async () => {
    const scores = await judge({
      listing: {
        ...strongListing,
        itemSpecifics: { Brand: "Sony", Model: "WH-1000XM5" },
      },
      attributes: strongAttrs,
    });
    expect(scores.grounded).toBe(2);
  });

  it("penalizes a thin description and a title missing the item identity", async () => {
    const scores = await judge({
      listing: {
        title: "Nice headphones for sale right now",
        description: "Used. Works.",
        itemSpecifics: { Brand: "Sony" },
      },
      attributes: strongAttrs,
    });
    expect(scores.description).toBeLessThanOrEqual(2);
    expect(scores.title).toBeLessThanOrEqual(3);
  });

  it("penalizes an over-long title", async () => {
    const long = await judge({
      listing: {
        ...strongListing,
        title:
          "Sony WH-1000XM4 Wireless Noise Cancelling Bluetooth Over Ear Headphones " +
          "Black Excellent Tested Working Free Fast Shipping",
      },
      attributes: strongAttrs,
    });
    const normal = await judge({ listing: strongListing, attributes: strongAttrs });
    expect(long.title).toBeLessThan(normal.title);
  });
});

describe("judgeAgreement", () => {
  const score = (n: number): JudgeScores => ({
    title: n,
    description: n,
    grounded: n,
    overall: n,
  });

  it("computes meanAbsDiff, within-±1 and exact rates per dimension", () => {
    const judgeScores = [score(5), score(3), score(1)];
    const humanScores = [score(5), score(4), score(3)];
    const agreement = judgeAgreement(judgeScores, humanScores);
    expect(agreement.examples).toBe(3);
    // diffs: 0, 1, 2 → meanAbsDiff 1, within±1 2/3, exact 1/3 (same per dimension).
    expect(agreement.perDimension.title.meanAbsDiff).toBeCloseTo(1);
    expect(agreement.perDimension.title.within1Rate).toBeCloseTo(2 / 3);
    expect(agreement.perDimension.title.exactRate).toBeCloseTo(1 / 3);
    expect(agreement.overallWithin1Rate).toBeCloseTo(2 / 3);
  });

  it("throws on misaligned or empty score lists", () => {
    expect(() => judgeAgreement([score(3)], [])).toThrow(/aligned/);
    expect(() => judgeAgreement([], [])).toThrow(/at least one/);
  });
});

describe("validateJudge (offline, fake judge)", () => {
  it("runs the injected judge over the labeled subset and reports agreement", async () => {
    // A scripted FAKE judge: agrees exactly with the human label for every
    // example except one, where it is off by 2 on every dimension.
    const subset: HumanLabeledListing[] = JUDGE_HUMAN_LABELS.slice(0, 4);
    const offById = subset[0].id;
    const fakeJudge: JudgeFn = async ({ listing }) => {
      const example = subset.find((e) => e.listing.title === listing.title);
      if (!example) throw new Error("fake judge got an unknown listing");
      if (example.id === offById) {
        const shift = (n: number) => Math.max(1, Math.min(5, n - 2));
        return {
          title: shift(example.human.title),
          description: shift(example.human.description),
          grounded: shift(example.human.grounded),
          overall: shift(example.human.overall),
        };
      }
      return example.human;
    };

    const agreement = await validateJudge(fakeJudge, subset);
    expect(agreement.examples).toBe(4);
    // 3 of 4 exact, 1 off by two → within-±1 = 3/4 on every dimension.
    expect(agreement.overallWithin1Rate).toBeCloseTo(3 / 4);
    expect(agreement.perDimension.grounded.exactRate).toBeCloseTo(3 / 4);
  });

  it("validates the shipped heuristic judge against the shipped human labels", async () => {
    // The honesty gate on the DEFAULT offline judge: it must track the
    // human-labeled fixture within ±1 on the headline dimension, or the
    // fixture/heuristic pair has drifted and the report's verdicts are noise.
    const agreement = await validateJudge(createHeuristicJudge(), JUDGE_HUMAN_LABELS);
    expect(agreement.examples).toBeGreaterThanOrEqual(5);
    expect(agreement.overallWithin1Rate).toBeGreaterThanOrEqual(0.75);
    expect(agreement.perDimension.grounded.within1Rate).toBeGreaterThanOrEqual(0.75);
  });
});
