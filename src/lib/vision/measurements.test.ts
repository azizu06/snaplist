import { describe, expect, it } from "vitest";
import {
  classifyGarment,
  garmentClassOf,
  isGarment,
  needsReference,
  gateMeasurements,
  tapeVisible,
  garmentMeasurementsSchema,
  parseMeasurementEdits,
  formatMeasurement,
  trimInches,
  confirmedMeasurementPhrases,
  extractGarmentMeasurements,
  AUTO_SUGGEST_MEASUREMENTS,
  TAPE_GATED_MEASUREMENTS,
  type MeasureGenerate,
  type MeasurementResponse,
  type MeasurementDraft,
} from "./measurements";

/**
 * Garment-measurement CONTRACT tests (issue #104, scoped per the PR #116 spike).
 * Fully OFFLINE — the vision call is injected as a `generate` fake, so no network /
 * key is touched. We assert the BOUNDARY policy the amendment locked in:
 *
 *  - the four listing-grade measurements auto-suggest from priors alone;
 *  - inseam/sleeve (and other reference-only points) are REFUSED without a tape;
 *  - gated output validates against the per-garment-type Zod schema;
 *  - the vision output validates + retries on schema mismatch (contract, not quality);
 *  - seller edits parse into confirmable drafts; buyer-Q&A grounds only on confirmed.
 */

/** Build a measurement response with sane null defaults. */
function response(over: Partial<MeasurementResponse> = {}): MeasurementResponse {
  return {
    garmentType: over.garmentType ?? "hoodie",
    scaleReferenceFound: over.scaleReferenceFound ?? null,
    scaleReferenceKind: over.scaleReferenceKind ?? null,
    measurements: over.measurements ?? null,
  };
}

type RawMeasurement = NonNullable<MeasurementResponse["measurements"]>[number];
function m(
  name: RawMeasurement["name"],
  value_in: number,
  method: RawMeasurement["method"] = "prior-based",
  tolerance_in = 1.5,
): RawMeasurement {
  return { name, value_in, tolerance_in, method };
}

describe("measurements — garment classification", () => {
  it("classifies tops and bottoms from free text", () => {
    expect(classifyGarment("Vintage Champion Hoodie")).toBe("top");
    expect(classifyGarment("Men's t-shirt")).toBe("top");
    expect(classifyGarment("Levi's 501 jeans")).toBe("bottom");
    expect(classifyGarment("cargo shorts")).toBe("bottom");
  });

  it("returns null for non-garments (no false positives)", () => {
    expect(classifyGarment("Sony WH-1000XM4 Headphones")).toBeNull();
    expect(classifyGarment("topaz crystal")).toBeNull(); // \b guards "top" inside "topaz"
    expect(classifyGarment(null)).toBeNull();
  });

  it("treats a sleeve-length descriptor as a top, not shorts", () => {
    expect(classifyGarment("Nike Men's Short Sleeve T-Shirt")).toBe("top");
    expect(classifyGarment("short-sleeve polo")).toBe("top");
    expect(classifyGarment("long-sleeved shirt")).toBe("top");
    // a genuine pair of shorts still classifies as a bottom
    expect(classifyGarment("Nike Dri-FIT Short")).toBe("bottom");
    expect(classifyGarment("athletic shorts")).toBe("bottom");
  });

  it("reads adjectival 'short' on a top as the top, not a bottom", () => {
    // "short" as an adjective modifies a top noun — a top keyword must win over the
    // ambiguous singular "short" (which only classifies a BARE 'short' as a bottom).
    expect(classifyGarment("Zara Short Trench Coat")).toBe("top");
    expect(classifyGarment("H&M Short Denim Jacket")).toBe("top");
    expect(classifyGarment("Short Floral Dress")).toBe("top");
    // ...while material/adjective + plural shorts stays a bottom (jersey is a TOP kw).
    expect(classifyGarment("jersey shorts")).toBe("bottom");
  });

  it("garmentClassOf reads category first, then title, then brand/model", () => {
    expect(garmentClassOf({ category: "Clothing hoodie", title: "x" })).toBe("top");
    expect(garmentClassOf({ title: "Wrangler jeans" })).toBe("bottom");
    expect(isGarment({ category: "electronics" })).toBe(false);
    expect(isGarment({ title: "Nike sweatshirt" })).toBe(true);
  });
});

