import { describe, expect, it } from "vitest";
import { pipelineWorkerCheckpointWriteSchema } from "./checkpoint";

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
