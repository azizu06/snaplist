import { describe, expect, it, vi } from "vitest";
import { priceResultSchema } from "../pricing";
import { pipelineResultSchema } from "../pipeline/types";
import { createVisionPipeline } from "./pipeline";
import type {
  ExtractItemAttributesInput,
  ExtractItemAttributesResult,
} from "./extract";
import type { SignedUrlClient } from "./photos";

/** A typed fake for the injected extraction (so `.mock.calls[0][0]` is well-typed). */
function fakeExtract(result: ExtractItemAttributesResult) {
  return vi.fn(
    async (input: ExtractItemAttributesInput): Promise<ExtractItemAttributesResult> => {
      void input;
      return result;
    },
  );
}

/**
 * `createVisionPipeline` tests (offline). The model call AND extraction are injected,
 * and storage is a fake signer, so this exercises the real composition — photos →
 * signed URLs → extraction → confidence — without network or DB.
 */

function fakeSignerClient(): SignedUrlClient {
  return {
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://signed/${path}` },
          error: null,
        }),
      }),
    },
  };
}

const STRONG_EXTRACTION: ExtractItemAttributesResult = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242920866",
    specs: ["wireless", "noise-cancelling"],
    title: "Sony WH-1000XM4 Headphones",
  },
  identification: {
    label: "Sony WH-1000XM4 Headphones",
    confident: true,
    evidence: 1,
  },
  model: "test-vision-model",
};

describe("vision/pipeline — createVisionPipeline.run", () => {
  it("signs photos, extracts, and returns a schema-valid PipelineResult", async () => {
    const extract = fakeExtract(STRONG_EXTRACTION);
    const pipeline = createVisionPipeline({
      supabase: fakeSignerClient(),
      extract,
    });

    const result = await pipeline.run({ photos: ["u/a.jpg", "u/b.jpg"] });

    // The full result validates against the real pipeline contract.
    expect(pipelineResultSchema.safeParse(result).success).toBe(true);
    expect(priceResultSchema.safeParse(result.price).success).toBe(true);
    expect(result.attributes.model).toBe("WH-1000XM4");
    expect(result.model).toBe("test-vision-model");
  });

  it("passes the SIGNED image URLs (all of them) to extraction", async () => {
    const extract = fakeExtract(STRONG_EXTRACTION);
    const pipeline = createVisionPipeline({
      supabase: fakeSignerClient(),
      extract,
    });

    await pipeline.run({ photos: ["u/a.jpg", "u/b.jpg"] });

    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0][0].images).toEqual([
      "https://signed/u/a.jpg",
      "https://signed/u/b.jpg",
    ]);
  });

  it("surfaces the identification on the result (before pricing, for confirmation)", async () => {
    const extract = fakeExtract(STRONG_EXTRACTION);
    const pipeline = createVisionPipeline({
      supabase: fakeSignerClient(),
      extract,
    });
    const result = await pipeline.run({ photos: ["u/a.jpg"] });
    expect(result.identification?.confident).toBe(true);
    expect(result.identification?.label).toMatch(/Sony/);
  });

  it("propagates a flagged (low-confidence) identification and lands low confidence", async () => {
    const weak: ExtractItemAttributesResult = {
      attributes: { category: "home goods", title: "Unbranded item" },
      identification: {
        label: "Unidentified home goods item",
        confident: false,
        evidence: 0.25,
        reason: "Not enough strong identifiers.",
      },
      model: "test-vision-model",
    };
    const pipeline = createVisionPipeline({
      supabase: fakeSignerClient(),
      extract: fakeExtract(weak),
    });
    const result = await pipeline.run({ photos: ["u/a.jpg"] });
    expect(result.identification?.confident).toBe(false);
    expect(result.confidence.band).toBe("low");
    expect(result.confidence.autopilotEligible).toBe(false);
  });

  it("keeps the model's self-reported ambiguity OUT of the confidence score (signal-based)", async () => {
    // Identical extracted evidence; only the model's self-report differs. The
    // user-facing identification flag must change, but the deterministic confidence
    // score must NOT — the composite depends on evidence, not LLM self-report (#3).
    const attributes = {
      brand: "Sony",
      model: "WH-1000XM4",
      category: "electronics",
      condition: "good",
      upc: "027242920866",
    };
    const confidentExtraction: ExtractItemAttributesResult = {
      attributes,
      identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
      model: "m",
    };
    const modelUnsureExtraction: ExtractItemAttributesResult = {
      attributes,
      identification: {
        label: "Sony WH-1000XM4",
        confident: false,
        evidence: 1,
        reason: "Model flagged this identification as uncertain.",
      },
      model: "m",
    };
    const run = (e: ExtractItemAttributesResult) =>
      createVisionPipeline({ supabase: fakeSignerClient(), extract: fakeExtract(e) }).run({
        photos: ["u/a.jpg"],
      });

    const a = await run(confidentExtraction);
    const b = await run(modelUnsureExtraction);

    // Same evidence → same score (decoupled from the model flag)...
    expect(b.confidence.score).toBe(a.confidence.score);
    // ...but the user-facing identification still reflects the model's uncertainty.
    expect(a.identification?.confident).toBe(true);
    expect(b.identification?.confident).toBe(false);
  });

  it("throws when given no photos", async () => {
    const pipeline = createVisionPipeline({
      supabase: fakeSignerClient(),
      extract: fakeExtract(STRONG_EXTRACTION),
    });
    await expect(pipeline.run({ photos: [] })).rejects.toThrow(/at least one photo/i);
  });
});
