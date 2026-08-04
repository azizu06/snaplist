import { describe, expect, it } from "vitest";
import type { PipelineResult } from "@/lib/pipeline";
import { createPipelineQueueEnvelope } from "./envelope";
import { createInMemoryPipelineQueue } from "./memory";
import type { PipelineQueue } from "./queue";
import type { PipelineWorkerCheckpointWrite } from "./checkpoint";
import { createDatabaseCheckpointClock } from "./checkpoint-clock.testing";
import type {
  PipelineAttemptFailureResult,
  PipelineRunStatus,
  PipelineWorkerContext,
  PipelineWorkerStore,
} from "./worker-store";
import {
  PipelineWorkerFailure,
  consumePipelineQueue,
  type DurablePipelineProcessor,
} from "./worker";

const RESULT: PipelineResult = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
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

interface AcceptanceRun {
  id: string;
  itemId: string;
  messageId: string;
  status: PipelineRunStatus;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number | null;
  completionCount: number;
  notifications: Set<string>;
  checkpoint: Record<string, unknown>;
}

class AcceptanceStore implements PipelineWorkerStore {
  readonly runs = new Map<string, AcceptanceRun>();

  private readonly databaseClock = createDatabaseCheckpointClock(
    () => new Date(this.now()).toISOString(),
  );

  constructor(private readonly now: () => number) {}

  add(runId: string, itemId: string, messageId: string, maxAttempts = 3) {
    this.runs.set(runId, {
      id: runId,
      itemId,
      messageId,
      status: "queued",
      attemptCount: 0,
      maxAttempts,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      completionCount: 0,
      notifications: new Set(),
      checkpoint: {},
    });
  }

  async acquire(input: { runId: string; messageId: string; leaseSeconds: number }) {
    const run = this.runs.get(input.runId);
    if (!run || run.messageId !== input.messageId) return { kind: "mismatch" } as const;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      return { kind: "terminal", status: run.status as "succeeded" | "failed" | "canceled" } as const;
    }
    if (run.status === "running" && (run.leaseExpiresAt ?? 0) > this.now()) {
      return {
        kind: "deferred",
        retryAfterSeconds: Math.max(1, Math.ceil(((run.leaseExpiresAt ?? 0) - this.now()) / 1_000)),
      } as const;
    }
    if (run.status === "running") {
      run.status = "retrying";
      run.leaseToken = null;
      run.leaseExpiresAt = null;
      run.nextAttemptAt = this.now();
    }
    if (run.status === "retrying" && (run.nextAttemptAt ?? 0) > this.now()) {
      return {
        kind: "deferred",
        retryAfterSeconds: Math.max(1, Math.ceil(((run.nextAttemptAt ?? 0) - this.now()) / 1_000)),
      } as const;
    }
    if (run.attemptCount >= run.maxAttempts) {
      run.status = "failed";
      run.notifications.add("pipeline_failed");
      return { kind: "terminal", status: "failed" } as const;
    }

