import { describe, expect, it, vi } from "vitest";
import {
  createSupabasePushDeviceTokenStore,
  type DeviceTokenDatabaseClient,
} from "./store";

/**
 * `createSupabasePushDeviceTokenStore` wraps a pure upsert-and-error-wrap
 * contract around whatever client the caller injects. The only other test in
 * this directory (`device-tokens.rls.test.ts`) exercises real Postgres RLS
 * against a local Supabase stack and can't run here, so this pins the
 * DB-free logic directly with a fake `DeviceTokenDatabaseClient`.
 */

const NOW = new Date("2026-07-15T12:00:00.000Z");

function fakeClient(
  upsert: (
    values: {
      apns_environment: string;
      last_seen_at: string;
      platform: string;
      token: string;
      user_id: string;
    },
    options: { onConflict: "user_id,platform,token" },
  ) => Promise<{ error: { code?: string; message: string } | null }>,
): DeviceTokenDatabaseClient {
  return { from: () => ({ upsert }) };
}

describe("createSupabasePushDeviceTokenStore", () => {
  it("upserts on (user_id, platform, token) with the injected timestamp", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const store = createSupabasePushDeviceTokenStore(() => fakeClient(upsert), () => NOW);

    await store.register({
      apnsEnvironment: "sandbox",
      bearerToken: "bearer-abc",
      platform: "ios",
      token: "device-token-1",
      userId: "user-1",
    });

    expect(upsert).toHaveBeenCalledWith(
      {
        apns_environment: "sandbox",
        last_seen_at: NOW.toISOString(),
        platform: "ios",
        token: "device-token-1",
        user_id: "user-1",
      },
      { onConflict: "user_id,platform,token" },
    );
  });

  it("wraps an upsert error rather than leaking the raw Postgres message", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "duplicate key" } });
    const store = createSupabasePushDeviceTokenStore(() => fakeClient(upsert), () => NOW);

    await expect(
      store.register({
        apnsEnvironment: "production",
        bearerToken: "bearer-abc",
        platform: "ios",
        token: "device-token-2",
        userId: "user-2",
      }),
    ).rejects.toThrow("Device token registration failed: duplicate key");
  });

  it("resolves without error when the upsert succeeds", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const store = createSupabasePushDeviceTokenStore(() => fakeClient(upsert), () => NOW);

    await expect(
      store.register({
        apnsEnvironment: "sandbox",
        bearerToken: "bearer-abc",
        platform: "ios",
        token: "device-token-3",
        userId: "user-3",
      }),
    ).resolves.toBeUndefined();
  });
});
