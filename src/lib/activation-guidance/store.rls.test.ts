import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupClerkTestUsers, provisionClerkTestUser, type ClerkTestUser } from "@/lib/supabase/test-users";
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import {
  createSupabaseActivationGuidanceStore,
  type ActivationGuidanceDatabaseClient,
} from "./store";

const supabaseURL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let reachable = false;
let admin: SupabaseClient;
let sellerA: ClerkTestUser;
let sellerB: ClerkTestUser;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

beforeAll(async () => {
  reachable = await stackReachable({
    url: supabaseURL,
    apiKey: anonKey,
    requiredValues: [anonKey, serviceRoleKey],
  });
  await whenStackReachable(reachable, async () => {
    admin = createClient(supabaseURL, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    [sellerA, sellerB] = await Promise.all([
      provisionClerkTestUser(supabaseURL, anonKey!, "activation_guidance_a"),
      provisionClerkTestUser(supabaseURL, anonKey!, "activation_guidance_b"),
    ]);
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
    await admin
      .from("activation_guidance_completions")
      .delete()
      .in("user_id", [sellerA.id, sellerB.id]);
    await cleanupClerkTestUsers(admin, [sellerA.id, sellerB.id]);
  });
});

describe("activation guidance completion RLS", () => {
  it("round-trips one seller completion without exposing or accepting another seller's row", async () => {
    const store = createSupabaseActivationGuidanceStore(
      (bearerToken) =>
        (bearerToken === "seller-a" ? sellerA.client : sellerB.client) as unknown as ActivationGuidanceDatabaseClient,
    );

    await store.complete({ bearerToken: "seller-a", userId: sellerA.id });
    await expect(
      store.isCompleted({ bearerToken: "seller-a", userId: sellerA.id }),
    ).resolves.toBe(true);
    await expect(
      store.isCompleted({ bearerToken: "seller-b", userId: sellerB.id }),
    ).resolves.toBe(false);
    await expect(
      store.isCompleted({ bearerToken: "seller-b", userId: sellerA.id }),
    ).resolves.toBe(false);

    const forged = await sellerB.client
      .from("activation_guidance_completions")
      .insert({ user_id: sellerA.id });
    expect(forged.error).not.toBeNull();
  });
});
