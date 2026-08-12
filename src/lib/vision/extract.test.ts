import { describe, expect, it, vi } from "vitest";
import { extractedAttributesSchema } from "../pipeline/types";
import { ITEM_CONDITIONS } from "../items/condition";
import {
  extractItemAttributes,
  visionResponseSchema,
  type VisionGenerate,
  type VisionGenerateResult,
} from "./extract";

/**
 * Vision-extraction CONTRACT tests (issue #6). Fully OFFLINE: the model call is
 * injected as a `generate` fake, so no network / key is touched. We assert the
 * BOUNDARY behavior (AGENTS.md: test contracts, not model quality):
 *
 *  - output validates against the real Zod attribute schema and is returned;
 *  - an invalid-then-valid sequence triggers a RETRY and then succeeds;
 *  - retries are exhausted → a clear throw (never a half-validated object);
 *  - 0 or >5 images throw (1..5 enforced);
 *  - ALL images are passed to a SINGLE call;
 *  - thin/low-evidence (or model-signalled uncertain) input is FLAGGED
 *    (`confident: false`) rather than fabricated into a confident id.
 */

/** A strong, fully-resolved hero-domain item — brand+model+barcode+category. */
const STRONG: VisionGenerateResult = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  upc: "027242920866",
  specs: ["wireless", "noise-cancelling"],
  title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones",
};

/** A queue-backed fake `generate`: returns the next scripted result per call. */
function scriptedGenerate(
  results: VisionGenerateResult[],
): { generate: VisionGenerate; calls: Array<Parameters<VisionGenerate>[0]> } {
  const calls: Array<Parameters<VisionGenerate>[0]> = [];
  let i = 0;
  const generate: VisionGenerate = async (args) => {
    calls.push(args);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  };
  return { generate, calls };
}

describe("vision/extract — image-count enforcement", () => {
  it("throws on 0 images", async () => {
    const { generate } = scriptedGenerate([STRONG]);
    await expect(
      extractItemAttributes({ images: [], generate }),
    ).rejects.toThrow(/at least one|1.*image|require/i);
  });

  it("accepts the boundary counts 1 and 5 and rejects 6", async () => {
    const one = scriptedGenerate([STRONG]);
    await expect(
      extractItemAttributes({ images: ["only"], generate: one.generate }),
    ).resolves.toBeTruthy();

    const five = scriptedGenerate([STRONG]);
    await expect(
      extractItemAttributes({
        images: ["a", "b", "c", "d", "e"],
        generate: five.generate,
      }),
    ).resolves.toBeTruthy();

    const six = scriptedGenerate([STRONG]);
    await expect(
      extractItemAttributes({
        images: ["a", "b", "c", "d", "e", "f"],
        generate: six.generate,
      }),
    ).rejects.toThrow(/up to 5|at most 5|more than 5|5 image/i);
  });
});

describe("vision/extract — single multimodal call over all images", () => {
  it("feeds ALL provided images to a SINGLE generate call", async () => {
    const { generate, calls } = scriptedGenerate([STRONG]);
    await extractItemAttributes({
      images: ["one", "two", "three"],
      generate,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].images).toEqual(["one", "two", "three"]);
  });
});

describe("vision/extract — schema validation + retry", () => {
  it("returns the validated attributes when the model response is valid", async () => {
    const { generate } = scriptedGenerate([STRONG]);
    const { attributes } = await extractItemAttributes({
      images: ["x"],
      generate,
    });
    // The returned attributes must satisfy the REAL contract.
    expect(extractedAttributesSchema.safeParse(attributes).success).toBe(true);
    expect(attributes.brand).toBe("Sony");
    expect(attributes.model).toBe("WH-1000XM4");
  });

  it("retries on schema mismatch (invalid-then-valid) and succeeds", async () => {
    // First response violates the schema (specs must be string[]); second is valid.
    const invalid = { brand: "Sony", specs: "not-an-array" } as unknown as VisionGenerateResult;
    const { generate, calls } = scriptedGenerate([invalid, STRONG]);
    const { attributes } = await extractItemAttributes({
      images: ["x"],
      generate,
      maxRetries: 2,
    });
    expect(calls.length).toBe(2); // one failed attempt + one retry
    expect(attributes.model).toBe("WH-1000XM4");
  });

  it("retries when the model call THROWS (real generateObject throws, not returns, on invalid output)", async () => {
    // The real `generateObject` validates internally and THROWS (NoObjectGeneratedError)
    // on a bad response rather than returning an invalid object. The retry loop must
    // treat a throw as a failed attempt, not let it bypass `maxRetries`.
    const attempts: number[] = [];
    let n = 0;
    const generate: VisionGenerate = async (args) => {
      attempts.push(args.attempt);
      n += 1;
      if (n === 1) throw new Error("NoObjectGeneratedError: could not parse response");
      return STRONG;
    };
    const { attributes } = await extractItemAttributes({
      images: ["x"],
      generate,
      maxRetries: 2,
    });
    expect(attempts).toEqual([0, 1]); // threw on attempt 0, retried attempt 1
    expect(attributes.model).toBe("WH-1000XM4");
  });

  it("throws after exhausting retries when the model call ALWAYS throws", async () => {
    let n = 0;
    const generate: VisionGenerate = async () => {
      n += 1;
      throw new Error("NoObjectGeneratedError: persistent failure");
    };
    await expect(
      extractItemAttributes({ images: ["x"], generate, maxRetries: 2 }),
    ).rejects.toThrow(/valid|schema|extract|attempt/i);
    expect(n).toBe(3); // 1 initial + 2 retries
  });

  it("throws a clear error after exhausting retries on persistent invalid output", async () => {
    const invalid = { specs: 123 } as unknown as VisionGenerateResult;
    const gen = scriptedGenerate([invalid]);
    await expect(
      extractItemAttributes({ images: ["x"], generate: gen.generate, maxRetries: 2 }),
    ).rejects.toThrow(/valid|schema|extract|attempt/i);
    // 1 initial + 2 retries = 3 attempts.
    expect(gen.calls.length).toBe(3);
  });
});

