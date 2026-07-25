import { describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "@/lib/pipeline";
import type { PipelineQueue } from "./queue";
import { createDatabaseCheckpointClock } from "./checkpoint-clock.testing";
import type {
  PipelineAttemptAcquisition,
  PipelineAttemptFailureResult,
  PipelineWorkerContext,
  PipelineWorkerStore,
} from "./worker-store";
import {
  PipelineWorkerFailure,
  consumePipelineQueue,
  type DurablePipelineProcessor,
} from "./worker";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const CHECKPOINTED_AT = "2026-07-20T08:00:00.000Z";
const databaseClock = createDatabaseCheckpointClock(() => CHECKPOINTED_AT);

const RESULT: PipelineResult = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: {
    label: "Sony WH-1000XM4",
    confident: true,
    evidence: 1,
  },
  price: {
    suggested: 149,
    range: { min: 130, max: 170 },
    confidence: 0.8,
    sources: [{ url: "https://www.ebay.com/example", kind: "sold" }],
    tier: "ebay-sold",
  },
  confidence: { score: 0.86, band: "high", autopilotEligible: false },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Used headphones in good condition.",
    fields: { itemSpecifics: { Brand: "Sony" } },
  },
  model: "test-vision",
  listingModel: "test-listing",
};

function context(overrides: Partial<PipelineWorkerContext["run"]> = {}): PipelineWorkerContext {
  return {
    run: {
      id: RUN_ID,
      user_id: "user_a",
      item_id: ITEM_ID,
      listing_id: null,
      status: "running",
      stage: "identifying",
      schema_version: 1,
      attempt_count: 1,
      max_attempts: 3,
      autopilot_enabled: false,
      checkpoint: {},
      lease_token: "33333333-3333-4333-8333-333333333333",
      lease_expires_at: "2026-07-15T04:10:00.000Z",
      next_attempt_at: null,
      ...overrides,
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

function queueWith(
  envelope: unknown = { run_id: RUN_ID, schema_version: 1 },
): PipelineQueue & Record<"claim" | "ack" | "defer", ReturnType<typeof vi.fn>> {
  return {
    enqueue: vi.fn(),
    claim: vi.fn(async () => [
      {
        id: "41",
        readCount: 1,
        enqueuedAt: "2026-07-15T04:00:00.000Z",
        visibleAt: "2026-07-15T04:05:00.000Z",
        envelope,
      },
    ]),
    ack: vi.fn(async () => true),
    defer: vi.fn(async () => true),
  };
}

function storeWith(
  acquisition: PipelineAttemptAcquisition = {
    kind: "acquired",
    context: context(),
  },
  failure: PipelineAttemptFailureResult = {
    status: "retrying",
    retryAfterSeconds: 30,
  },
): PipelineWorkerStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    loadContext: vi.fn(),
    acquire: vi.fn(async () => acquisition),
    checkpoint: vi.fn(async (input) => databaseClock.stamp(input.checkpoint)),
    complete: vi.fn(async () => ({ listingId: "66666666-6666-4666-8666-666666666666" })),
    failAttempt: vi.fn(async () => failure),
    rejectMessage: vi.fn(async () => true),
  } as unknown as PipelineWorkerStore & Record<string, ReturnType<typeof vi.fn>>;
}

function processor(result: PipelineResult = RESULT): DurablePipelineProcessor & {
  process: ReturnType<typeof vi.fn>;
} {
  return {
    process: vi.fn(async ({ onCheckpoint }) => {
      await onCheckpoint("identifying", {
        identified: {
          attributes: result.attributes,
          identification: result.identification,
          model: result.model,
        },
      });
      return result;
    }),
  };
}

describe("durable pipeline queue consumer", () => {
  it("claims one message by default so every run receives the full visibility window", async () => {
    const queue = queueWith();

    await consumePipelineQueue({
      queue,
      runs: storeWith(),
      processor: processor(),
    });

    expect(queue.claim).toHaveBeenCalledWith({
      limit: 1,
      visibilityTimeoutSeconds: 300,
    });
  });

  it("claims one bounded batch, checkpoints, completes durably, then acknowledges", async () => {
    const queue = queueWith();
    const runs = storeWith();
    const pipeline = processor();

    await expect(
      consumePipelineQueue({ queue, runs, processor: pipeline }, { batchSize: 4 }),
    ).resolves.toEqual({ claimed: 1, succeeded: 1, retrying: 0, failed: 0, skipped: 0 });

    expect(queue.claim).toHaveBeenCalledWith({
      limit: 4,
      visibilityTimeoutSeconds: 300,
    });
    expect(runs.acquire).toHaveBeenCalledWith({
      messageId: "41",
      runId: RUN_ID,
      leaseSeconds: 300,
    });
    const checkpointMock = runs.checkpoint as unknown as ReturnType<typeof vi.fn>;
    const completeMock = runs.complete as unknown as ReturnType<typeof vi.fn>;
    expect(checkpointMock.mock.invocationCallOrder[0]).toBeLessThan(
      completeMock.mock.invocationCallOrder[0]!,
    );
    expect(completeMock.mock.invocationCallOrder[0]).toBeLessThan(
      queue.ack.mock.invocationCallOrder[0]!,
    );
    expect(queue.ack).toHaveBeenCalledWith("41");
  });

  it("turns a transient error into a bounded retry and extends visibility without ack", async () => {
    const queue = queueWith();
    const runs = storeWith();
    const pipeline = processor();
    pipeline.process.mockRejectedValueOnce(new Error("provider timed out with secret text"));

    await expect(
      consumePipelineQueue({ queue, runs, processor: pipeline }),
    ).resolves.toEqual({ claimed: 1, succeeded: 0, retrying: 1, failed: 0, skipped: 0 });

    expect(runs.failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: true,
        failureCode: "pipeline_temporarily_unavailable",
        retryAfterSeconds: 30,
      }),
    );
    const failAttemptMock = runs.failAttempt as unknown as ReturnType<typeof vi.fn>;
    expect(JSON.stringify(failAttemptMock.mock.calls)).not.toContain("secret text");
    expect(queue.defer).toHaveBeenCalledWith("41", 30);
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it("persists a terminal failure and acknowledges only after that durable state", async () => {
    const queue = queueWith();
    const runs = storeWith(
      { kind: "acquired", context: context() },
      { status: "failed", retryAfterSeconds: null },
    );
    const pipeline = processor();
    pipeline.process.mockRejectedValueOnce(
      new PipelineWorkerFailure({
        code: "photo_unavailable",
        safeMessage: "A saved photo is no longer available.",
        retryable: false,
      }),
    );

    const summary = await consumePipelineQueue({ queue, runs, processor: pipeline });

    expect(summary.failed).toBe(1);
    const failAttemptMock = runs.failAttempt as unknown as ReturnType<typeof vi.fn>;
    expect(failAttemptMock.mock.invocationCallOrder[0]).toBeLessThan(
      queue.ack.mock.invocationCallOrder[0]!,
    );
    expect(queue.ack).toHaveBeenCalledWith("41");
  });

  it("rejects an unknown schema version without invoking the pipeline", async () => {
    const queue = queueWith({ run_id: RUN_ID, schema_version: 99 });
    const runs = storeWith();
    const pipeline = processor();

    const summary = await consumePipelineQueue({ queue, runs, processor: pipeline });

    expect(summary.failed).toBe(1);
    expect(runs.rejectMessage).toHaveBeenCalledWith({
      failureCode: "unsupported_schema_version",
      messageId: "41",
      runId: RUN_ID,
      safeFailureMessage: "This queued listing uses an unsupported job version.",
    });
    expect(pipeline.process).not.toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalledWith("41");
  });

  it("does not treat a forged run id as tenant authority", async () => {
    const queue = queueWith();
    const runs = storeWith({ kind: "mismatch" });
    const pipeline = processor();

    const summary = await consumePipelineQueue({ queue, runs, processor: pipeline });

    expect(summary.skipped).toBe(1);
    expect(pipeline.process).not.toHaveBeenCalled();
    expect(runs.checkpoint).not.toHaveBeenCalled();
    expect(runs.complete).not.toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalledWith("41");
  });

  it("defers an active lease and acknowledges duplicate delivery of a terminal run", async () => {
    const deferredQueue = queueWith();
    const deferredRuns = storeWith({ kind: "deferred", retryAfterSeconds: 45 });
    const pipeline = processor();

    const deferred = await consumePipelineQueue({
      queue: deferredQueue,
      runs: deferredRuns,
      processor: pipeline,
    });
    expect(deferred.skipped).toBe(1);
    expect(deferredQueue.defer).toHaveBeenCalledWith("41", 45);
    expect(deferredQueue.ack).not.toHaveBeenCalled();

    const duplicateQueue = queueWith();
    const duplicateRuns = storeWith({ kind: "terminal", status: "succeeded" });
    const duplicate = await consumePipelineQueue({
      queue: duplicateQueue,
      runs: duplicateRuns,
      processor: pipeline,
    });
    expect(duplicate.skipped).toBe(1);
    expect(duplicateQueue.ack).toHaveBeenCalledWith("41");
    expect(pipeline.process).not.toHaveBeenCalled();
  });

  it("rejects an unbounded consumer request before claiming", async () => {
    const queue = queueWith();
    await expect(
      consumePipelineQueue(
        { queue, runs: storeWith(), processor: processor() },
        { batchSize: 11 },
      ),
    ).rejects.toThrow();
    expect(queue.claim).not.toHaveBeenCalled();
  });
});
