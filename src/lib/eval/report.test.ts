import { describe, expect, it } from "vitest";
import { formatReport, runEval } from "./report";
import { parseArgs } from "./run";
import { predictionFromLogRow, type GoldItem } from "./types";
import { GOLD_SET, JUDGE_HUMAN_LABELS, SAMPLE_PREDICTIONS } from "./fixtures";
import type { JudgeFn } from "./judge";
import type { PredictionLogRow } from "../pipeline/prediction-log";

/** A constant fake judge — keeps runEval fully offline and deterministic. */
const fakeJudge: JudgeFn = async () => ({
  title: 4,
  description: 4,
  grounded: 5,
  overall: 4,
});

describe("runEval", () => {
  const goldSet: GoldItem[] = [
    {
      id: "g1",
      truth: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
      priceBand: { low: 100, high: 200 },
    },
    {
      id: "g2",
      truth: { brand: "Bose", model: "QC35 II", category: "electronics" },
      priceBand: { low: 80, high: 140 },
    },
    {
      id: "g3",
      truth: { category: "generic" },
      priceBand: { low: 5, high: 15 },
    },
  ];

  it("assembles all four metric families plus judge validation", async () => {
    const report = await runEval({
      gold: goldSet,
      predictions: [
        {
          goldId: "g1",
          attrs: { brand: "Sony", model: "WH-1000XM4" },
          price: 150,
          confidence: 0.85,
          tierFired: "branded-web",
          listing: { title: "Sony WH-1000XM4 Headphones", description: "Good condition." },
        },
        {
          goldId: "g2",
          attrs: { brand: "Bose" }, // model missing
          price: 300, // out of band
          confidence: 0.8,
          tierFired: "branded-web",
          // no listing → skipped by the judge
        },
      ],
      judge: fakeJudge,
      judgeName: "fake",
      humanLabels: JUDGE_HUMAN_LABELS,
    });

    expect(report.goldSetSize).toBe(3);
    expect(report.evaluated).toBe(2);
    expect(report.missingGoldIds).toEqual(["g3"]);
    expect(report.unmatchedGoldIds).toEqual([]);
    expect(report.tierDistribution).toEqual({ "branded-web": 2 });

    // ID: brand 2/2; model 1/2 (g2 missing); category 0 evaluated (none predicted).
    expect(report.id.perField.brand.accuracy).toBe(1);
    expect(report.id.perField.model.accuracy).toBe(0.5);

    // Pricing: g1 within, g2 out.
    expect(report.pricing.withinBand).toBe(1);
    expect(report.pricing.pctWithinBand).toBeCloseTo(0.5);

    // Calibration: both land in the top bucket; g1 correct, g2 not.
    const top = report.calibration.buckets.at(-1);
    expect(top?.count).toBe(2);
    expect(top?.observedAccuracy).toBeCloseTo(0.5);

    // Listing: one judged, one skipped; constant fake scores; agreement present.
    expect(report.listing.judge).toBe("fake");
    expect(report.listing.judged).toBe(1);
    expect(report.listing.skippedNoListing).toBe(1);
    expect(report.listing.meanScores).toEqual({
      title: 4,
      description: 4,
      grounded: 5,
      overall: 4,
    });
    expect(report.listing.agreement.examples).toBe(JUDGE_HUMAN_LABELS.length);
  });

  it("runs the full shipped fixtures offline (the `pnpm eval` default path)", async () => {
    const report = await runEval({
      gold: GOLD_SET,
      predictions: SAMPLE_PREDICTIONS,
      judge: fakeJudge,
      judgeName: "fake",
      humanLabels: JUDGE_HUMAN_LABELS,
    });
    expect(report.evaluated).toBe(GOLD_SET.length);
    expect(report.missingGoldIds).toEqual([]);
    expect(report.pricing.pctWithinBand).toBeGreaterThan(0);
    expect(report.calibration.ece).not.toBeNull();
  });
});

describe("formatReport", () => {
  it("renders every metric section", async () => {
    const report = await runEval({
      gold: GOLD_SET,
      predictions: SAMPLE_PREDICTIONS,
      judge: fakeJudge,
      judgeName: "fake",
      humanLabels: JUDGE_HUMAN_LABELS,
    });
    const text = formatReport(report);
    expect(text).toContain("SnapList eval report");
    expect(text).toContain("ID field accuracy");
    expect(text).toContain("Pricing");
    expect(text).toContain("Confidence calibration");
    expect(text).toContain("Listing quality (judge: fake)");
    expect(text).toContain("ECE:");
    expect(text).toContain("judge validation vs");
  });
});

describe("predictionFromLogRow", () => {
  const row: PredictionLogRow = {
    user_id: "user-1",
    item_id: "item-uuid-1",
    extracted_attrs: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
    price: 150,
    price_range: { low: 120, high: 180 },
    confidence: 0.85,
    tier_fired: "branded-web",
    model: "gpt-5.5",
    listing_model: "gpt-5.5",
    pricing_model: null,
    run_id: null,
    sources: [],
  };

  it("maps a logged row onto the eval shape via the itemId → goldId mapping", () => {
    const mapping = new Map([["item-uuid-1", "g1"]]);
    const listing = { title: "Sony WH-1000XM4", description: "Good." };
    expect(predictionFromLogRow(row, mapping, listing)).toEqual({
      goldId: "g1",
      attrs: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
      price: 150,
      confidence: 0.85,
      tierFired: "branded-web",
      model: "gpt-5.5",
      listing,
    });
  });

  it("returns null for a row whose item is not in the gold set", () => {
    expect(predictionFromLogRow(row, new Map())).toBeNull();
  });
});

describe("parseArgs", () => {
  it("parses the supported flags", () => {
    expect(parseArgs([])).toEqual({ db: false, realJudge: false, json: false });
    expect(parseArgs(["--predictions", "p.json", "--real-judge", "--json"])).toEqual({
      predictionsPath: "p.json",
      db: false,
      realJudge: true,
      json: true,
    });
    expect(parseArgs(["--db"]).db).toBe(true);
  });

  it("rejects unknown flags, a missing path, and --db with --predictions", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--predictions"])).toThrow(/requires a file path/);
    expect(() => parseArgs(["--predictions", "--json"])).toThrow(/requires a file path/);
    expect(() => parseArgs(["--db", "--predictions", "p.json"])).toThrow(/mutually exclusive/);
  });
});