    run.status = "running";
    run.attemptCount += 1;
    run.nextAttemptAt = null;
    run.leaseToken = `90000000-0000-4000-8000-${String(run.attemptCount).padStart(12, "0")}`;
    run.leaseExpiresAt = this.now() + input.leaseSeconds * 1_000;
    return { kind: "acquired", context: this.context(run) } as const;
  }

  async checkpoint(input: {
    runId: string;
    leaseToken: string;
    stage: "identifying" | "pricing" | "generating" | "persisting";
    checkpoint: PipelineWorkerCheckpointWrite;
    leaseSeconds: number;
  }) {
    const run = this.currentLease(input.runId, input.leaseToken);
    const checkpoint = this.databaseClock.stamp({
      ...run.checkpoint,
      ...input.checkpoint,
    } as PipelineWorkerCheckpointWrite);
    run.checkpoint = checkpoint;
    run.leaseExpiresAt = this.now() + input.leaseSeconds * 1_000;
    return checkpoint;
  }

  async stageGuestRecoveryUploadCleanup() {}

  async complete(input: { runId: string; leaseToken: string }) {
    const run = this.currentLease(input.runId, input.leaseToken);
    if (run.status !== "succeeded") {
      run.status = "succeeded";
      run.completionCount += 1;
      run.notifications.add("listing_ready");
    }
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    return { listingId: "91000000-0000-4000-8000-000000000001" };
  }

  async failAttempt(input: {
    runId: string;
    leaseToken: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }): Promise<PipelineAttemptFailureResult> {
    const run = this.currentLease(input.runId, input.leaseToken);
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    if (input.retryable && run.attemptCount < run.maxAttempts) {
      run.status = "retrying";
      run.nextAttemptAt = this.now() + input.retryAfterSeconds * 1_000;
      return { status: "retrying", retryAfterSeconds: input.retryAfterSeconds };
    }
    run.status = "failed";
    run.notifications.add("pipeline_failed");
    return { status: "failed", retryAfterSeconds: null };
  }

  async rejectMessage(input: { runId: string; messageId: string }) {
    const run = this.runs.get(input.runId);
    if (!run || run.messageId !== input.messageId) return false;
    run.status = "failed";
    run.notifications.add("pipeline_failed");
    return true;
  }

  private currentLease(runId: string, leaseToken: string): AcceptanceRun {
    const run = this.runs.get(runId);
    if (
      !run
      || run.status !== "running"
      || run.leaseToken !== leaseToken
      || (run.leaseExpiresAt ?? 0) <= this.now()
    ) {
      throw new Error("stale acceptance lease");
    }
    return run;
  }

  private context(run: AcceptanceRun): PipelineWorkerContext {
    return {
      run: {
        id: run.id,
        user_id: "acceptance-user",
        item_id: run.itemId,
        listing_id: null,
        status: "running",
        stage: "identifying",
        schema_version: 1,
        attempt_count: run.attemptCount,
        max_attempts: run.maxAttempts,
        autopilot_enabled: false,
        checkpoint: run.checkpoint,
        lease_token: run.leaseToken!,
        lease_expires_at: new Date(run.leaseExpiresAt!).toISOString(),
        next_attempt_at: run.nextAttemptAt === null
          ? null
          : new Date(run.nextAttemptAt).toISOString(),
        recovery_id: null,
        recovery_token_hash: null,
      },
      item: {
        id: run.itemId,
        user_id: "acceptance-user",
        photos: [`acceptance-user/${run.itemId}.jpg`],
        photo_identity_kind: "content_sha256_set_v1",
        photo_identity_fingerprint: "a".repeat(64),
        attributes: {},
        condition: null,
        cost_basis: null,
        review_revision: "92000000-0000-4000-8000-000000000001",
        review_content_revision: "93000000-0000-4000-8000-000000000001",
      },
    };
  }
}

class AcceptanceProcessor implements DurablePipelineProcessor {
  readonly calls = new Map<string, number>();
  readonly failures = new Map<string, unknown[]>();

  failNext(runId: string, error: unknown) {
    this.failures.set(runId, [...(this.failures.get(runId) ?? []), error]);
  }

  async process(input: Parameters<DurablePipelineProcessor["process"]>[0]) {
    const runId = input.context.run.id;
    this.calls.set(runId, (this.calls.get(runId) ?? 0) + 1);
    const failure = this.failures.get(runId)?.shift();
    if (failure) throw failure;
    await input.onCheckpoint("identifying", {
      identified: {
        attributes: RESULT.attributes,
        identification: RESULT.identification,
        model: RESULT.model,
      },
    });
    return RESULT;
  }
}

function ids(index: number) {
  const suffix = String(index).padStart(12, "0");
  return {
    runId: `a1000000-0000-4000-8000-${suffix}`,
    itemId: `a2000000-0000-4000-8000-${suffix}`,
  };
}

async function enqueueRun(
  queue: PipelineQueue,
  store: AcceptanceStore,
  index: number,
) {
  const { runId, itemId } = ids(index);
  const messageId = await queue.enqueue(createPipelineQueueEnvelope(runId));
  store.add(runId, itemId, messageId);
  return { runId, itemId, messageId };
}