describe("measurements — auto-suggest vs tape-gated policy", () => {
  it("marks exactly the four listing-grade measurements as auto-suggest", () => {
    expect([...AUTO_SUGGEST_MEASUREMENTS].sort()).toEqual(
      ["length", "pit_to_pit", "rise", "waist"].sort(),
    );
    expect(needsReference("pit_to_pit")).toBe(false);
    expect(needsReference("inseam")).toBe(true);
    expect(needsReference("sleeve")).toBe(true);
    expect(TAPE_GATED_MEASUREMENTS).toContain("inseam");
    expect(TAPE_GATED_MEASUREMENTS).toContain("sleeve");
  });
});

describe("measurements — tapeVisible", () => {
  it("requires BOTH the flag and a tape/ruler-like kind", () => {
    expect(tapeVisible({ scaleReferenceFound: true, scaleReferenceKind: "tape measure" })).toBe(true);
    expect(tapeVisible({ scaleReferenceFound: true, scaleReferenceKind: "ruler" })).toBe(true);
    // A generic "true" with no nameable tape does not unlock the gated measurements.
    expect(tapeVisible({ scaleReferenceFound: true, scaleReferenceKind: null })).toBe(false);
    expect(tapeVisible({ scaleReferenceFound: true, scaleReferenceKind: "credit card" })).toBe(false);
    expect(tapeVisible({ scaleReferenceFound: false, scaleReferenceKind: "tape" })).toBe(false);
  });
});

describe("measurements — gateMeasurements policy", () => {
  it("keeps the four auto-suggest measurements from priors (no tape)", () => {
    const res = response({
      measurements: [m("pit_to_pit", 22), m("length", 27), m("shoulder", 18)],
    });
    const gated = gateMeasurements(res, "top");
    const names = gated.map((g) => g.name);
    expect(names).toContain("pit_to_pit");
    expect(names).toContain("length");
    // shoulder needs a reference — dropped without a tape.
    expect(names).not.toContain("shoulder");
    // every gated draft is unconfirmed and carries a tolerance band.
    expect(gated.every((g) => g.confirmed === false)).toBe(true);
    expect(gated.every((g) => g.tolerance_in > 0)).toBe(true);
  });

  it("REFUSES inseam/sleeve without a visible tape", () => {
    const res = response({
      garmentType: "jeans",
      measurements: [m("waist", 16), m("rise", 11), m("inseam", 30)],
    });
    const gated = gateMeasurements(res, "bottom");
    const names = gated.map((g) => g.name);
    expect(names).toContain("waist");
    expect(names).toContain("rise");
    expect(names).not.toContain("inseam"); // no tape → never a guessed inseam
  });

  it("forces prior-based + a floored band when the model mislabels method without a tape", () => {
    // No scale reference, yet the model claims reference-scaled with a sub-inch band.
    // The gate must not pass that false precision through: without a tape it is a
    // prior-based estimate and the band floors to ±1in.
    const res = response({
      scaleReferenceFound: false,
      measurements: [m("pit_to_pit", 22, "reference-scaled", 0.5)],
    });
    const gated = gateMeasurements(res, "top");
    const pit = gated.find((g) => g.name === "pit_to_pit")!;
    expect(pit.method).toBe("prior-based");
    expect(pit.tolerance_in).toBe(1);
  });

  it("keeps the model's method + band for a real tape-scaled reading", () => {
    const res = response({
      scaleReferenceFound: true,
      scaleReferenceKind: "tape measure",
      measurements: [m("pit_to_pit", 22, "reference-scaled", 0.5)],
    });
    const pit = gateMeasurements(res, "top").find((g) => g.name === "pit_to_pit")!;
    expect(pit.method).toBe("reference-scaled");
    expect(pit.tolerance_in).toBe(0.5);
  });

  it("allows inseam/sleeve WHEN a tape is visible", () => {
    const res = response({
      garmentType: "jeans",
      scaleReferenceFound: true,
      scaleReferenceKind: "tape measure",
      measurements: [m("waist", 16, "reference-scaled", 0.5), m("inseam", 30, "reference-scaled", 0.5)],
    });
    const gated = gateMeasurements(res, "bottom");
    expect(gated.map((g) => g.name)).toContain("inseam");
  });

  it("drops measurements outside the garment type's set and null responses", () => {
    // waist is a bottom measurement — invalid for a top.
    const res = response({ measurements: [m("waist", 16), m("pit_to_pit", 22)] });
    expect(gateMeasurements(res, "top").map((g) => g.name)).toEqual(["pit_to_pit"]);
    expect(gateMeasurements(response({ measurements: null }), "top")).toEqual([]);
  });

  it("produces output that validates against the per-garment-type schema", () => {
    const res = response({ measurements: [m("pit_to_pit", 22), m("length", 27)] });
    const gated = gateMeasurements(res, "top");
    expect(garmentMeasurementsSchema("top").safeParse(gated).success).toBe(true);
    // A bottom measurement must NOT validate against the top schema.
    const badForTop: MeasurementDraft[] = [
      { name: "waist", value_in: 16, tolerance_in: 1, method: "prior-based", confirmed: false },
    ];
    expect(garmentMeasurementsSchema("top").safeParse(badForTop).success).toBe(false);
  });
});

