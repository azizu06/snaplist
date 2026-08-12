import { describe, expect, it } from "vitest";
import { buildPipelinePersistencePayload } from "./persist";
import type { PipelineResult } from "./types";

/**
 * The persistence boundary is the last place a model-authored condition can be
 * made canonical before it becomes a stored fact (issue #798). A production run
 * persisted `"Good"`; `rawReviewSchema` validates `items.condition` with a
 * case-sensitive `z.enum(ITEM_CONDITIONS)`, so that item's review answered 503
 * forever with no retry that could fix it.
 *
 * These are pure payload tests on purpose. `buildPipelinePersistencePayload` is
 * the highest seam BOTH write paths share — the request path (`persist.ts`) and
 * the queue worker's completion RPC (`pipeline-queue/worker-store.ts`), which is
 * the path that produced the bad row. Proving it here needs no stack and no live
 * model, and the model's casing is nondeterministic so a live rerun proves
 * nothing either way.
 */

function resultWith(condition: string | undefined): PipelineResult {
  return {
    attributes: {
      brand: "Logitech",
      model: "MX Master 3S",
      category: "electronics",
      title: "Logitech MX Master 3S",
      ...(condition === undefined ? {} : { condition }),
    },
    price: {
      suggested: 45,
      range: { min: 31.5, max: 58.5 },
      confidence: 0.7,
      sources: [{ url: "https://www.logitech.com/mx-master-3s" }],
      tier: "depreciation",
    },
    confidence: { score: 0.7, band: "medium", autopilotEligible: false },
    listing: {
      platform: "ebay",
      title: "Logitech MX Master 3S",
      description: "Working wireless mouse.",
      fields: {},
    },
    model: "test-vision-model",
    identification: {
      label: "Logitech MX Master 3S",
      confident: true,
      evidence: 1,
    },
  } satisfies PipelineResult;
}

describe("buildPipelinePersistencePayload condition normalization", () => {
  it("persists a capitalized model condition as the canonical taxonomy value", () => {
    const payload = buildPipelinePersistencePayload(resultWith("Good"));

    expect(payload.item.condition).toBe("good");
  });

  it("persists an aliased model condition as its canonical hyphenated form", () => {
    const payload = buildPipelinePersistencePayload(resultWith("Like New"));

    expect(payload.item.condition).toBe("like-new");
  });

  it("persists null rather than a raw string when the value is outside the taxonomy", () => {
    const payload = buildPipelinePersistencePayload(resultWith("Mint"));

    expect(payload.item.condition).toBeNull();
  });

  it("persists null when the run resolved no condition at all", () => {
    const payload = buildPipelinePersistencePayload(resultWith(undefined));

    expect(payload.item.condition).toBeNull();
  });

  it("leaves the model's verbatim condition in attributes as run provenance", () => {
    const result = resultWith("Good");

    const payload = buildPipelinePersistencePayload(result);

    // `prediction_logs.extracted_attrs` round-trips `result.attributes` exactly
    // (persist.test.ts asserts that equality). Normalizing the stored column
    // must not rewrite what the model actually said.
    expect(payload.item.attributes).toEqual(result.attributes);
    expect(
      (payload.item.attributes as { condition?: string }).condition,
    ).toBe("Good");
  });
});
