import { describe, expect, it } from "vitest";
import {
  generateClarifyingOptions,
  refineClarifyingOptions,
  type ClarifyGenerate,
} from "./generate";
import {
  MAX_CLARIFYING_OPTIONS,
  clarifyingOptionsSchema,
  type RawClarifyingOption,
} from "./schema";
import type { ExtractedAttributes } from "../pipeline/types";

/**
 * Clarifying-options generator. The model call is non-deterministic, so the LLM path
 * is exercised via an INJECTED fake (replaying crafted raw output); the value is in
 * the deterministic REFINEMENT — tested directly — and the best-effort contract.
 */

const attrs = (partial: Partial<ExtractedAttributes>): ExtractedAttributes =>
  ({
    brand: "Dell",
    model: "XPS 13",
    category: "electronics",
    condition: "used",
    specs: ["16GB RAM"],
    ...partial,
  }) as ExtractedAttributes;

const opt = (label: string, spec: string): RawClarifyingOption => ({ label, spec });

describe("refineClarifyingOptions", () => {
  it("keeps product-specific options and requires both label and spec", () => {
    const out = refineClarifyingOptions(
      [
        opt("Charger included", "with charger"),
        opt("Webcam privacy shutter works", "privacy shutter functional"),
        opt("", "blank label dropped"),
        opt("Blank spec dropped", "  "),
      ],
      attrs({}),
    );
    expect(out.map((o) => o.label)).toEqual([
      "Charger included",
      "Webcam privacy shutter works",
    ]);
    // Every refined option satisfies the clean UI contract.
    expect(() => clarifyingOptionsSchema.parse({ options: out })).not.toThrow();
  });

  it("never re-asks a detail already in the attributes (specs / brand / model)", () => {
    const out = refineClarifyingOptions(
      [
        opt("Has 16GB RAM", "16GB RAM"), // already a known spec
        opt("Is a Dell", "Dell"), // already the known brand
        opt("Battery health tested good", "battery health good"), // new — kept
      ],
      attrs({}),
    );
    expect(out).toEqual([
      { label: "Battery health tested good", spec: "battery health good" },
    ]);
  });

  it("dedupes case-insensitively by BOTH label and spec", () => {
    const out = refineClarifyingOptions(
      [
        opt("Charger included", "with charger"),
        opt("charger included", "WITH CHARGER"), // dupe both ways
        opt("Charger Included", "ships with charger"), // dupe label only
        opt("Comes with charger", "with charger"), // dupe spec only
      ],
      attrs({ specs: [] }),
    );
    expect(out).toEqual([{ label: "Charger included", spec: "with charger" }]);
  });

  it("caps at MAX_CLARIFYING_OPTIONS", () => {
    const many = Array.from({ length: MAX_CLARIFYING_OPTIONS + 4 }, (_, i) =>
      opt(`Detail number ${i}`, `spec-${i}`),
    );
    expect(refineClarifyingOptions(many, attrs({ specs: [] })).length).toBe(
      MAX_CLARIFYING_OPTIONS,
    );
  });
});

describe("generateClarifyingOptions", () => {
  const fakeReturning =
    (options: RawClarifyingOption[]): ClarifyGenerate =>
    async () => ({ options });

  it("returns refined, schema-valid options from the injected generator", async () => {
    const res = await generateClarifyingOptions({
      attributes: attrs({ specs: [] }),
      generate: fakeReturning([
        opt("Charger included", "with charger"),
        opt("Webcam privacy shutter works", "privacy shutter functional"),
      ]),
    });
    expect(res.options).toHaveLength(2);
    expect(() => clarifyingOptionsSchema.parse({ options: res.options })).not.toThrow();
    expect(res.model).toBeTruthy();
  });

  it("drops options that restate something already known", async () => {
    const res = await generateClarifyingOptions({
      attributes: attrs({ specs: ["16GB RAM"] }),
      generate: fakeReturning([
        opt("Has 16GB RAM", "16GB RAM"),
        opt("Charger included", "with charger"),
      ]),
    });
    expect(res.options).toEqual([{ label: "Charger included", spec: "with charger" }]);
  });

  it("is best-effort: a generation failure yields ZERO options, never throws", async () => {
    const res = await generateClarifyingOptions({
      attributes: attrs({}),
      generate: async () => {
        throw new Error("model exploded");
      },
    });
    expect(res.options).toEqual([]);
  });
});