describe("durable pipeline deterministic crash/replay acceptance", () => {
  it("survives refresh/close because accepted work is detached from the request", async () => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const queue = createInMemoryPipelineQueue({ now: () => new Date(now) });
    const store = new AcceptanceStore(() => now);
    const accepted = await enqueueRun(queue, store, 1);

    // The producer/request scope is gone here; a newly composed worker drains
    // the same durable queue and run state.
    const summary = await consumePipelineQueue({
      queue,
      runs: store,
      processor: new AcceptanceProcessor(),
    });

    expect(summary.succeeded).toBe(1);
    expect(store.runs.get(accepted.runId)?.status).toBe("succeeded");
  });

  it("recovers after a worker timeout with a new fenced attempt", async () => {
    let now = Date.parse("2026-07-17T00:00:00.000Z");
    const queue = createInMemoryPipelineQueue({ now: () => new Date(now) });
    const store = new AcceptanceStore(() => now);
    const accepted = await enqueueRun(queue, store, 2);
    const [claimed] = await queue.claim({ limit: 1, visibilityTimeoutSeconds: 300 });
    await store.acquire({
      runId: accepted.runId,
      messageId: claimed!.id,
      leaseSeconds: 300,
    });

    now += 301_000;
    const summary = await consumePipelineQueue({
      queue,
      runs: store,
      processor: new AcceptanceProcessor(),
    });

    expect(summary.succeeded).toBe(1);
    expect(store.runs.get(accepted.runId)?.attemptCount).toBe(2);
  });

  it("turns a transient provider error into delayed replay and success", async () => {
    let now = Date.parse("2026-07-17T00:00:00.000Z");
    const queue = createInMemoryPipelineQueue({ now: () => new Date(now) });
    const store = new AcceptanceStore(() => now);
    const processor = new AcceptanceProcessor();
    const accepted = await enqueueRun(queue, store, 3);
    processor.failNext(accepted.runId, new Error("provider timeout"));

    await expect(consumePipelineQueue({ queue, runs: store, processor }))
      .resolves.toMatchObject({ retrying: 1, succeeded: 0 });
    now += 31_000;
    await expect(consumePipelineQueue({ queue, runs: store, processor }))
      .resolves.toMatchObject({ retrying: 0, succeeded: 1 });
    expect(store.runs.get(accepted.runId)?.attemptCount).toBe(2);
  });

  it("persists a terminal failure before removing the queue message", async () => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const queue = createInMemoryPipelineQueue({ now: () => new Date(now) });
    const store = new AcceptanceStore(() => now);
    const processor = new AcceptanceProcessor();
    const accepted = await enqueueRun(queue, store, 4);
    processor.failNext(accepted.runId, new PipelineWorkerFailure({
      code: "photo_unavailable",
      safeMessage: "A saved photo is no longer available.",
      retryable: false,
    }));

    await expect(consumePipelineQueue({ queue, runs: store, processor }))
      .resolves.toMatchObject({ failed: 1 });
    expect(store.runs.get(accepted.runId)?.status).toBe("failed");
    expect(store.runs.get(accepted.runId)?.notifications).toEqual(
      new Set(["pipeline_failed"]),
    );
    await expect(queue.claim({ limit: 1, visibilityTimeoutSeconds: 300 }))
      .resolves.toEqual([]);
  });

  it("commits successful entries when another entry in the batch retries", async () => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const queue = createInMemoryPipelineQueue({ now: () => new Date(now) });
    const store = new AcceptanceStore(() => now);
    const processor = new AcceptanceProcessor();
    const first = await enqueueRun(queue, store, 5);
    const second = await enqueueRun(queue, store, 6);
    processor.failNext(second.runId, new Error("transient provider error"));

    await expect(consumePipelineQueue(
      { queue, runs: store, processor },
      { batchSize: 5 },
    )).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      retrying: 1,
      failed: 0,
      skipped: 0,
    });
    expect(store.runs.get(first.runId)?.status).toBe("succeeded");
    expect(store.runs.get(second.runId)?.status).toBe("retrying");
  });

  it("replays a duplicate delivery without a second completion or notification", async () => {
    let now = Date.parse("2026-07-17T00:00:00.000Z");
    const durableQueue = createInMemoryPipelineQueue({ now: () => new Date(now) });
    let loseFirstAck = true;
    const queue: PipelineQueue = {
      enqueue: (input) => durableQueue.enqueue(input),
      claim: (input) => durableQueue.claim(input),
      defer: (messageId, seconds) => durableQueue.defer(messageId, seconds),
      ack: async (messageId) => {
        if (loseFirstAck) {
          loseFirstAck = false;
          return false;
        }
        return durableQueue.ack(messageId);
      },
    };
    const store = new AcceptanceStore(() => now);
    const processor = new AcceptanceProcessor();
    const accepted = await enqueueRun(queue, store, 7);

    await consumePipelineQueue({ queue, runs: store, processor });
    now += 301_000;
    await expect(consumePipelineQueue({ queue, runs: store, processor }))
      .resolves.toMatchObject({ skipped: 1, succeeded: 0 });

    const run = store.runs.get(accepted.runId)!;
    expect(run.completionCount).toBe(1);
    expect(run.notifications).toEqual(new Set(["listing_ready"]));
    expect(processor.calls.get(accepted.runId)).toBe(1);
  });
});
