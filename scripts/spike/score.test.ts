import { describe, expect, it } from "vitest";
import type { GoldFixture, PredictionRecord } from "./types";
import {
  discrimination,
  matchRows,
  medianAbsError,
  pctWithin,
  scoreSpike,
  summarizeByMeasurement,
} from "./score";

/**
 * Spike #104 scorer — pure-function tests. The scorer turns (gold, predictions)
 * into the numbers RESULTS.md reports and the GO/NO-GO verdict, so its arithmetic
 * is the one part of the spike that must be provably right.
 */

function gold(partial: Partial<GoldFixture> & { id: string }): GoldFixture {
  return {
    listing_url: "https://www.ebay.com/itm/1",
    image_url: "https://i.ebayimg.com/x/s-l1600.jpg",
    garment_type: "tshirt",
    size_label: "M",
    scale_cue: false,
    scale_cue_kind: null,
    measurements: {},
    measurement_source: "test",
    ...partial,
  };
}

function pred(
  fixtureId: string,
  measurements: Array<{
    name: "pit_to_pit" | "length" | "sleeve" | "shoulder" | "waist" | "inseam" | "rise" | "hip";
    value_in: number;
    method?: "reference-scaled" | "prior-based";
  }>,
): PredictionRecord {
  return {
    fixtureId,
    model: "test-model",
    ok: true,
    response: {
      garmentType: "tshirt",
      scaleReferenceFound: null,
      scaleReferenceKind: null,
      measurements: measurements.map((m) => ({
        name: m.name,
        value_in: m.value_in,
        tolerance_in: 1,
        method: m.method ?? "prior-based",
      })),
    },
  };
}

describe("matchRows", () => {
  it("pairs gold and predicted values per measurement, carrying the scale-cue flag", () => {
    const g = [
      gold({ id: "a", scale_cue: true, measurements: { pit_to_pit: 22, length: 28 } }),
      gold({ id: "b", measurements: { pit_to_pit: 20 } }),
    ];
    const p = [
      pred("a", [
        { name: "pit_to_pit", value_in: 21, method: "reference-scaled" },
        { name: "length", value_in: 30 },
      ]),
      pred("b", [{ name: "pit_to_pit", value_in: 20.5 }]),
    ];
    const rows = matchRows(g, p);
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.fixtureId === "a" && r.name === "pit_to_pit")!;
    expect(a.gt).toBe(22);
    expect(a.pred).toBe(21);
    expect(a.absError).toBe(1);
    expect(a.scaleCue).toBe(true);
    expect(a.method).toBe("reference-scaled");
  });

  it("skips predicted measurements the seller never stated, and failed predictions", () => {
    const g = [gold({ id: "a", measurements: { length: 28 } })];
    const p = [
      pred("a", [
        { name: "length", value_in: 27 },
        { name: "waist", value_in: 16 }, // no ground truth → dropped
      ]),
      { fixtureId: "ghost", model: "m", ok: false, error: "boom" },
    ];
    const rows = matchRows(g, p);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("length");
  });

  it("counts gold measurements the model omitted as misses (not silently dropped)", () => {
    const g = [gold({ id: "a", measurements: { pit_to_pit: 22, length: 28 } })];
    const p = [pred("a", [{ name: "pit_to_pit", value_in: 22 }])];
    const { missedGold } = scoreSpike(g, p);
    expect(missedGold).toBe(1);
  });
});

describe("medianAbsError", () => {
  it("returns the middle value for odd counts", () => {
    expect(medianAbsError([0.5, 3, 1])).toBe(1);
  });
  it("averages the middle pair for even counts", () => {
    expect(medianAbsError([1, 2, 3, 10])).toBe(2.5);
  });
  it("returns null on empty input", () => {
    expect(medianAbsError([])).toBeNull();
  });
});

describe("pctWithin", () => {
  it("computes the fraction of errors at or under the threshold", () => {
    expect(pctWithin([0.5, 1.0, 1.4, 2.0], 1.0)).toBeCloseTo(0.5);
    expect(pctWithin([0.5, 1.0, 1.4, 2.0], 1.5)).toBeCloseTo(0.75);
  });
});

