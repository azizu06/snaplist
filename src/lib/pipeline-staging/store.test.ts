import { describe, expect, it, vi } from "vitest";
import { createSupabasePipelineStagingStore } from "./store";

const input = {
  batchId: "11111111-1111-4111-8111-111111111111",
  userId: "user_123",
  dailyLimit: 15,
  perMinuteLimit: 20,
  entries: [
    {
      idempotencyKey: "capture-1",
      source: "single" as const,
      autopilotEnabled: false,
      photoPaths: ["user_123/staging/batch/item/front.jpg"],
      costBasis: null,
    },
  ],
};

describe("Supabase pipeline staging store", () => {
  it("recovers a committed producer request before Storage is touched again", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          batch_id: input.batchId,
          batch_position: 0,
          idempotency_key: "capture-1",
          item_id: "22222222-2222-4222-8222-222222222222",
          run_id: "33333333-3333-4333-8333-333333333333",
          queue_message_id: 42,
          listing_id: null,
          status: "queued",
          stage: "queued",
          attempt_count: 0,
          max_attempts: 3,
          safe_failure_message: null,
          updated_at: "2026-07-15T12:00:00.000Z",
        },
      ],
      error: null,
    }));
    const store = createSupabasePipelineStagingStore({ rpc });

    await expect(store.findReplay({
      batchId: input.batchId,
      userId: input.userId,
      entries: [{
        idempotencyKey: "capture-1",
        source: "single",
        autopilotEnabled: false,
        photoCount: 1,
        costBasis: null,
      }],
    })).resolves.toMatchObject([{ queue_message_id: "42" }]);
    expect(rpc).toHaveBeenCalledWith("find_pipeline_batch_replay", {
      p_batch_id: input.batchId,
      p_entries: [{
        autopilot_enabled: false,
        cost_basis: null,
        idempotency_key: "capture-1",
        photo_count: 1,
        source: "single",
      }],
      p_user_id: input.userId,
    });
  });

  it("uses one fixed staging RPC and maps only safe capture inputs", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          batch_id: input.batchId,
          batch_position: 0,
          idempotency_key: "capture-1",
          item_id: "22222222-2222-4222-8222-222222222222",
          run_id: "33333333-3333-4333-8333-333333333333",
          queue_message_id: 42,
          listing_id: null,
          status: "queued",
          stage: "queued",
          attempt_count: 0,
          max_attempts: 3,
          safe_failure_message: null,
          updated_at: "2026-07-15T12:00:00.000Z",
        },
      ],
      error: null,
    }));
    const store = createSupabasePipelineStagingStore({ rpc });

    await expect(store.stageAndEnqueue(input)).resolves.toMatchObject([
      { queue_message_id: "42" },
    ]);
    expect(rpc).toHaveBeenCalledWith("stage_pipeline_batch", {
      p_batch_id: input.batchId,
      p_daily_limit: 15,
      p_entries: [
        {
          autopilot_enabled: false,
          cost_basis: null,
          idempotency_key: "capture-1",
          photo_paths: input.entries[0].photoPaths,
          source: "single",
        },
      ],
      p_per_minute_limit: 20,
      p_user_id: "user_123",
    });
  });

  it("releases a terminal run through the run-keyed RPC", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = createSupabasePipelineStagingStore({ rpc });
    await expect(
      store.releaseDailyReservation("33333333-3333-4333-8333-333333333333"),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("release_pipeline_run_daily_reservation", {
      p_run_id: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("records and resolves private staging cleanup through fixed RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = createSupabasePipelineStagingStore({ rpc });
    const cleanupId = "55555555-5555-4555-8555-555555555555";
    const batchId = "11111111-1111-4111-8111-111111111111";
    const photoPaths = [
      `user_123/pipeline-staging/${batchId}/0/0-photo.jpg`,
    ];

    await expect(store.recordCleanupIntent({
      cleanupId,
      userId: "user_123",
      batchId,
      photoPaths,
    })).resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(1, "record_pipeline_staging_cleanup_intent", {
      p_batch_id: batchId,
      p_cleanup_id: cleanupId,
      p_photo_paths: photoPaths,
      p_user_id: "user_123",
    });

    await expect(store.resolveCleanupIntent(cleanupId)).resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(2, "resolve_pipeline_staging_cleanup_intent", {
      p_cleanup_id: cleanupId,
    });
  });

  it("reserves and releases legacy request usage through fixed RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = createSupabasePipelineStagingStore({ rpc });
    const reservationId = "44444444-4444-4444-8444-444444444444";

    await expect(store.reserveLegacyUsage({
      reservationId,
      userId: "user_123",
      dailyLimit: 15,
      perMinuteLimit: 20,
    })).resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(1, "reserve_legacy_pipeline_usage", {
      p_daily_limit: 15,
      p_per_minute_limit: 20,
      p_reservation_id: reservationId,
      p_user_id: "user_123",
    });

    await expect(store.releaseLegacyDailyReservation(reservationId)).resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(2, "release_legacy_pipeline_usage", {
      p_reservation_id: reservationId,
    });
  });

  it("surfaces RPC errors without exposing a generic Supabase client", async () => {
    const store = createSupabasePipelineStagingStore({
      rpc: vi.fn(async () => ({ data: null, error: { message: "daily capacity reached" } })),
    });
    await expect(store.stageAndEnqueue(input)).rejects.toThrow(
      "Pipeline staging failed: daily capacity reached",
    );
  });
});
