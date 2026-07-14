import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteEbayConnection,
  eraseEbayUserData,
  saveEbayConnection,
  updateCachedAccessToken,
} from "./connections";
import { encryptSecret } from "../../crypto/secretbox";
import { UserTokenProvider } from "./user-token-provider";

const ENCRYPTION_ENV = {
  EBAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function deletionClient(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    not: vi.fn(() => query),
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null })),
  };
  return {
    rpc,
    from: vi.fn(() => query),
    storage: {
      from: vi.fn(() => ({ remove: vi.fn(async () => ({ error: null })) })),
    },
  } as unknown as SupabaseClient;
}

describe("saveEbayConnection", () => {
  it("disconnects through the tenant-derived serialized RPC", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const client = deletionClient(rpc);

    await deleteEbayConnection(client);

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("disconnect_ebay_connection");
  });

  it("persists through the tenant-derived erasure boundary", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = deletionClient(rpc);

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

  it("caches foreground access tokens through the tenant-derived RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as SupabaseClient;

    await updateCachedAccessToken(
      client,
      "ignored-application-tenant",
      "11111111-1111-4111-8111-111111111111",
      "refreshed-access-token",
      Date.parse("2026-07-14T14:00:00Z"),
      ENCRYPTION_ENV,
    );

    expect(rpc).toHaveBeenCalledWith("update_ebay_access_token_cache", {
      p_account_generation: "11111111-1111-4111-8111-111111111111",
      p_access_token_enc: expect.stringMatching(/^v1\./),
      p_access_token_expires_at: "2026-07-14T14:00:00.000Z",
    });
  });

  it("caches scheduled access tokens through the constrained scheduler RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as SupabaseClient;

    await updateCachedAccessToken(
      client,
      "scheduled-tenant",
      "22222222-2222-4222-8222-222222222222",
      "refreshed-access-token",
      Date.parse("2026-07-14T14:00:00Z"),
      ENCRYPTION_ENV,
      true,
    );

    expect(rpc).toHaveBeenCalledWith(
      "update_scheduled_ebay_access_token_cache",
      {
        p_user_id: "scheduled-tenant",
        p_account_generation: "22222222-2222-4222-8222-222222222222",
        p_access_token_enc: expect.stringMatching(/^v1\./),
        p_access_token_expires_at: "2026-07-14T14:00:00.000Z",
      },
    );
  });
});

describe("eraseEbayUserData", () => {
  it("delegates identity-scoped erasure to the transactional database seam", async () => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === "erase_ebay_user_data" ? 1 : [],
      error: null,
    }));
    const client = deletionClient(rpc);

    await expect(
      eraseEbayUserData(client, "ebay-user-1", "seller_one"),
    ).resolves.toBe(1);
    expect(rpc).toHaveBeenCalledWith("erase_ebay_user_data", {
      p_ebay_user_id: "ebay-user-1",
      p_ebay_username: "seller_one",
    });
    expect(rpc).toHaveBeenCalledWith("list_message_photo_object_deletions", {
      p_limit: 1000,
    });
  });

  it("fails the notice when transactional erasure fails", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "database unavailable" },
    }));
    const client = deletionClient(rpc);

    await expect(
      eraseEbayUserData(client, "ebay-user-1", undefined),
    ).rejects.toThrow("Deletion erase failed: database unavailable");
    expect(rpc).toHaveBeenCalledWith("erase_ebay_user_data", {
      p_ebay_user_id: "ebay-user-1",
      p_ebay_username: null,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("deletes queued photo objects only after transactional erasure succeeds", async () => {
    const path = "user-a/root-a/photo.jpg";
    let completed = false;
    const rpc = vi.fn(async (name: string) => {
      if (name === "erase_ebay_user_data") return { data: 1, error: null };
      if (name === "list_message_photo_object_deletions") {
        return { data: completed ? [] : [path], error: null };
      }
      completed = true;
      return { data: 1, error: null };
    });
    const remove = vi.fn(async () => ({ error: null }));
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient;

    await expect(
      eraseEbayUserData(client, "ebay-user-1", "seller_one"),
    ).resolves.toBe(1);

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "erase_ebay_user_data",
      "list_message_photo_object_deletions",
      "complete_message_photo_object_deletions",
      "list_message_photo_object_deletions",
    ]);
    expect(remove).toHaveBeenCalledWith([path]);
    expect(rpc).toHaveBeenLastCalledWith(
      "list_message_photo_object_deletions",
      { p_limit: 1000 },
    );
  });
});