describe("discrimination", () => {
  it("scores same-measurement pairs with a >=3in true gap by predicted ordering", () => {
    const g = [
      gold({ id: "small", measurements: { pit_to_pit: 20 } }),
      gold({ id: "big", measurements: { pit_to_pit: 24 } }),
      gold({ id: "mid", measurements: { pit_to_pit: 22 } }), // 2in gaps → not counted
    ];
    const p = [
      pred("small", [{ name: "pit_to_pit", value_in: 21 }]),
      pred("big", [{ name: "pit_to_pit", value_in: 23.5 }]), // still ordered correctly
      pred("mid", [{ name: "pit_to_pit", value_in: 22 }]),
    ];
    const d = discrimination(matchRows(g, p));
    expect(d.pairs).toBe(1); // only small↔big has a ≥3in gold gap
    expect(d.correct).toBe(1);
    expect(d.rate).toBe(1);
  });

  it("marks a pair wrong when the predicted ordering flips", () => {
    const g = [
      gold({ id: "small", measurements: { length: 26 } }),
      gold({ id: "big", measurements: { length: 30 } }),
    ];
    const p = [
      pred("small", [{ name: "length", value_in: 31 }]),
      pred("big", [{ name: "length", value_in: 29 }]),
    ];
    const d = discrimination(matchRows(g, p));
    expect(d.pairs).toBe(1);
    expect(d.correct).toBe(0);
  });
});

describe("scoreSpike verdict (size-class bar)", () => {
  it("returns GO when with-cue median <=1.5in and discrimination >=0.9 with enough data", () => {
    // 6 with-cue fixtures, tight predictions, clear 3in+ gaps for discrimination.
    const g = Array.from({ length: 6 }, (_, i) =>
      gold({
        id: `f${i}`,
        scale_cue: true,
        measurements: { pit_to_pit: 18 + i * 2 }, // 18,20,22,24,26,28
      }),
    );
    const p = g.map((f, i) =>
      pred(f.id, [
        { name: "pit_to_pit", value_in: 18 + i * 2 + 0.5, method: "reference-scaled" },
      ]),
    );
    const s = scoreSpike(g, p);
    expect(s.verdict).toBe("GO");
  });

  it("returns NO-GO when with-cue errors blow past the bar", () => {
    const g = Array.from({ length: 6 }, (_, i) =>
      gold({ id: `f${i}`, scale_cue: true, measurements: { pit_to_pit: 18 + i * 2 } }),
    );
    const p = g.map((f, i) =>
      pred(f.id, [{ name: "pit_to_pit", value_in: 18 + i * 2 + 4 }]),
    );
    const s = scoreSpike(g, p);
    expect(s.verdict).toBe("NO-GO");
  });

  it("returns INSUFFICIENT-DATA when there are too few with-cue rows to judge", () => {
    const g = [gold({ id: "only", scale_cue: true, measurements: { pit_to_pit: 22 } })];
    const p = [pred("only", [{ name: "pit_to_pit", value_in: 22 }])];
    const s = scoreSpike(g, p);
    expect(s.verdict).toBe("INSUFFICIENT-DATA");
  });
});

describe("summarizeByMeasurement", () => {
  it("groups rows per measurement name with median and within-band rates", () => {
    const g = [
      gold({ id: "a", measurements: { pit_to_pit: 22, length: 28 } }),
      gold({ id: "b", measurements: { pit_to_pit: 20 } }),
    ];
    const p = [
      pred("a", [
        { name: "pit_to_pit", value_in: 23 },
        { name: "length", value_in: 28.5 },
      ]),
      pred("b", [{ name: "pit_to_pit", value_in: 22 }]),
    ];
    const by = summarizeByMeasurement(matchRows(g, p));
    expect(by.pit_to_pit.n).toBe(2);
    expect(by.pit_to_pit.medianAbsError).toBe(1.5);
    expect(by.length.n).toBe(1);
    expect(by.length.pctWithin1).toBe(1);
  });
});
