import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReviewSnapshot } from "./review-snapshot";

describe("loadReviewSnapshot", () => {
  it("loads item, listing, prediction, and all-row editability in one RPC", async () => {
    const snapshot = {
      item: {
        id: "item-1",
        photos: [],
        attributes: { brand: "Sony" },
        condition: "good",
        identification: null,
        price_override: null,
        cost_basis: null,
        review_revision: "00000000-0000-4000-8000-000000000001",
        created_at: "2026-07-13T00:00:00.000Z",
      },
      listing: null,
      prediction: null,
      reviewBlocked: true,
    };
    const rpc = vi.fn(async () => ({ data: snapshot, error: null }));

    await expect(
      loadReviewSnapshot({ rpc } as unknown as SupabaseClient, "item-1"),
    ).resolves.toEqual(snapshot);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_review_snapshot", { p_item_id: "item-1" });
  });
});
