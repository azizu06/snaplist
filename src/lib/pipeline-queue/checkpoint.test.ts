import { describe, expect, it } from "vitest";
import {
  pipelineWorkerCheckpointSchema,
  pipelineWorkerCheckpointWriteSchema,
} from "./checkpoint";

/**
 * PostgreSQL `jsonb` rejects `U+0000` (SQLSTATE 22P05) and PostgREST rejects lone
 * UTF-16 surrogates before Postgres sees them (PGRST102). Either one turns a
 * checkpoint write into a generic RPC error, which the worker classifies as
 * retryable — so the run re-runs the paid identification stage and reproduces the
 * same bytes on every attempt until it dead-letters. The write boundary is the
 * last place that can stop it.
 */
const NUL = String.fromCharCode(0);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800);
const LONE_LOW_SURROGATE = String.fromCharCode(0xdfff);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("pipeline checkpoint write boundary", () => {
  it("strips U+0000 from a nested identification string", () => {
    const parsed = pipelineWorkerCheckpointWriteSchema.parse({
      identified: {
        attributes: { brand: `Sony${NUL}WH-1000XM4` },
        model: "test-vision",
      },
    });

    expect(parsed.identified?.attributes.brand).toBe("SonyWH-1000XM4");
  });

  it("repairs lone surrogates in a nested identification string", () => {
    const parsed = pipelineWorkerCheckpointWriteSchema.parse({
      identified: {
        attributes: { brand: "Sony" },
        identification: {
          label: `Sony${LONE_HIGH_SURROGATE}WH${LONE_LOW_SURROGATE}`,
          confident: true,
          evidence: 1,
        },
        model: "test-vision",
      },
    });

    const label = parsed.identified?.identification?.label ?? "";
    expect(label).toBe(`Sony${REPLACEMENT}WH${REPLACEMENT}`);
    expect(label.isWellFormed()).toBe(true);
  });

  it("repairs open-record keys and deeply nested values in generated listing copy", () => {
    const parsed = pipelineWorkerCheckpointWriteSchema.parse({
      identified: {
        attributes: { brand: "Sony" },
        model: "test-vision",
      },
      generated: {
        copy: {
          platform: "ebay",
          title: `Sony${NUL} Headphones`,
          description: "Used headphones in good condition.",
          fields: {
            [`Item${NUL}Specifics`]: {
              Brand: `Sony${LONE_HIGH_SURROGATE}`,
              Tags: [`wireless${NUL}`, "noise-cancelling"],
            },
          },
        },
        model: "test-listing",
      },
    });

    expect(parsed.generated?.copy.title).toBe("Sony Headphones");
    expect(parsed.generated?.copy.fields).toEqual({
      ItemSpecifics: {
        Brand: `Sony${REPLACEMENT}`,
        Tags: ["wireless", "noise-cancelling"],
      },
    });
  });

  it("keeps the later entry when two open-record keys repair to the same string", () => {
    // jsonb-safe.ts documents this as deterministic: "a<NUL>b" and "ab" both
    // repair to "ab", and the later entry wins. That is strictly better than
    // dead-lettering the run over the unrepaired key, but it is a real,
    // subtle data-loss trade-off with no coverage — if the merge order were
    // ever flipped, or the collision made it throw instead, this is the seam
    // that would catch it.
    const parsed = pipelineWorkerCheckpointWriteSchema.parse({
      identified: {
        attributes: { brand: "Sony" },
        model: "test-vision",
      },
      generated: {
        copy: {
          platform: "ebay",
          title: "Sony Headphones",
          description: "Used headphones in good condition.",
          fields: {
            [`Item${NUL}Specifics`]: "first",
            ItemSpecifics: "second",
          },
        },
        model: "test-listing",
      },
    });

    expect(parsed.generated?.copy.fields).toEqual({ ItemSpecifics: "second" });
  });

  it("repairs strings inside pricing evidence arrays", () => {
    const parsed = pipelineWorkerCheckpointWriteSchema.parse({
      identified: {
        attributes: { brand: "Sony" },
        model: "test-vision",
      },
      priced: {
        result: {
          suggested: 149,
          range: { min: 130, max: 170 },
          confidence: 0.8,
          sources: [
            {
              url: "https://www.ebay.com/itm/1",
              title: `Sony WH-1000XM4${NUL} sold`,
              kind: "sold-comp",
            },
          ],
          tier: "ebay-sold",
        },
      },
    });

    expect(parsed.priced?.result.sources[0]?.title).toBe("Sony WH-1000XM4 sold");
  });

  it("leaves ordinary seller-visible text byte-for-byte unchanged", () => {
    const description = "Line one.\nLine two.\tTabbed — café 🚀 “quoted”";
    const parsed = pipelineWorkerCheckpointWriteSchema.parse({
      identified: {
        attributes: { brand: "Sony", specs: ["wireless", "noise-cancelling"] },
        identification: {
          label: "Sony WH-1000XM4 café 🚀",
          confident: true,
          evidence: 1,
        },
        model: "test-vision",
      },
      generated: {
        copy: {
          platform: "ebay",
          title: "Sony WH-1000XM4 Headphones",
          description,
          fields: { itemSpecifics: { Brand: "Sony" } },
        },
        model: "test-listing",
      },
    });

    expect(parsed.identified?.identification?.label).toBe("Sony WH-1000XM4 café 🚀");
    expect(parsed.identified?.attributes.specs).toEqual([
      "wireless",
      "noise-cancelling",
    ]);
    expect(parsed.generated?.copy.description).toBe(description);
    expect(parsed.generated?.copy.fields).toEqual({
      itemSpecifics: { Brand: "Sony" },
    });
  });
});

/**
 * Issue #1120 P0: the worker transcribes BEFORE it identifies so the transcript can
 * hint the vision call — but the transcript is buffered and written in the SAME
 * checkpoint as `identified`, never on its own. This schema is one of TWO copies of
 * that rule; `checkpoint_pipeline_run` is the other and raises 22023. Relaxing only
 * this copy is what broke every voice run while the unit suites stayed green, so
 * these tests pin the agreement.
 */
describe("checkpoint ordering — voice is never persisted without identification (#1120)", () => {
  const VOICE = {
    version: 1,
    contentSha256: "b".repeat(64),
    outcome: "failed" as const,
    providerContacted: false,
    sellerContext: null,
  };
  const IDENTIFIED = {
    attributes: { brand: "Apple", model: "AirPods Pro" },
    model: "vision-model",
  };

  it("rejects a voice attempt recorded without identification", () => {
    expect(
      pipelineWorkerCheckpointSchema.safeParse({
        voiceAttempt: { version: 1, contentSha256: "b".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("rejects a terminal voice outcome recorded without identification", () => {
    expect(pipelineWorkerCheckpointSchema.safeParse({ voice: VOICE }).success).toBe(
      false,
    );
  });

  it("accepts the combined write the worker actually performs", () => {
    expect(
      pipelineWorkerCheckpointSchema.safeParse({
        identified: IDENTIFIED,
        voiceAttempt: { version: 1, contentSha256: "b".repeat(64) },
        voice: VOICE,
      }).success,
    ).toBe(true);
  });

  it("still requires identification before pricing and generation", () => {
    expect(
      pipelineWorkerCheckpointSchema.safeParse({
        voice: VOICE,
        priced: {
          result: {
            suggested: 10,
            range: { min: 5, max: 15 },
            confidence: 0.5,
            sources: [],
            tier: "llm-only",
          },
        },
      }).success,
    ).toBe(false);
  });
});