describe("UserTokenProvider", () => {
  it("acquires and releases a transactional provider lease for the current generation", async () => {
    const generation = "22222222-2222-4222-8222-222222222222";
    const attemptToken = "77777777-7777-4777-8777-777777777777";
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_ebay_transactional_dispatch") {
        return {
          data: {
            account_generation: generation,
            attempt_token: attemptToken,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const provider = new UserTokenProvider(
      { rpc } as unknown as SupabaseClient,
      { env: () => ENCRYPTION_ENV },
    );

    const lease = await provider.beginProviderDispatch(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "publish",
    );
    expect(lease.accountGeneration).toBe(generation);
    await lease.release();
    expect(rpc).toHaveBeenCalledWith("end_ebay_transactional_dispatch", {
      p_resource_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      p_operation: "publish",
      p_account_generation: generation,
      p_attempt_token: attemptToken,
    });
  });

  it("uses the scheduler-only lease seam for scheduled repricing", async () => {
    const generation = "22222222-2222-4222-8222-222222222222";
    const attemptToken = "77777777-7777-4777-8777-777777777777";
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_scheduled_ebay_transactional_dispatch") {
        return {
          data: {
            user_id: "scheduled-tenant",
            account_generation: generation,
            attempt_token: attemptToken,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const provider = new UserTokenProvider(
      { rpc } as unknown as SupabaseClient,
      {
        env: () => ENCRYPTION_ENV,
        scheduled: true,
        userId: "scheduled-tenant",
      },
    );

    const lease = await provider.beginProviderDispatch(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "reprice",
    );
    await lease.release();

    expect(rpc).toHaveBeenCalledWith(
      "begin_scheduled_ebay_transactional_dispatch",
      {
        p_resource_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        p_operation: "reprice",
      },
    );
    expect(rpc).toHaveBeenCalledWith(
      "end_scheduled_ebay_transactional_dispatch",
      {
        p_resource_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        p_operation: "reprice",
        p_account_generation: generation,
        p_attempt_token: attemptToken,
      },
    );
  });

  it("releases a scheduled lease when its database-derived tenant mismatches", async () => {
    const generation = "22222222-2222-4222-8222-222222222222";
    const attemptToken = "77777777-7777-4777-8777-777777777777";
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_scheduled_ebay_transactional_dispatch") {
        return {
          data: {
            user_id: "different-tenant",
            account_generation: generation,
            attempt_token: attemptToken,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const provider = new UserTokenProvider(
      { rpc } as unknown as SupabaseClient,
      {
        env: () => ENCRYPTION_ENV,
        scheduled: true,
        userId: "scheduled-tenant",
      },
    );

    await expect(
      provider.beginProviderDispatch(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "reprice",
      ),
    ).rejects.toThrow("tenant does not match");
    expect(rpc).toHaveBeenCalledWith(
      "end_scheduled_ebay_transactional_dispatch",
      expect.objectContaining({ p_attempt_token: attemptToken }),
    );
  });

  it("binds refresh reads and cache writes to the source account generation", async () => {
    const accountGeneration = "33333333-3333-4333-8333-333333333333";
    const encryptionKey = Buffer.from(
      ENCRYPTION_ENV.EBAY_TOKEN_ENCRYPTION_KEY,
      "base64",
    );
    const rpc = vi.fn(async (name: string) => {
      if (name === "read_scheduled_ebay_connection") {
        return {
          data: {
            user_id: "scheduled-tenant",
            account_generation: accountGeneration,
            ebay_user_id: "seller-id",
            ebay_username: "seller-name",
            refresh_token_enc: encryptSecret("refresh-token", encryptionKey),
            access_token_enc: null,
            access_token_expires_at: null,
            scopes: ["scope-a"],
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const fetch = vi.fn(async () =>
      Response.json({ access_token: "fresh-token", expires_in: 3600 }),
    );
    const provider = new UserTokenProvider(
      { rpc } as unknown as SupabaseClient,
      {
        scheduled: true,
        userId: "scheduled-tenant",
        fetch,
        env: () => ({
          ...ENCRYPTION_ENV,
          EBAY_CLIENT_ID: "client-id",
          EBAY_CLIENT_SECRET: "client-secret",
        }),
        now: () => Date.parse("2026-07-14T12:00:00Z"),
      },
    );

    await expect(provider.getAccessToken(accountGeneration)).resolves.toBe(
      "fresh-token",
    );
    expect(rpc).toHaveBeenCalledWith(
      "update_scheduled_ebay_access_token_cache",
      expect.objectContaining({
        p_user_id: "scheduled-tenant",
        p_account_generation: accountGeneration,
      }),
    );
  });

  it("rejects a credential generation that differs from the delivery claim", async () => {
    const encryptionKey = Buffer.from(
      ENCRYPTION_ENV.EBAY_TOKEN_ENCRYPTION_KEY,
      "base64",
    );
    const rpc = vi.fn(async () => ({
      data: {
        user_id: "scheduled-tenant",
        account_generation: "44444444-4444-4444-8444-444444444444",
        refresh_token_enc: encryptSecret("refresh-token", encryptionKey),
        access_token_enc: encryptSecret("access-token", encryptionKey),
        access_token_expires_at: "2026-07-14T14:00:00Z",
        scopes: [],
      },
      error: null,
    }));
    const fetch = vi.fn();
    const provider = new UserTokenProvider(
      { rpc } as unknown as SupabaseClient,
      {
        scheduled: true,
        userId: "scheduled-tenant",
        fetch,
        env: () => ENCRYPTION_ENV,
      },
    );

    await expect(
      provider.getAccessToken("55555555-5555-4555-8555-555555555555"),
    ).rejects.toThrow("account generation changed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not return a refreshed token when its source generation expires", async () => {
    const accountGeneration = "66666666-6666-4666-8666-666666666666";
    const encryptionKey = Buffer.from(
      ENCRYPTION_ENV.EBAY_TOKEN_ENCRYPTION_KEY,
      "base64",
    );
    const rpc = vi.fn(async (name: string) => {
      if (name === "read_scheduled_ebay_connection") {
        return {
          data: {
            user_id: "scheduled-tenant",
            account_generation: accountGeneration,
            refresh_token_enc: encryptSecret("refresh-token-a", encryptionKey),
            access_token_enc: null,
            access_token_expires_at: null,
            scopes: ["scope-a"],
          },
          error: null,
        };
      }
      return {
        data: null,
        error: { message: "eBay connection account generation expired" },
      };
    });
    const provider = new UserTokenProvider(
      { rpc } as unknown as SupabaseClient,
      {
        scheduled: true,
        userId: "scheduled-tenant",
        fetch: vi.fn(async () =>
          Response.json({ access_token: "stale-token-a", expires_in: 3600 }),
        ),
        env: () => ({
          ...ENCRYPTION_ENV,
          EBAY_CLIENT_ID: "client-id",
          EBAY_CLIENT_SECRET: "client-secret",
        }),
      },
    );

    await expect(provider.getAccessToken(accountGeneration)).rejects.toThrow(
      "account generation expired",
    );
  });

  it("bounds token refresh before a provider dispatch lease can expire", async () => {
    const accountGeneration = "77777777-7777-4777-8777-777777777777";
    const encryptionKey = Buffer.from(
      ENCRYPTION_ENV.EBAY_TOKEN_ENCRYPTION_KEY,
      "base64",
    );
    let observedSignal: AbortSignal | undefined;
    const provider = new UserTokenProvider(
      {
        rpc: vi.fn(async () => ({
          data: {
            user_id: "scheduled-tenant",
            account_generation: accountGeneration,
            refresh_token_enc: encryptSecret("refresh-token", encryptionKey),
            access_token_enc: null,
            access_token_expires_at: null,
            scopes: ["scope-a"],
          },
          error: null,
        })),
      } as unknown as SupabaseClient,
      {
        scheduled: true,
        userId: "scheduled-tenant",
        fetch: vi.fn(async (_url, init) => {
          observedSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            if (!observedSignal) {
              reject(new Error("token refresh had no abort signal"));
              return;
            }
            observedSignal.addEventListener(
              "abort",
              () => reject(observedSignal?.reason),
              { once: true },
            );
          });
        }) as unknown as typeof fetch,
        env: () => ({
          ...ENCRYPTION_ENV,
          EBAY_CLIENT_ID: "client-id",
          EBAY_CLIENT_SECRET: "client-secret",
          EBAY_TOKEN_REFRESH_TIMEOUT_MS: "5",
        }),
      },
    );

    await expect(provider.getAccessToken(accountGeneration)).rejects.toBeTruthy();
    expect(observedSignal?.aborted).toBe(true);
  });
});
