import { describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "@/lib/pipeline";
import {
  createSupabasePipelineWorkerStore,
  type PipelineWorkerRpcClient,
} from "./worker-store";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const LISTING_ID = "66666666-6666-4666-8666-666666666666";

const RESULT: PipelineResult = {
  attributes: { brand: "Sony", condition: "good" },
  price: {
    suggested: 50,
    range: { min: 40, max: 60 },
    confidence: 0.5,
    sources: [
      {
        url: "https://www.ebay.com/itm/sold-1",
        title: "Sold Sony headphones",
        kind: "sold-comp",
      },
      {
        url: "https://www.ebay.com/itm/asking-1",
        title: "Best offer accepted",
        kind: "asking-comp",
      },
    ],
    tier: "ebay-sold",
    evidence: [
      {
        id: "sold-1",
        sourceUrl: "https://www.ebay.com/itm/sold-1",
        title: "Sold Sony headphones",
        price: 50,
        currency: "USD",
        kind: "sold-comparable",
        priceDisclosure: "displayed-sold-price",
      },
      {
        id: "asking-1",
        sourceUrl: "https://www.ebay.com/itm/asking-1",
        title: "Best offer accepted",
        price: 70,
        currency: "USD",
        kind: "sold-comparable",
        priceDisclosure: "asking-price-not-accepted-amount",
      },
    ],
  },
  confidence: { score: 0.5, band: "medium", autopilotEligible: false },
  listing: {
    platform: "ebay",
    title: "Sony headphones",
    description: "Used headphones.",
    fields: {},
  },
  model: "vision-model",
  listingModel: "listing-model",
};

function rpcClient(responses: Record<string, unknown>) {
  return {
    rpc: vi.fn(async (name: string) => ({ data: responses[name], error: null })),
  } as unknown as PipelineWorkerRpcClient & { rpc: ReturnType<typeof vi.fn> };
}

describe("run-scoped pipeline worker store", () => {
  it("acquires only a run paired to the claimed queue message", async () => {
    const context = {
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
        lease_token: LEASE_TOKEN,
        lease_expires_at: "2026-07-15T04:10:00.000Z",
        next_attempt_at: null,
        recovery_id: null,
        recovery_token_hash: null,
      },
      item: {
        id: ITEM_ID,
        user_id: "user_a",
        photos: Array.from(
          { length: 5 },
          (_, ordinal) => `user_a/photo-${ordinal}.jpg`,
        ),
        photo_identity_kind: "legacy_path_v0",
        photo_identity_fingerprint: "a".repeat(64),
        attributes: {},
        condition: null,
        cost_basis: null,
        review_revision: "44444444-4444-4444-8444-444444444444",
        review_content_revision: "55555555-5555-4555-8555-555555555555",
      },
    };
    const client = rpcClient({
      claim_pipeline_run_attempt: { kind: "acquired", context },
    });
    const store = createSupabasePipelineWorkerStore(client);

    await expect(
      store.acquire({ runId: RUN_ID, messageId: "41", leaseSeconds: 300 }),
    ).resolves.toEqual({ kind: "acquired", context });
    expect(context.item.photos).toEqual([
      "user_a/photo-0.jpg",
      "user_a/photo-1.jpg",
      "user_a/photo-2.jpg",
      "user_a/photo-3.jpg",
      "user_a/photo-4.jpg",
    ]);
    expect(client.rpc).toHaveBeenCalledWith("claim_pipeline_run_attempt", {
      p_lease_seconds: 300,
      p_message_id: "41",
      p_run_id: RUN_ID,
    });
  });

  it("checkpoints and completes through identity-free persistence payloads", async () => {
    const checkpoint = {
      identified: { attributes: RESULT.attributes, model: RESULT.model },
      priced: { result: RESULT.price },
    };
    const persistedCheckpoint = {
      ...checkpoint,
      priced: {
        ...checkpoint.priced,
        evidenceAsOf: "2026-07-20T08:00:00.000Z",
      },
    };
    const client = rpcClient({
      checkpoint_pipeline_run: persistedCheckpoint,
      complete_pipeline_run_with_guest_recovery: { listingId: LISTING_ID },
    });
    const store = createSupabasePipelineWorkerStore(client);

    await expect(
      store.checkpoint({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        stage: "pricing",
        checkpoint,
        leaseSeconds: 300,
      }),
    ).resolves.toEqual(persistedCheckpoint);
    await expect(
      store.complete({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        result: RESULT,
        autopilotEnabled: false,
      }),
    ).resolves.toEqual({ listingId: LISTING_ID });

    const completion = client.rpc.mock.calls.find(
      ([name]) => name === "complete_pipeline_run_with_guest_recovery",
    )?.[1] as Record<string, unknown>;
    expect(client.rpc).toHaveBeenCalledWith("checkpoint_pipeline_run", {
      p_checkpoint: checkpoint,
      p_lease_seconds: 300,
      p_lease_token: LEASE_TOKEN,
      p_run_id: RUN_ID,
      p_stage: "pricing",
    });
    expect(completion).not.toHaveProperty("user_id");
    expect(completion).not.toHaveProperty("item_id");
    expect(completion.p_persistence).toMatchObject({
      listing: { status: "draft" },
      prediction: { model: "vision-model", listing_model: "listing-model" },
      pricing_snapshot: {
        schema_version: 1,
        item: { title: "Sony headphones", condition: "good" },
        price_result: {
          suggested: 50,
          range: { min: 40, max: 60 },
          tier: "ebay-sold",
        },
        evidence: [
          expect.objectContaining({
            id: "sold-1",
            priceDisclosure: "displayed-sold-price",
          }),
        ],
      },
    });
    const persistence = completion.p_persistence as {
      pricing_snapshot: {
        price_result: { evidence?: Array<{ id: string }> };
        evidence: Array<{ id: string }>;
      };
    };
    expect(persistence.pricing_snapshot.price_result).not.toHaveProperty("evidence");
    expect(persistence.pricing_snapshot.evidence.map(({ id }) => id)).toEqual(["sold-1"]);
  });

  it("stages bounded orphan cleanup through the acquired run and lease", async () => {
    const client = rpcClient({
      stage_guest_recovery_upload_cleanup: true,
    });
    const store = createSupabasePipelineWorkerStore(client);
    const paths = [
      "guest_0123456789abcdef0123456789abcdef0123456789abcdef/guest-recovery/63800000-0000-4000-8000-000000000003/0-front.enc",
    ];

    await expect(store.stageGuestRecoveryUploadCleanup({
      runId: RUN_ID,
      leaseToken: LEASE_TOKEN,
      paths,
    })).resolves.toBeUndefined();
    expect(client.rpc).toHaveBeenCalledWith(
      "stage_guest_recovery_upload_cleanup",
      {
        p_lease_token: LEASE_TOKEN,
        p_photo_paths: paths,
        p_run_id: RUN_ID,
      },
    );
  });

  it("never sends a PostgreSQL-unsafe checkpoint string to the RPC", async () => {
    const nul = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd800);
    const replacement = String.fromCharCode(0xfffd);
    const client = rpcClient({ checkpoint_pipeline_run: {} });
    const store = createSupabasePipelineWorkerStore(client);

    await store.checkpoint({
      runId: RUN_ID,
      leaseToken: LEASE_TOKEN,
      stage: "identifying",
      checkpoint: {
        identified: {
          attributes: { brand: `Sony${nul}WH${loneSurrogate}` },
          model: "vision-model",
        },
      },
      leaseSeconds: 300,
    });

    const sent = client.rpc.mock.calls.find(
      ([name]) => name === "checkpoint_pipeline_run",
    )?.[1] as Record<string, unknown>;
    expect(sent.p_checkpoint).toEqual({
      identified: {
        attributes: { brand: `SonyWH${replacement}` },
        model: "vision-model",
      },
    });
    // PostgREST/Postgres reject these two escapes; neither may reach the wire.
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("\\u0000");
    expect(wire).not.toContain("\\ud800");
  });

  it("sends the run's measured provider usage through a lease-fenced RPC", async () => {
    const client = rpcClient({ record_pipeline_run_provider_usage: true });
    const store = createSupabasePipelineWorkerStore(client);

    await store.recordProviderUsage({
      runId: RUN_ID,
      leaseToken: LEASE_TOKEN,
      usage: {
        schemaVersion: 1,
        modelCalls: 1,
        inputTokens: 1_200,
        cachedInputTokens: 640,
        outputTokens: 300,
        reasoningTokens: 64,
        models: [
          {
            role: "vision",
            provider: "openai",
            model: "resolved-vision-model",
            calls: 1,
            inputTokens: 1_200,
            cachedInputTokens: 640,
            outputTokens: 300,
            reasoningTokens: 64,
          },
        ],
        soldComps: [
          { strategy: "apify", attempts: 1, results: 9, chargedUsd: 0.0247 },
        ],
      },
    });

    expect(client.rpc).toHaveBeenCalledWith(
      "record_pipeline_run_provider_usage",
      expect.objectContaining({
        p_run_id: RUN_ID,
        p_lease_token: LEASE_TOKEN,
      }),
    );
    // No tenant identity crosses the wire: the RPC reads it off the leased run.
    const [, args] = client.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args).sort()).toEqual([
      "p_lease_token",
      "p_run_id",
      "p_usage",
    ]);
  });

  it("refuses to send a usage payload carrying anything but counts", async () => {
    const store = createSupabasePipelineWorkerStore(
      rpcClient({ record_pipeline_run_provider_usage: true }),
    );

    await expect(
      store.recordProviderUsage({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        usage: {
          schemaVersion: 1,
          modelCalls: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          models: [],
          soldComps: [],
          prompt: "Grandmother's 1968 Seiko",
        },
      } as unknown as Parameters<typeof store.recordProviderUsage>[0]),
    ).rejects.toThrow();
  });

  it("uses lease-fenced failure and message-rejection RPCs", async () => {
    const client = rpcClient({
      finish_pipeline_run_attempt: {
        status: "retrying",
        retryAfterSeconds: 30,
      },
      reject_pipeline_message: true,
    });
    const store = createSupabasePipelineWorkerStore(client);

    await expect(
      store.failAttempt({
        runId: RUN_ID,
        leaseToken: LEASE_TOKEN,
        retryable: true,
        retryAfterSeconds: 30,
        failureCode: "provider_timeout",
        safeFailureMessage: "SnapList will retry this listing.",
      }),
    ).resolves.toEqual({ status: "retrying", retryAfterSeconds: 30 });
    await expect(
      store.rejectMessage({
        runId: RUN_ID,
        messageId: "41",
        failureCode: "unsupported_schema_version",
        safeFailureMessage: "Unsupported job version.",
      }),
    ).resolves.toBe(true);
  });
});