/** A queue-backed fake `generate`, mirroring extract.test.ts. */
function scripted(results: MeasurementResponse[]): {
  generate: MeasureGenerate;
  calls: Array<Parameters<MeasureGenerate>[0]>;
} {
  const calls: Array<Parameters<MeasureGenerate>[0]> = [];
  let i = 0;
  const generate: MeasureGenerate = async (args) => {
    calls.push(args);
    return results[Math.min(i++, results.length - 1)];
  };
  return { generate, calls };
}

describe("measurements — extractGarmentMeasurements contract", () => {
  it("validates + gates a good response and feeds all images to one call", async () => {
    const { generate, calls } = scripted([
      response({ measurements: [m("pit_to_pit", 22), m("inseam", 30)] }),
    ]);
    const out = await extractGarmentMeasurements({
      images: ["a", "b"],
      garmentClass: "top",
      generate,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].images).toEqual(["a", "b"]);
    // inseam isn't a top measurement AND has no tape → gone; pit_to_pit stays.
    expect(out.measurements.map((g) => g.name)).toEqual(["pit_to_pit"]);
    expect(out.tapeDetected).toBe(false);
  });

  it("end-to-end tape gate: inseam absent without a tape, present with one", async () => {
    const noTape = scripted([
      response({ garmentType: "jeans", measurements: [m("waist", 16), m("inseam", 30)] }),
    ]);
    const withoutTape = await extractGarmentMeasurements({
      images: ["x"],
      garmentClass: "bottom",
      generate: noTape.generate,
    });
    expect(withoutTape.measurements.map((g) => g.name)).not.toContain("inseam");

    const tape = scripted([
      response({
        garmentType: "jeans",
        scaleReferenceFound: true,
        scaleReferenceKind: "tape measure",
        measurements: [m("waist", 16, "reference-scaled", 0.5), m("inseam", 30, "reference-scaled", 0.5)],
      }),
    ]);
    const withTape = await extractGarmentMeasurements({
      images: ["x"],
      garmentClass: "bottom",
      generate: tape.generate,
    });
    expect(withTape.measurements.map((g) => g.name)).toContain("inseam");
    expect(withTape.tapeDetected).toBe(true);
  });

  it("retries on schema mismatch (invalid-then-valid) and succeeds", async () => {
    const invalid = { garmentType: "hoodie" } as unknown as MeasurementResponse; // missing required nullable keys
    const good = response({ measurements: [m("pit_to_pit", 22)] });
    const { generate, calls } = scripted([invalid, good]);
    const out = await extractGarmentMeasurements({
      images: ["x"],
      garmentClass: "top",
      generate,
      maxRetries: 2,
    });
    expect(calls.length).toBe(2);
    expect(out.measurements.map((g) => g.name)).toEqual(["pit_to_pit"]);
  });

  it("throws after exhausting retries on persistent invalid output", async () => {
    const invalid = { nope: true } as unknown as MeasurementResponse;
    const { generate, calls } = scripted([invalid]);
    await expect(
      extractGarmentMeasurements({ images: ["x"], garmentClass: "top", generate, maxRetries: 1 }),
    ).rejects.toThrow(/valid|schema|attempt/i);
    expect(calls.length).toBe(2); // 1 initial + 1 retry
  });
});

