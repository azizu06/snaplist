import { describe, expect, it, vi } from "vitest";
import {
  AccountErasureIdempotencyConflictError,
  createSupabaseAccountErasureStore,
} from "./store";

const generationId = "38410000-0000-4000-8000-000000000001";
const idempotencyKey = "38410000-0000-4000-8000-000000000002";

describe("Supabase account erasure store", () => {
  it("uses only the fixed generation, absence, and advancement RPCs", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          generation_id: generationId,
          status: "deleting",
          blockers: [],
          storage_objects: [{ bucket_id: "photos", object_name: "user_384/photo.jpg" }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({
        data: {
          generation_id: generationId,
          status: "blocked",
          blockers: ["clerk-identity-retention"],
          storage_objects: [],
        },
        error: null,
      });
    const store = createSupabaseAccountErasureStore({ rpc });

    await expect(store.begin({
      userId: "user_384",
      idempotencyKey,
    })).resolves.toMatchObject({ generationId, status: "deleting" });
    await expect(store.confirmStorageAbsence({
      generationId,
      bucketId: "photos",
      objectName: "user_384/photo.jpg",
    })).resolves.toBe(true);
    await expect(store.advance({
      generationId,
      resolvedBlockers: [],
    })).resolves.toMatchObject({ status: "blocked" });

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
      ["advance_account_erasure", {
        p_generation_id: generationId,
        p_resolved_blockers: [],
      }],
    ]);
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
