import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PipelineResult } from "@/lib/pipeline";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { createPipelineQueueEnvelope } from "./envelope";
import {
  createSupabasePgmqPipelineQueue,
  type PipelineQueueRpcClient,
} from "./supabase-pgmq";
import {
  createSupabasePipelineWorkerStore,
  type PipelineAttemptAcquisition,
  type PipelineWorkerRpcClient,
} from "./worker-store";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESULT: PipelineResult = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
  price: {
    suggested: 149,
    range: { min: 130, max: 170 },
    confidence: 0.8,
    sources: [],
    tier: "llm-only",
  },
  confidence: { score: 0.86, band: "high", autopilotEligible: true },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Used headphones in good condition.",
    fields: { itemSpecifics: { Brand: "Sony" } },
  },
  model: "offline-vision",
  listingModel: "offline-listing",
};

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let reachable = false;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
let itemA = "";
let itemB = "";
let runA = "";
let runB = "";
let runRetry = "";
let messageA = "";
let messageB = "";
let messageRetry = "";
const messageIds = new Set<string>();

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_worker_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_worker_b"),
  ]);

  const [{ data: a, error: aError }, { data: b, error: bError }] = await Promise.all([
    userA.client
      .from("items")
      .insert({ user_id: userA.id, photos: [`${userA.id}/a.jpg`] })
      .select("id")
      .single(),
    userB.client
      .from("items")
      .insert({ user_id: userB.id, photos: [`${userB.id}/b.jpg`] })
      .select("id")
      .single(),
  ]);
  expect(aError).toBeNull();
  expect(bError).toBeNull();
  itemA = a!.id;
  itemB = b!.id;

  const [
    { data: aRun, error: aRunError },
    { data: bRun, error: bRunError },
    { data: retryRun, error: retryRunError },
  ] = await Promise.all([
    userA.client
      .from("pipeline_runs")
      .insert({
        user_id: userA.id,
        item_id: itemA,
        idempotency_key: `worker-a-${Date.now()}`,
        autopilot_enabled: true,
      })
      .select("id")
      .single(),
    userB.client
      .from("pipeline_runs")
      .insert({
        user_id: userB.id,
        item_id: itemB,
        idempotency_key: `worker-b-${Date.now()}`,
      })
      .select("id")
      .single(),
    userA.client
      .from("pipeline_runs")
      .insert({
        user_id: userA.id,
        item_id: itemA,
        idempotency_key: `worker-retry-${Date.now()}`,
      })
      .select("id")
      .single(),
  ]);
  expect(aRunError).toBeNull();
  expect(bRunError).toBeNull();
  expect(retryRunError).toBeNull();
  runA = aRun!.id;
  runB = bRun!.id;
  runRetry = retryRun!.id;

  const queue = createSupabasePgmqPipelineQueue(
    admin as unknown as PipelineQueueRpcClient,
  );
  [messageA, messageB, messageRetry] = await Promise.all([
    queue.enqueue(createPipelineQueueEnvelope(runA)),
    queue.enqueue(createPipelineQueueEnvelope(runB)),
    queue.enqueue(createPipelineQueueEnvelope(runRetry)),
  ]);
  messageIds.add(messageA).add(messageB).add(messageRetry);
});