describe("measurements — parseMeasurementEdits (seller edits → confirmable drafts)", () => {
  const existing: MeasurementDraft[] = [
    { name: "pit_to_pit", value_in: 22, tolerance_in: 1.5, method: "prior-based", confirmed: false },
    { name: "length", value_in: 27, tolerance_in: 2, method: "prior-based", confirmed: false },
  ];

  it("keeps an untouched draft's tolerance + method; confirm flips on tick", () => {
    const out = parseMeasurementEdits(
      existing,
      [
        { name: "pit_to_pit", value: "22", confirmed: true },
        { name: "length", value: "27", confirmed: false },
      ],
      "top",
    );
    const pit = out.find((o) => o.name === "pit_to_pit")!;
    expect(pit.confirmed).toBe(true);
    expect(pit.tolerance_in).toBe(1.5); // unchanged value keeps the model band
    expect(pit.method).toBe("prior-based");
  });

  it("confirming a fine-precision draft as-rendered is NOT an edit (keeps band + method)", () => {
    // A reference-scaled/pixel-derived draft can carry >2 decimals; the review input
    // renders `trimInches` (2dp), so re-submitting it unchanged sends the rounded string.
    // Edit-detection must compare on that same rounded form or it wrongly drops the
    // honest tolerance band and mislabels a prior estimate as a seller measurement.
    const fine: MeasurementDraft[] = [
      { name: "pit_to_pit", value_in: 21.354, tolerance_in: 1, method: "prior-based", confirmed: false },
    ];
    const out = parseMeasurementEdits(
      fine,
      [{ name: "pit_to_pit", value: trimInches(21.354), confirmed: true }],
      "top",
    );
    const pit = out.find((o) => o.name === "pit_to_pit")!;
    expect(pit.confirmed).toBe(true);
    expect(pit.tolerance_in).toBe(1); // untouched → keep the model's band
    expect(pit.method).toBe("prior-based"); // NOT flipped to reference-scaled
  });

  it("treats an edited value as hand-measured: tolerance 0, reference-scaled", () => {
    const out = parseMeasurementEdits(
      existing,
      [{ name: "pit_to_pit", value: "23", confirmed: true }],
      "top",
    );
    const pit = out.find((o) => o.name === "pit_to_pit")!;
    expect(pit.value_in).toBe(23);
    expect(pit.tolerance_in).toBe(0);
    expect(pit.method).toBe("reference-scaled");
  });

  it("blank clears a measurement; junk throws; out-of-set ignored", () => {
    const cleared = parseMeasurementEdits(
      existing,
      [{ name: "pit_to_pit", value: "  ", confirmed: false }],
      "top",
    );
    expect(cleared.find((o) => o.name === "pit_to_pit")).toBeUndefined();

    expect(() =>
      parseMeasurementEdits(existing, [{ name: "length", value: "abc", confirmed: false }], "top"),
    ).toThrow(/positive number|inches/i);

    // waist is not a top measurement — silently ignored, never stored.
    const ignored = parseMeasurementEdits(
      [],
      [{ name: "waist", value: "16", confirmed: true }],
      "top",
    );
    expect(ignored).toEqual([]);
  });
});

describe("measurements — display + grounding helpers", () => {
  it("formats the always-shown tolerance band; drops it when exact", () => {
    expect(formatMeasurement(21, 1)).toBe("~21 in ± 1");
    expect(formatMeasurement(21.5, 0.5)).toBe("~21.5 in ± 0.5");
    expect(formatMeasurement(23, 0)).toBe("23 in"); // seller-measured, no band
    expect(trimInches(21.0)).toBe("21");
  });

  it("grounds buyer-Q&A ONLY on confirmed measurements, name beside the number", () => {
    const measurements: MeasurementDraft[] = [
      { name: "pit_to_pit", value_in: 21, tolerance_in: 0, method: "reference-scaled", confirmed: true },
      { name: "length", value_in: 27, tolerance_in: 2, method: "prior-based", confirmed: false },
    ];
    const phrases = confirmedMeasurementPhrases(measurements);
    expect(phrases).toEqual(["pit to pit 21 inches"]);
    expect(confirmedMeasurementPhrases(undefined)).toEqual([]);
  });
});
