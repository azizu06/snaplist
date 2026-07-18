import { describe, expect, it } from "vitest";
import {
  PIPELINE_CHECKPOINT_MAX_JSONB_BYTES,
  pipelineCheckpointJsonbByteLength,
  pipelineWorkerCheckpointSchema,
} from "./checkpoint";

function jsonbWhitespaceBytes(value: unknown): number {
  if (Array.isArray(value)) {
    return (
      Math.max(0, value.length - 1) +
      value.reduce((total, entry) => total + jsonbWhitespaceBytes(entry), 0)
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.values(value).filter(
      (entry) => entry !== undefined,
    );
    return (
      entries.length +
      Math.max(0, entries.length - 1) +
      entries.reduce((total, entry) => total + jsonbWhitespaceBytes(entry), 0)
    );
  }
  return 0;
}

function compactJsonbTextBytes(value: unknown): number {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength +
    jsonbWhitespaceBytes(value)
  );
}

function checkpointWithBytes(targetBytes: number) {
  const checkpoint = {
    identified: {
      attributes: { title: "" },
      model: "m",
    },
  };
  const baseBytes = pipelineCheckpointJsonbByteLength(checkpoint);
  checkpoint.identified.attributes.title = "x".repeat(targetBytes - baseBytes);
  expect(pipelineCheckpointJsonbByteLength(checkpoint)).toBe(targetBytes);
  return checkpoint;
}

describe("pipeline worker checkpoint contract", () => {
  it("matches the database JSONB byte ceiling at the exact boundary", () => {
    expect(
      pipelineWorkerCheckpointSchema.safeParse(
        checkpointWithBytes(PIPELINE_CHECKPOINT_MAX_JSONB_BYTES),
      ).success,
    ).toBe(true);
    expect(
      pipelineWorkerCheckpointSchema.safeParse(
        checkpointWithBytes(PIPELINE_CHECKPOINT_MAX_JSONB_BYTES + 1),
      ).success,
    ).toBe(false);
  });

  it("accounts for PostgreSQL expansion of exponent-form JSON numbers", () => {
    const checkpoint = {
      identified: {
        attributes: {},
        model: "m",
      },
      priced: {
        suggested: 1,
        range: { min: 1, max: 1 },
        confidence: 0.5,
        sources: [],
        tier: "llm-only" as const,
      },
      generated: {
        copy: {
          platform: "ebay",
          title: "t",
          description: "d",
          fields: { n: 1e21, padding: "" },
        },
        model: "g",
      },
    };
    const paddingBytes =
      PIPELINE_CHECKPOINT_MAX_JSONB_BYTES -
      compactJsonbTextBytes(checkpoint);
    checkpoint.generated.copy.fields.padding = "x".repeat(paddingBytes);

    expect(pipelineCheckpointJsonbByteLength({ n: 1e21 })).toBe(29);
    expect(compactJsonbTextBytes(checkpoint)).toBe(
      PIPELINE_CHECKPOINT_MAX_JSONB_BYTES,
    );
    expect(pipelineCheckpointJsonbByteLength(checkpoint)).toBe(
      PIPELINE_CHECKPOINT_MAX_JSONB_BYTES + 17,
    );
    expect(pipelineWorkerCheckpointSchema.safeParse(checkpoint).success).toBe(
      false,
    );
  });

  it("rejects priced source text that PostgreSQL JSONB cannot encode", () => {
    for (const invalidTitle of ["\ud83d", "\u0000"]) {
      const checkpoint = {
        identified: {
          attributes: {},
          model: "m",
        },
        priced: {
          suggested: 1,
          range: { min: 1, max: 1 },
          confidence: 0.8,
          sources: [
            {
              url: "https://example.com/sold",
              title: invalidTitle,
              kind: "sold-comp",
            },
          ],
          tier: "ebay-sold" as const,
        },
      };

      // The byte counter alone sees JSON.stringify's escaped form as a small
      // payload; the nested PriceSource contract must reject it before the
      // RPC reaches PostgreSQL's stricter JSONB Unicode decoder.
      expect(pipelineCheckpointJsonbByteLength(checkpoint)).toBeLessThan(
        PIPELINE_CHECKPOINT_MAX_JSONB_BYTES,
      );
      expect(pipelineWorkerCheckpointSchema.safeParse(checkpoint).success).toBe(
        false,
      );
    }
  });
});