describe("vision/extract — identification flagging (no fabricated confident id)", () => {
  it("is confident for a strongly-identified hero item", async () => {
    const { generate } = scriptedGenerate([STRONG]);
    const { identification } = await extractItemAttributes({
      images: ["x"],
      generate,
    });
    expect(identification.confident).toBe(true);
    expect(identification.label).toMatch(/Sony/);
    expect(identification.evidence).toBeGreaterThan(0.5);
  });

  it("flags low-evidence (generic) items instead of guessing", async () => {
    const thin: VisionGenerateResult = {
      category: "home goods",
      title: "Unbranded item",
    };
    const { generate } = scriptedGenerate([thin]);
    const { identification } = await extractItemAttributes({
      images: ["x"],
      generate,
    });
    expect(identification.confident).toBe(false);
    expect(identification.reason).toBeTruthy();
  });

  it("respects a model-signalled uncertainty even when fields are present", async () => {
    const ambiguous: VisionGenerateResult = {
      brand: "Generic",
      model: "X1",
      category: "electronics",
      title: "Possibly a knock-off speaker",
      ambiguous: true,
      uncertaintyReason: "Photo too blurry to confirm brand",
      candidates: ["JBL Flip", "Anker Soundcore"],
    };
    const { generate } = scriptedGenerate([ambiguous]);
    const { identification } = await extractItemAttributes({
      images: ["x"],
      generate,
    });
    expect(identification.confident).toBe(false);
    expect(identification.reason).toMatch(/blurry|uncertain|confirm/i);
    expect(identification.candidates).toEqual(["JBL Flip", "Anker Soundcore"]);
  });
});

describe("vision/extract — the provider schema constrains condition (#798)", () => {
  /**
   * `visionResponseSchema` is the object handed to `generateObject`
   * (`MODEL_FACING_SCHEMAS`), so an enum here is enforced by strict structured
   * decoding — the model cannot emit `"Good"` in the first place. This is the
   * upstream half of the fix; `buildPipelinePersistencePayload` still
   * canonicalizes, because a provider that ignores the constraint must not be
   * able to write an unreadable row.
   */
  const provider = {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    isbn: null,
    upc: "027242920866",
    specs: ["wireless"],
    title: "Sony WH-1000XM4",
    ambiguous: null,
    uncertaintyReason: null,
    candidates: null,
  };

  it("accepts every canonical taxonomy value", () => {
    for (const condition of ITEM_CONDITIONS) {
      expect(
        visionResponseSchema.safeParse({ ...provider, condition }).success,
      ).toBe(true);
    }
  });

  it("accepts a null condition (a generic item resolves none)", () => {
    expect(
      visionResponseSchema.safeParse({ ...provider, condition: null }).success,
    ).toBe(true);
  });

  it("rejects the capitalized casing that broke a production review", () => {
    expect(
      visionResponseSchema.safeParse({ ...provider, condition: "Good" }).success,
    ).toBe(false);
  });

  it("rejects a free-form condition outside the taxonomy", () => {
    expect(
      visionResponseSchema.safeParse({ ...provider, condition: "Used - Good" })
        .success,
    ).toBe(false);
  });
});

describe("vision/extract — default generate is lazy (no eager SDK import)", () => {
  it("does not call the network when a fake generate is injected", async () => {
    const spy = vi.fn(async () => STRONG);
    await extractItemAttributes({ images: ["x"], generate: spy });
    expect(spy).toHaveBeenCalledOnce();
  });
});
