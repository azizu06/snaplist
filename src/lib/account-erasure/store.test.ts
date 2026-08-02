import { describe, expect, it, vi } from "vitest";
import {
  AccountErasureIdempotencyConflictError,
  createSupabaseAccountErasureStore,
} from "./store";

const generationId = "38410000-0000-4000-8000-000000000001";
const idempotencyKey = "38410000-0000-4000-8000-000000000002";

function rpcState(overrides: Record<string, unknown> = {}) {
  return {
    generation_id: generationId,
    status: "deletion_in_progress",
    retained_records: [],
    deferrals: [],
    attention_reasons: [],
    identity: { clerk_user_id: "user_384", revenuecat_app_user_ids: [] },
    storage_objects: [],
    ...overrides,
  };
}

describe("Supabase account erasure store", () => {
  it("persists the PostHog person UUID before external deletion", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const store = createSupabaseAccountErasureStore({ rpc });

    await expect(store.recordPostHogPersonUUID({
      generationId,
      personUUID: "61700000-0000-4000-8000-000000000001",
    })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith("record_account_erasure_posthog_person_uuid", {
      p_generation_id: generationId,
      p_person_uuid: "61700000-0000-4000-8000-000000000001",
    });
  });

  it("uses only fixed erasure RPCs", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: rpcState({
          status: "deletion_requested",
          identity: null,
          storage_objects: [{ bucket_id: "photos", object_name: "user_384/photo.jpg" }],
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: rpcState(), error: null })
      .mockResolvedValueOnce({
        data: rpcState({ status: "deletion_completed", identity: null }),
        error: null,
      });
    const store = createSupabaseAccountErasureStore({ rpc });

    await expect(store.begin({ userId: "user_384", idempotencyKey }))
      .resolves.toMatchObject({ generationId, status: "deletion_requested" });
    await expect(store.confirmStorageAbsence({
      generationId,
      bucketId: "photos",
      objectName: "user_384/photo.jpg",
    })).resolves.toBe(true);
    await expect(store.advance({ generationId }))
      .resolves.toMatchObject({ status: "deletion_in_progress" });
    await expect(store.finalize({
      generationId,
      clerkIdentityAbsent: true,
      revenueCatCustomerAbsent: true,
      postHogPersonAndEventsDeletionConfirmed: true,
      attentionReasons: [],
    })).resolves.toMatchObject({ status: "deletion_completed" });

    expect(rpc.mock.calls).toEqual([
      ["begin_account_erasure", {
        p_idempotency_key: idempotencyKey,
        p_user_id: "user_384",
      }],
      ["confirm_account_erasure_storage_absence", {
        p_bucket_id: "photos",
        p_generation_id: generationId,
        p_object_name: "user_384/photo.jpg",
      }],
      ["advance_account_erasure", { p_generation_id: generationId }],
      ["finalize_account_erasure", {
        p_attention_reasons: [],
        p_clerk_identity_absent: true,
        p_generation_id: generationId,
        p_posthog_person_and_events_deletion_confirmed: true,
        p_revenuecat_customer_absent: true,
      }],
    ]);
  });

  it("carries the provider identity the caller must delete outside Postgres", async () => {
    const store = createSupabaseAccountErasureStore({
      rpc: vi.fn().mockResolvedValue({
        data: rpcState({
          identity: {
            clerk_user_id: "user_384",
            revenuecat_app_user_ids: ["rc_a", "rc_b"],
          },
        }),
        error: null,
      }),
    });

    await expect(store.advance({ generationId })).resolves.toMatchObject({
      identity: { clerkUserId: "user_384", revenueCatAppUserIds: ["rc_a", "rc_b"] },
    });
  });

  it("rejects a status outside the approved erasure vocabulary", async () => {
    const store = createSupabaseAccountErasureStore({
      rpc: vi.fn().mockResolvedValue({
        data: rpcState({ status: "complete" }),
        error: null,
      }),
    });

    await expect(store.advance({ generationId })).rejects.toThrow();
  });

  it("maps a bound idempotency key to a stable conflict", async () => {
    const store = createSupabaseAccountErasureStore({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: "23505",
          message: "Account erasure Idempotency-Key is already bound",
        },
      }),
    });

    await expect(store.begin({
      userId: "user_384",
      idempotencyKey,
    })).rejects.toBeInstanceOf(AccountErasureIdempotencyConflictError);
  });
});
