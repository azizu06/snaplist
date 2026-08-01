import { createClient } from "@supabase/supabase-js";
import { createAppleAppAttestVerifier } from "@/lib/app-attest/apple-verifier";
import {
  createAppAttestService,
  type AppAttestEnvironment,
} from "@/lib/app-attest/service";
import { createSupabaseAppAttestStore } from "@/lib/app-attest/supabase-store";
import { createAppleDeviceCheckAdapter } from "./apple-device-check";
import {
  createIncludedOfferFence,
  createIncludedOfferRedemptionWorker,
  type IncludedAllowanceLedger,
  type IncludedOfferFence,
  type IncludedOfferRedemptionWorker,
} from "./service";
import {
  createSupabaseIncludedOfferClaimStore,
  createSupabaseIncludedOfferRedemptionQueue,
  type IncludedOfferRpcClient,
} from "./supabase-store";

/** How long a claim at the head may wait for the client's fresh token. */
const TOKEN_WINDOW_MS = 30_000;

/**
 * Reduces any Supabase client down to the audited RPC surface the redemption
 * authority is allowed to touch.
 *
 * The `IncludedOfferRpcName` union already stops a bad call at compile time;
 * this exists so the *runtime* object handed across the seam has no `.from()`,
 * `.storage`, or `.auth` to reach for either. The worker's domain authority
 * comes from the stored claim, never from the key that opened the connection.
 */
export function narrowIncludedOfferRpcClient(client: {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<unknown>;
}): IncludedOfferRpcClient {
  return {
    rpc(functionName, args) {
      return client.rpc(functionName, args) as ReturnType<
        IncludedOfferRpcClient["rpc"]
      >;
    },
  };
}

export interface IncludedOfferFenceEnv {
  /** Present so `process.env` is assignable; only the named keys are read. */
  [key: string]: string | undefined;
  APPLE_DEVICECHECK_KEY_ID?: string;
  APPLE_DEVICECHECK_PRIVATE_KEY_PEM?: string;
  APPLE_TEAM_ID?: string;
  APP_ATTEST_APP_ID?: string;
  APP_ATTEST_ENVIRONMENT?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

function required(env: IncludedOfferFenceEnv, key: keyof IncludedOfferFenceEnv) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required to fence the included first AI offer.`);
  }
  return value;
}

function appleEnvironment(env: IncludedOfferFenceEnv): AppAttestEnvironment {
  const value = required(env, "APP_ATTEST_ENVIRONMENT");
  if (value !== "development" && value !== "production") {
    // Guessing an Apple environment would query the wrong DeviceCheck host and
    // read another environment's bit, so refuse rather than assume.
    throw new Error(
      "APP_ATTEST_ENVIRONMENT must be 'development' or 'production'.",
    );
  }
  return value;
}

/**
 * Builds the durable fence from env. Every missing or unreadable credential
 * throws, because a fence that cannot verify a device must deny the included
 * offer rather than let an unfenced run reach provider spend.
 */
export function createConfiguredIncludedOfferFence(
  env: IncludedOfferFenceEnv = process.env,
  options: {
    /**
     * The caller's own bearer token. The account allowance is read through the
     * seller's RLS identity, so the redemption authority never needs a
     * service-role path into the credit ledger.
     */
    accessToken?: string;
    includedAllowance?: IncludedAllowanceLedger;
  } = {},
): { fence: IncludedOfferFence; worker: IncludedOfferRedemptionWorker } {
  const environment = appleEnvironment(env);
  const supabaseURL = required(env, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const deviceCheck = createAppleDeviceCheckAdapter({
    environment,
    keyId: required(env, "APPLE_DEVICECHECK_KEY_ID"),
    privateKeyPem: required(env, "APPLE_DEVICECHECK_PRIVATE_KEY_PEM"),
    teamId: required(env, "APPLE_TEAM_ID"),
  });

  const client = createClient(supabaseURL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const rpc = narrowIncludedOfferRpcClient(client);
  const store = createSupabaseIncludedOfferClaimStore(rpc);
  const queue = createSupabaseIncludedOfferRedemptionQueue(rpc);

  // #331 owns this verification entirely; the fence only consumes its verdict.
  const attest = createAppAttestService({
    appId: env.APP_ATTEST_APP_ID?.trim(),
    challengeTtlMs: 300_000,
    environment,
    store: createSupabaseAppAttestStore(client),
    verifier: createAppleAppAttestVerifier({}),
  });

  const composition = {
    appAttest: { verify: attest.verifyAssertion },
    deviceCheck,
    includedAllowance:
      options.includedAllowance
      ?? createTenantIncludedAllowanceLedger({
        accessToken: options.accessToken,
        anonKey: required(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
        supabaseURL,
      }),
    queue,
    store,
    tokenWindowMs: TOKEN_WINDOW_MS,
  };
  return {
    fence: createIncludedOfferFence(composition),
    worker: createIncludedOfferRedemptionWorker(composition),
  };
}

/**
 * Reads the existing per-account allowance ledger, unchanged by this issue.
 *
 * The authoritative decision still belongs to
 * `private.reserve_ai_item_credit_for_pipeline_run`; this read only lets the
 * redemption endpoint answer `denied_account_consumed` before it spends a
 * device rendezvous on an account with no included run left. It runs under the
 * caller's own RLS identity, so it can only ever see that seller's rows.
 *
 * The trigger creates the `included-first-run` period lazily, so an account
 * with no period row yet has spent nothing.
 */
function createTenantIncludedAllowanceLedger(input: {
  accessToken?: string;
  anonKey: string;
  supabaseURL: string;
}): IncludedAllowanceLedger {
  const client = createClient(input.supabaseURL, input.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: input.accessToken
      ? { headers: { Authorization: `Bearer ${input.accessToken}` } }
      : undefined,
  });
  return {
    async isIncludedRunAvailable() {
      const period = await client
        .from("ai_item_allowance_periods")
        .select("allowance, id")
        .eq("source", "included")
        .eq("period_key", "included-first-run")
        .maybeSingle();
      if (period.error) throw new Error(period.error.message);
      if (!period.data) return true;
      const used = await client
        .from("ai_item_credit_reservations")
        .select("id", { count: "exact", head: true })
        .eq("allowance_period_id", period.data.id)
        .in("state", ["reserved", "settled"]);
      if (used.error) throw new Error(used.error.message);
      return (used.count ?? 0) < period.data.allowance;
    },
  };
}
