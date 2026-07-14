import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eraseEbayUserData } from "./connections";

describe("eraseEbayUserData", () => {
  it("delegates identity-scoped erasure to the transactional database seam", async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const client = { rpc } as unknown as SupabaseClient;

    await expect(
      eraseEbayUserData(client, "ebay-user-1", "seller_one"),
    ).resolves.toBe(1);
    expect(rpc).toHaveBeenCalledWith("erase_ebay_user_data", {
      p_ebay_user_id: "ebay-user-1",
      p_ebay_username: "seller_one",
    });
  });

  it("fails the notice when transactional erasure fails", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "database unavailable" },
    }));
    const client = { rpc } as unknown as SupabaseClient;

    await expect(
      eraseEbayUserData(client, "ebay-user-1", undefined),
    ).rejects.toThrow("Deletion erase failed: database unavailable");
    expect(rpc).toHaveBeenCalledWith("erase_ebay_user_data", {
      p_ebay_user_id: "ebay-user-1",
      p_ebay_username: null,
    });
  });
});
