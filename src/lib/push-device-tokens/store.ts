import { createClient } from "@supabase/supabase-js";

export interface PushDeviceTokenRegistration {
  /**
   * The APNs host this token answers on, as the registering build reported it
   * (#891). Stored rather than derived: the server has no way to see the
   * `aps-environment` entitlement that decided it.
   */
  apnsEnvironment: "sandbox" | "production";
  bearerToken: string;
  platform: "ios";
  token: string;
  userId: string;
}

export interface PushDeviceTokenStore {
  register(input: PushDeviceTokenRegistration): Promise<void>;
}

interface DeviceTokenUpsertResult {
  error: { code?: string; message: string } | null;
}

interface DeviceTokenTable {
  upsert(
    values: {
      apns_environment: string;
      last_seen_at: string;
      platform: string;
      token: string;
      user_id: string;
    },
    options: { onConflict: "user_id,platform,token" },
  ): PromiseLike<DeviceTokenUpsertResult>;
}

export interface DeviceTokenDatabaseClient {
  from(table: "device_tokens"): DeviceTokenTable;
}

/**
 * Registration is an upsert on `(user_id, platform, token)` (#890).
 *
 * The same phone re-registering is the normal case, not an error: iOS reissues
 * a token whenever it feels like it and the app re-sends on every first
 * submission, so the operation has to be idempotent by construction. The key
 * includes `user_id`, which means a device shared by two sellers is two rows
 * and neither can be re-keyed onto the other — the conflict target cannot
 * express a cross-tenant collision. `last_seen_at` moves on every registration
 * so a token that stops being re-sent is visibly stale.
 *
 * The caller builds the client from the verified bearer. The database policy,
 * not this code, is the authority binding a row to a Clerk subject.
 */
export function createSupabasePushDeviceTokenStore(
  clientForBearer: (bearerToken: string) => DeviceTokenDatabaseClient,
  now: () => Date = () => new Date(),
): PushDeviceTokenStore {
  return {
    async register({ apnsEnvironment, bearerToken, platform, token, userId }) {
      const { error } = await clientForBearer(bearerToken)
        .from("device_tokens")
        .upsert(
          {
            // Re-sent on every registration, not just the first. A build
            // reinstalled over another configuration keeps the same row under
            // this key, and a stale environment on it is a working address
            // pointed at the wrong host.
            apns_environment: apnsEnvironment,
            last_seen_at: now().toISOString(),
            platform,
            token,
            user_id: userId,
          },
          { onConflict: "user_id,platform,token" },
        );
      if (error) {
        throw new Error(`Device token registration failed: ${error.message}`);
      }
    },
  };
}

export function createConfiguredSupabasePushDeviceTokenStore(input: {
  anonKey: string;
  supabaseURL: string;
}): PushDeviceTokenStore {
  return createSupabasePushDeviceTokenStore((bearerToken) =>
    createClient(input.supabaseURL, input.anonKey, {
      accessToken: async () => bearerToken,
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as DeviceTokenDatabaseClient,
  );
}
