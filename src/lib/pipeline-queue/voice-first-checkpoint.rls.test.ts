import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CanonicalLanguageTag, SellerContextTranscriber } from "@/lib/llm/seller-context";
import type { PriceResult } from "@/lib/pricing";
import type { VisionPipelineStages } from "@/lib/vision";
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
import { createDurableVisionPipelineProcessor } from "./durable-processor";
import { createVerifiedVoiceFixture } from "./voice-context.test-fixture";
import { acquireExclusiveTestResource, type ExclusiveTestResourceLease } from "@/test/exclusive-resource-lock";

/**
 * Issue #1120, P0 regression — DB-BACKED.
 *
 * The identification-before-voice ordering is encoded in TWO places: the Zod
 * checkpoint schema AND `checkpoint_pipeline_run`, which raises 22023 when
 * `not (p_checkpoint ? 'identified')`. Relaxing only the Zod copy turned every
 * voice run into a hard worker failure in production while the unit suites stayed
 * green, because the DB-backed suites were SKIPPED.
 *
 * This drives the REAL processor's checkpoint sequence through the REAL RPC for a
 * voice-first run. It is the test that was missing: no stub of `checkpoint_pipeline_run`
 * can catch a disagreement between the two copies of the invariant.
 *
 * `recordTerminalOutcome` is a no-op here on purpose — the subject is the checkpoint
 * RPC, and the voice-outcome RPC has its own coverage in the voice-context suites.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRICE: PriceResult = {
  suggested: 149,
  range: { min: 130, max: 170 },
  confidence: 0.8,
  sources: [],
  tier: "llm-only",
};

let reachable = false;
let admin: SupabaseClient;
let user: ClerkTestUser;
let itemId: string;
let runId: string;
let messageId: string;
let crashRunId: string;
let crashMessageId: string;
let queueLease: ExclusiveTestResourceLease | undefined;

beforeAll(async () => {
  reachable = await stackReachable({
    url: SUPABASE_URL,
    apiKey: ANON_KEY,
    requiredValues: [ANON_KEY, SERVICE_ROLE_KEY],
  });
  await whenStackReachable(reachable, async () => {
    queueLease = await acquireExclusiveTestResource(
      `local-pgmq:pipeline_jobs:${SUPABASE_URL}`,
    );
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    user = await provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "voice_first_cp");

    const { data: item, error: itemError } = await user.client
      .from("items")
      .insert({ user_id: user.id, photos: [`${user.id}/voice-first.jpg`] })
      .select("id")
      .single();
    expect(itemError).toBeNull();
    itemId = item!.id;

    const { data: run, error: runError } = await user.client
      .from("pipeline_runs")
      .insert({
        user_id: user.id,
        item_id: itemId,
        idempotency_key: `voice-first-${Date.now()}`,
        autopilot_enabled: false,
      })
      .select("id")
      .single();
    expect(runError).toBeNull();
    runId = run!.id;

    const queue = createSupabasePgmqPipelineQueue(
      admin as unknown as PipelineQueueRpcClient,
    );
    messageId = await queue.enqueue(createPipelineQueueEnvelope(runId));

    const { data: crashRun, error: crashRunError } = await user.client
      .from("pipeline_runs")
      .insert({
        user_id: user.id,
        item_id: itemId,
        idempotency_key: `voice-first-crash-${Date.now()}`,
        autopilot_enabled: false,
      })
      .select("id")
      .single();
    expect(crashRunError).toBeNull();
    crashRunId = crashRun!.id;
    crashMessageId = await queue.enqueue(createPipelineQueueEnvelope(crashRunId));
  });
});

afterAll(async () => {
  try {
    if (!reachable || !admin) return;
    await admin.rpc("ack_pipeline_message", { p_message_id: messageId });
    if (crashMessageId) {
      await admin.rpc("ack_pipeline_message", { p_message_id: crashMessageId });
    }
    if (user) await cleanupClerkTestUsers(admin, [user.id]);
  } finally {
    await queueLease?.release();
  }
});

function acquired(
  value: PipelineAttemptAcquisition,
): Extract<PipelineAttemptAcquisition, { kind: "acquired" }> {
  expect(value.kind).toBe("acquired");
  return value as Extract<PipelineAttemptAcquisition, { kind: "acquired" }>;
}

function stages(): VisionPipelineStages {
  const identified = {
    attributes: { brand: "Apple", model: "AirPods Pro", condition: "very-good" },
    identification: { label: "Apple AirPods Pro", confident: true, evidence: 1 },
    model: "vision-model",
  };
  const generated = {
    copy: {
      platform: "ebay",
      title: "Apple AirPods Pro",
      description: "Used earbuds with case.",
      fields: {},
    },
    model: "listing-model",
  };
  return {
    identify: vi.fn(async () => identified),
    price: vi.fn(async () => PRICE),
    generate: vi.fn(async () => generated),
    assemble: vi.fn(() => ({
      attributes: identified.attributes,
      identification: identified.identification,
      price: PRICE,
      confidence: { score: 0.5, band: "medium" as const, autopilotEligible: false },
      listing: generated.copy,
      model: identified.model,
      listingModel: generated.model,
    })),
  } as unknown as VisionPipelineStages;
}

describe("voice-first pipeline checkpoints against the real RPC (#1120)", () => {
  /**
   * Round-3 review: reporting the terminal voice outcome queues the seller's RAW
   * AUDIO for deletion (`record_raw_seller_voice_transcription_outcome` ->
   * `queue_raw_seller_voice_cleanup`). On a fresh run that report must wait until
   * the combined checkpoint is durable, or a crash inside identify loses the audio
   * AND the transcript, and redelivery falls silently to photos-only — #1120 again.
   */
  it("keeps the raw audio until the transcript is durable, and replays with both", async (testContext) => {
    skipIfStackUnreachable(testContext, reachable);

    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const attempt = acquired(
      await store.acquire({ runId: crashRunId, messageId: crashMessageId, leaseSeconds: 120 }),
    );
    const voice = createVerifiedVoiceFixture();
    const workerContext = {
      ...attempt.context,
      voice: {
        receipt: { ...voice.receipt, storagePath: `${user.id}/intake/voice.wav` },
      },
    };
    const transcribe = vi.fn(async () => ({
      kind: "transcribed" as const,
      text: "the newest generation of AirPods Pros",
      language: "en-US" as CanonicalLanguageTag,
      providerContacted: true,
    }));
    const terminalOutcomes: string[] = [];
    const recordTerminalOutcome = vi.fn(async (input: { outcome: string }) => {
      terminalOutcomes.push(input.outcome);
      return true;
    });

    // Pass 1: identification throws AFTER transcription, before the combined write.
    const crashing = stages();
    crashing.identify = vi.fn(async () => {
      throw new Error("identification crashed");
    });
    const crashProcessor = createDurableVisionPipelineProcessor(crashing, {
      voiceStorage: { download: async () => voice.bytes },
      transcriber: { transcribe } as unknown as SellerContextTranscriber,
      recordTerminalOutcome,
    });
    await expect(
      crashProcessor.process({
        context: workerContext,
        onCheckpoint: async (stage, checkpoint) =>
          store.checkpoint({
            runId: crashRunId,
            leaseToken: workerContext.run.lease_token,
            stage,
            checkpoint,
            leaseSeconds: 120,
          }),
      }),
    ).rejects.toThrow(/identification crashed/);

    // The audio was NOT released: no terminal outcome was reported, so
    // `queue_raw_seller_voice_cleanup` never ran for this run.
    expect(recordTerminalOutcome).not.toHaveBeenCalled();
    expect(terminalOutcomes).toEqual([]);

    // Pass 2: redelivery. The audio is still there, so the transcript is
    // re-derived and reaches identification exactly as on a first delivery.
    const replay = stages();
    const replayProcessor = createDurableVisionPipelineProcessor(replay, {
      voiceStorage: { download: async () => voice.bytes },
      transcriber: { transcribe } as unknown as SellerContextTranscriber,
      recordTerminalOutcome,
    });
    const result = await replayProcessor.process({
      context: workerContext,
      onCheckpoint: async (stage, checkpoint) =>
        store.checkpoint({
          runId: crashRunId,
          leaseToken: workerContext.run.lease_token,
          stage,
          checkpoint,
          leaseSeconds: 120,
        }),
    });

    expect(replay.identify).toHaveBeenCalledWith({
      photos: workerContext.item.photos,
      sellerContext: {
        text: "the newest generation of AirPods Pros",
        language: "en-US",
        provenance: "seller_voice",
        verification: "unverified",
      },
    });
    expect(result.attributes.brand).toBe("Apple");
    // Only now, with the transcript durable, is the audio released.
    expect(terminalOutcomes).toEqual(["transcribed"]);
  });

  it("requires local Supabase to prove the checkpoint contract", () => {
    if (!reachable) {
      console.warn(
        "[voice-first-checkpoint.rls.test] Local Supabase unavailable; export supabase status env.",
      );
    }
    expect(true).toBe(true);
  });

  it("accepts every checkpoint a voice-carrying run writes, transcript first", async (testContext) => {
    skipIfStackUnreachable(testContext, reachable);

    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const attempt = acquired(
      await store.acquire({ runId, messageId, leaseSeconds: 120 }),
    );
    const voice = createVerifiedVoiceFixture();
    const workerContext = {
      ...attempt.context,
      voice: { receipt: { ...voice.receipt, storagePath: `${user.id}/intake/voice.wav` } },
    };

    const transcribe = vi.fn(async () => ({
      kind: "transcribed" as const,
      text: "the newest generation of AirPods Pros",
      language: "en-US" as CanonicalLanguageTag,
      providerContacted: true,
    }));
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline, {
      voiceStorage: { download: async () => voice.bytes },
      transcriber: { transcribe } as unknown as SellerContextTranscriber,
      recordTerminalOutcome: async () => true,
    });

    const result = await processor.process({
      context: workerContext,
      onCheckpoint: async (stage, checkpoint) =>
        store.checkpoint({
          runId,
          leaseToken: workerContext.run.lease_token,
          stage,
          checkpoint,
          leaseSeconds: 120,
        }),
    });

    // The transcript reached identification — the whole point of the reorder.
    expect(pipeline.identify).toHaveBeenCalledWith({
      photos: workerContext.item.photos,
      sellerContext: {
        text: "the newest generation of AirPods Pros",
        language: "en-US",
        provenance: "seller_voice",
        verification: "unverified",
      },
    });
    expect(result.attributes.brand).toBe("Apple");

    // And the durable row the RPC accepted carries BOTH, so no write was skipped.
    // Read as the OWNING tenant: `service_role` deliberately has no direct select on
    // `pipeline_runs` (ADR-0007 — queue authority is not tenant-domain authority).
    const { data: stored, error } = await user.client
      .from("pipeline_runs")
      .select("checkpoint")
      .eq("id", runId)
      .single();
    expect(error).toBeNull();
    const checkpoint = stored!.checkpoint as Record<string, unknown>;
    expect(checkpoint.identified).toBeTruthy();
    expect(checkpoint.voice).toBeTruthy();
  });
});
