import { describe, expect, it, vi } from "vitest";
import {
  createApifySoldPricingProvider,
  PriceRouter,
  type PriceResult,
} from "@/lib/pricing";
import type { VisionPipelineStages } from "@/lib/vision";
import {
  createDurableVisionPipelineProcessor,
  type PipelineWorkerCheckpoint,
} from "./durable-processor";
import type { PipelineWorkerContext } from "./worker-store";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const IDENTIFIED = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
  model: "vision-model",
};
const PRICE: PriceResult = {
  suggested: 149,
  range: { min: 130, max: 170 },
  confidence: 0.8,
  sources: [],
  tier: "llm-only",
};
const GENERATED = {
  copy: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Used headphones in good condition.",
    fields: {},
  },
  model: "listing-model",
};

function workerContext(checkpoint: PipelineWorkerCheckpoint): PipelineWorkerContext {
  return {
    run: {
      id: RUN_ID,
      user_id: "user_a",
      item_id: ITEM_ID,
      listing_id: null,
      status: "running",
      stage: "pricing",
      schema_version: 1,
      attempt_count: 2,
      max_attempts: 3,
      autopilot_enabled: false,
      checkpoint,
      lease_token: "33333333-3333-4333-8333-333333333333",
      lease_expires_at: "2026-07-15T04:10:00.000Z",
      next_attempt_at: null,
    },
    item: {
      id: ITEM_ID,
      user_id: "user_a",
      photos: ["user_a/photo.jpg"],
      attributes: {},
      condition: null,
      cost_basis: null,
      review_revision: "44444444-4444-4444-8444-444444444444",
      review_content_revision: "55555555-5555-4555-8555-555555555555",
    },
  };
}

function stages(): VisionPipelineStages & Record<string, ReturnType<typeof vi.fn>> {
  return {
    identify: vi.fn(async () => IDENTIFIED),
    price: vi.fn(async () => PRICE),
    generate: vi.fn(async () => GENERATED),
    assemble: vi.fn(({ identified, price, generated, autopilotEnabled }) => ({
      attributes: identified.attributes,
      identification: identified.identification,
      price,
      confidence: {
        score: 0.8,
        band: "high" as const,
        autopilotEligible: autopilotEnabled,
      },
      listing: generated.copy,
      model: identified.model,
      listingModel: generated.model,
    })),
  } as unknown as VisionPipelineStages & Record<string, ReturnType<typeof vi.fn>>;
}

describe("durable vision pipeline processor", () => {
  it("persists approved sold authority in the server-owned pricing checkpoint", async () => {
    const observedAt = Date.parse("2026-07-18T12:00:00.000Z");
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "test-only-token",
      now: () => observedAt,
      runActor: async () => ({
        status: "SUCCEEDED",
        items: [140, 150, 160].map((soldPrice, index) => ({
          url: `https://www.ebay.com/itm/durable-${index}`,
          title: "Sony WH-1000XM4 Wireless Headphones",
          condition: "Pre-Owned",
          endedAt: "2026-07-10T12:00:00.000Z",
          soldPrice,
          soldCurrency: "USD",
        })),
      }),
    });
    const routed = await new PriceRouter([provider]).price({
      brand: "Sony",
      model: "WH-1000XM4",
      category: "electronics",
      condition: "good",
      conditionKnown: true,
    });
    const pipeline = stages();
    vi.mocked(pipeline.price).mockResolvedValue(routed);
    const saved: Array<[string, PipelineWorkerCheckpoint]> = [];

    await createDurableVisionPipelineProcessor(pipeline).process({
      context: workerContext({ identified: IDENTIFIED }),
      onCheckpoint: async (stage, checkpoint) => {
        saved.push([stage, JSON.parse(JSON.stringify(checkpoint))]);
      },
    });

    const pricingCheckpoint = saved.find(([stage]) => stage === "pricing")?.[1];
    expect(pricingCheckpoint?.priceEvidence).toEqual(pricingCheckpoint?.priced);
  });

  it("resumes after persisted identify and price stages without repeating provider work", async () => {
    const pipeline = stages();
    const saved: Array<[string, PipelineWorkerCheckpoint]> = [];
    const processor = createDurableVisionPipelineProcessor(pipeline);

    const result = await processor.process({
      context: workerContext({ identified: IDENTIFIED, priced: PRICE }),
      onCheckpoint: async (stage, checkpoint) => {
        saved.push([stage, checkpoint]);
      },
    });

    expect(pipeline.identify).not.toHaveBeenCalled();
    expect(pipeline.price).not.toHaveBeenCalled();
    expect(pipeline.generate).toHaveBeenCalledOnce();
    expect(saved).toEqual([["generating", { identified: IDENTIFIED, priced: PRICE, generated: GENERATED }]]);
    expect(result.listing.title).toMatch(/Sony/);
  });

  it("uses only run-derived photo paths and the stored configuration snapshot", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.run.autopilot_enabled = true;

    const result = await processor.process({
      context: ctx,
      onCheckpoint: async () => undefined,
    });

    expect(pipeline.identify).toHaveBeenCalledWith({ photos: ["user_a/photo.jpg"] });
    expect(pipeline.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ autopilotEnabled: true }),
    );
    expect(result.confidence.autopilotEligible).toBe(true);
  });

  it("rejects a stored photo path that is not owned by the run tenant", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.item.photos = ["user_b/forged.jpg"];

    await expect(
      processor.process({ context: ctx, onCheckpoint: async () => undefined }),
    ).rejects.toMatchObject({ code: "invalid_run_photos", retryable: false });
    expect(pipeline.identify).not.toHaveBeenCalled();
  });

  it("rejects traversal-like stored paths even when their first bytes match the tenant", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.item.photos = ["user_a/../user_b/forged.jpg"];

    await expect(
      processor.process({ context: ctx, onCheckpoint: async () => undefined }),
    ).rejects.toMatchObject({ code: "invalid_run_photos", retryable: false });
    expect(pipeline.identify).not.toHaveBeenCalled();
  });
});
