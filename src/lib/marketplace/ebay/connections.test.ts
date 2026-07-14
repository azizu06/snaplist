import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eraseEbayUserData, saveEbayConnection } from "./connections";

const ENCRYPTION_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("saveEbayConnection", () => {
  it("persists through the tenant-derived erasure boundary", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as SupabaseClient;

    await saveEbayConnection(
      client,
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        accessTokenExpiresAt: Date.parse("2026-07-14T12:00:00Z"),
        scopes: ["scope-a", "scope-b"],
      },
      { userId: "ebay-user-id", username: "Seller_Name" },
      ENCRYPTION_ENV,
    );

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("save_ebay_connection", {
      p_ebay_user_id: "ebay-user-id",
      p_ebay_username: "Seller_Name",
      p_refresh_token_enc: expect.stringMatching(/^v1\./),
      p_access_token_enc: expect.stringMatching(/^v1\./),
      p_access_token_expires_at: "2026-07-14T12:00:00.000Z",
      p_scopes: ["scope-a", "scope-b"],
    });
  });
});

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