afterAll(async () => {
  if (!reachable || !admin) return;
  await Promise.all(
    [...messageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

function acquired(
  value: PipelineAttemptAcquisition,
): Extract<PipelineAttemptAcquisition, { kind: "acquired" }> {
  expect(value.kind).toBe("acquired");
  return value as Extract<PipelineAttemptAcquisition, { kind: "acquired" }>;
}

describe("durable pipeline worker live DB/RLS boundary", () => {
  it("requires local Supabase for real lease and tenant proof", () => {
    if (!reachable) {
      console.warn(
        "[worker.rls.test] Local Supabase unavailable; reset and export supabase status env.",
      );
    }
    expect(true).toBe(true);
  });

  it("rejects a forged run/message pair without touching either tenant", async () => {
    if (!reachable) return;
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    await expect(
      store.acquire({ runId: runA, messageId: messageB, leaseSeconds: 60 }),
    ).resolves.toEqual({ kind: "mismatch" });

    const [{ data: aRun }, { data: bRun }] = await Promise.all([
      userA.client.from("pipeline_runs").select("status, attempt_count").eq("id", runA).single(),
      userB.client.from("pipeline_runs").select("status, attempt_count").eq("id", runB).single(),
    ]);
    expect(aRun).toEqual({ status: "queued", attempt_count: 0 });
    expect(bRun).toEqual({ status: "queued", attempt_count: 0 });
  });

  it("fences a stale lease, resumes checkpoints, and persists exactly one draft/log", async () => {
    if (!reachable) return;
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const first = acquired(
      await store.acquire({ runId: runA, messageId: messageA, leaseSeconds: 1 }),
    );
    await expect(
      store.acquire({ runId: runA, messageId: messageA, leaseSeconds: 60 }),
    ).resolves.toMatchObject({ kind: "deferred" });

    await sleep(1_100);
    const resumed = acquired(
      await store.acquire({ runId: runA, messageId: messageA, leaseSeconds: 60 }),
    );
    expect(resumed.context.run.attempt_count).toBe(2);
    expect(resumed.context.run.lease_token).not.toBe(first.context.run.lease_token);

    await expect(
      store.checkpoint({
        runId: runA,
        leaseToken: first.context.run.lease_token,
        stage: "identifying",
        checkpoint: { identified: { attributes: RESULT.attributes, model: RESULT.model } },
        leaseSeconds: 60,
      }),
    ).rejects.toThrow(/stale/i);

    const identified = {
      identified: {
        attributes: RESULT.attributes,
        identification: RESULT.identification,
        model: RESULT.model,
      },
    };
    const priced = { ...identified, priced: RESULT.price };
    const generated = {
      ...priced,
      generated: { copy: RESULT.listing, model: RESULT.listingModel! },
    };
    await store.checkpoint({
      runId: runA,
      leaseToken: resumed.context.run.lease_token,
      stage: "identifying",
      checkpoint: identified,
      leaseSeconds: 60,
    });
    await expect(
      store.checkpoint({
        runId: runA,
        leaseToken: resumed.context.run.lease_token,
        stage: "identifying",
        checkpoint: {},
        leaseSeconds: 60,
      }),
    ).rejects.toThrow(/checkpoint/i);
    await store.checkpoint({
      runId: runA,
      leaseToken: resumed.context.run.lease_token,
      stage: "pricing",
      checkpoint: priced,
      leaseSeconds: 60,
    });
    await store.checkpoint({
      runId: runA,
      leaseToken: resumed.context.run.lease_token,
      stage: "generating",
      checkpoint: generated,
      leaseSeconds: 60,
    });
    await store.complete({
      runId: runA,
      leaseToken: resumed.context.run.lease_token,
      result: RESULT,
      autopilotEnabled: true,
    });

    const [{ data: run }, { data: listings }, { data: logs }, { data: bVisible }] =
      await Promise.all([
        userA.client
          .from("pipeline_runs")
          .select("status, stage, listing_id, attempt_count")
          .eq("id", runA)
          .single(),
        userA.client.from("listings").select("id, item_id, run_id, status").eq("run_id", runA),
        userA.client.from("prediction_logs").select("id, item_id, run_id").eq("run_id", runA),
        userB.client.from("pipeline_runs").select("id").eq("id", runA),
      ]);
    expect(run).toMatchObject({ status: "succeeded", stage: "completed", attempt_count: 2 });
    expect(listings).toHaveLength(1);
    expect(listings?.[0]).toMatchObject({ item_id: itemA, run_id: runA, status: "queued" });
    expect(logs).toHaveLength(1);
    expect(logs?.[0]).toMatchObject({ item_id: itemA, run_id: runA });
    expect(bVisible).toEqual([]);

    await expect(
      store.complete({
        runId: runA,
        leaseToken: resumed.context.run.lease_token,
        result: RESULT,
        autopilotEnabled: true,
      }),
    ).rejects.toThrow(/stale/i);
    await expect(
      store.acquire({ runId: runA, messageId: messageA, leaseSeconds: 60 }),
    ).resolves.toEqual({ kind: "terminal", status: "succeeded" });
  }, 15_000);

  it("persists transient retry backoff, then an honest terminal failure", async () => {
    if (!reachable) return;
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const queue = createSupabasePgmqPipelineQueue(
      admin as unknown as PipelineQueueRpcClient,
    );
    const attempt = acquired(
      await store.acquire({ runId: runRetry, messageId: messageRetry, leaseSeconds: 60 }),
    );
    await expect(
      store.failAttempt({
        runId: runRetry,
        leaseToken: attempt.context.run.lease_token,
        retryable: true,
        retryAfterSeconds: 1,
        failureCode: "provider_timeout",
        safeFailureMessage: "SnapList will retry this listing.",
      }),
    ).resolves.toEqual({ status: "retrying", retryAfterSeconds: 1 });
    await expect(queue.defer(messageRetry, 1)).resolves.toBe(true);

    await sleep(1_100);
    const second = acquired(
      await store.acquire({ runId: runRetry, messageId: messageRetry, leaseSeconds: 60 }),
    );
    await expect(
      store.failAttempt({
        runId: runRetry,
        leaseToken: second.context.run.lease_token,
        retryable: false,
        retryAfterSeconds: 1,
        failureCode: "invalid_pipeline_result",
        safeFailureMessage: "The generated listing did not pass validation.",
      }),
    ).resolves.toEqual({ status: "failed", retryAfterSeconds: null });

    const { data: failed } = await userA.client
      .from("pipeline_runs")
      .select("status, attempt_count, failure_code, safe_failure_message, completed_at")
      .eq("id", runRetry)
      .single();
    expect(failed).toMatchObject({
      status: "failed",
      attempt_count: 2,
      failure_code: "invalid_pipeline_result",
      safe_failure_message: "The generated listing did not pass validation.",
    });
    expect(failed?.completed_at).toBeTruthy();
  });

  it("rejects unknown-version work only for the message-paired run", async () => {
    if (!reachable) return;
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    await expect(
      store.rejectMessage({
        runId: runB,
        messageId: messageA,
        failureCode: "unsupported_schema_version",
        safeFailureMessage: "Unsupported job version.",
      }),
    ).resolves.toBe(false);
    await expect(
      store.rejectMessage({
        runId: runB,
        messageId: messageB,
        failureCode: "unsupported_schema_version",
        safeFailureMessage: "Unsupported job version.",
      }),
    ).resolves.toBe(true);

    const { data: bRun } = await userB.client
      .from("pipeline_runs")
      .select("status, failure_code")
      .eq("id", runB)
      .single();
    expect(bRun).toEqual({ status: "failed", failure_code: "unsupported_schema_version" });
  });
});
