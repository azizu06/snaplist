import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "./test-users";

/**
 * RLS / tenancy integration test — the primary security seam (PRD Testing Decisions,
 * AGENTS.md non-negotiable #1). Proves user A cannot read or write user B's
 * items / listings / messages / prediction_logs.
 *
 * Requires a running local Supabase stack:
 *   pnpm supabase start          # needs Docker
 *   pnpm supabase db reset       # applies migrations + seeds
 *   pnpm exec vitest run src/lib/supabase/rls.test.ts
 *
 * It reads connection info from env (set by `supabase start`, or pass explicitly):
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL  (default http://127.0.0.1:54321)
 *   SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY                 (to provision the two test users)
 *
 * If the stack is unreachable (e.g. Docker not running), the suite skips rather than
 * faking a pass — a green run here means RLS was actually exercised against Postgres.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let reachable = false;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;

// Clerk-era provisioning (issue #41): identities are minted JWTs with text
// subs — no auth.users rows. See test-users.ts for why this still exercises
// the real policies.
async function provisionUser(label: string): Promise<ClerkTestUser> {
  return provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, `rls_${label}`);
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: ANON_KEY, requiredValues: [ANON_KEY, SERVICE_ROLE_KEY] });
  await whenStackReachable(reachable, async () => {

  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  [userA, userB] = await Promise.all([
    provisionUser("a"),
    provisionUser("b"),
  ]);

  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  // No auth.users cascade anymore (Clerk migration dropped those FKs) —
  // delete owned domain rows explicitly.
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("RLS tenancy isolation", () => {
  it("requires a running local Supabase stack (skips otherwise, never fakes a pass)", () => {
    if (!reachable) {
      console.warn(
        "[rls.test] Local Supabase stack unreachable — skipping RLS assertions. " +
          "Run `pnpm supabase start && pnpm supabase db reset` then re-run this test.",
      );
    }
    expect(true).toBe(true);
  });

  it("a minted token binds queries to the correct Clerk identity", async () => {

    // supabase.auth.* is disabled with the accessToken option (Clerk era), so
    // identity binding is proven through the data path: a row inserted as A
    // must come back stamped with A's sub — i.e. the JWT, not the payload's
    // claim, is what RLS trusted.
    expect(userA.id).not.toBe(userB.id);
    const { data, error } = await userA.client
      .from("items")
      .insert({ user_id: userA.id, condition: "good", attributes: { brand: "JwtBind" } })
      .select("user_id")
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(userA.id);
  });

  it("keeps billing entitlement mirrors read-own and Customer maps server-only", async () => {


    const { error: customerError } = await admin.from("billing_customers").insert([
      { user_id: userA.id, stripe_customer_id: `cus_${userA.id}` },
      { user_id: userB.id, stripe_customer_id: `cus_${userB.id}` },
    ]);
    expect(customerError).toBeNull();

    const { error: subscriptionError } = await admin.from("subscriptions").upsert([
      {
        user_id: userA.id,
        stripe_customer_id: `cus_${userA.id}`,
        stripe_subscription_id: `sub_${userA.id}`,
        tier: "free",
        status: "incomplete",
      },
      {
        user_id: userB.id,
        stripe_customer_id: `cus_${userB.id}`,
        stripe_subscription_id: `sub_${userB.id}`,
        tier: "paid",
        status: "active",
      },
    ]);
    expect(subscriptionError).toBeNull();

    const { data: aRows, error: aReadError } = await userA.client
      .from("subscriptions")
      .select("user_id, tier")
      .order("user_id");
    expect(aReadError).toBeNull();
    expect(aRows).toEqual([{ user_id: userA.id, tier: "free" }]);

    const { data: bAsA, error: crossTenantReadError } = await userA.client
      .from("subscriptions")
      .select("user_id")
      .eq("user_id", userB.id);
    expect(crossTenantReadError).toBeNull();
    expect(bAsA ?? []).toHaveLength(0);

    // No Customer-map policy exists for users. An empty result (rather than an
    // error) is the normal PostgREST/RLS representation of that denial.
    const { data: customerRows } = await userA.client
      .from("billing_customers")
      .select("user_id, stripe_customer_id");
    expect(customerRows ?? []).toHaveLength(0);

    // Client writes must either be denied or affect zero rows. Confirm through
    // the service-role fixture that a user cannot forge paid entitlement.
    const { data: forgedRows } = await userA.client
      .from("subscriptions")
      .update({ tier: "paid", status: "active" })
      .eq("user_id", userA.id)
      .select("tier");
    expect(forgedRows ?? []).toHaveLength(0);

    // A delayed handler that observed active state earlier must not overwrite a
    // newer cancellation already mirrored by another webhook worker.
    const { data: newerWrite, error: newerWriteError } = await admin.rpc(
      "upsert_billing_subscription",
      {
        p_user_id: userA.id,
        p_stripe_customer_id: `cus_${userA.id}`,
        p_stripe_subscription_id: `sub_${userA.id}`,
        p_status: "canceled",
        p_current_period_end: null,
        p_stripe_observed_at: "2030-01-02T00:00:00.000Z",
      },
    );
    expect(newerWriteError).toBeNull();
    expect(newerWrite).toBe(true);

    const { data: staleWrite, error: staleWriteError } = await admin.rpc(
      "upsert_billing_subscription",
      {
        p_user_id: userA.id,
        p_stripe_customer_id: `cus_${userA.id}`,
        p_stripe_subscription_id: `sub_${userA.id}`,
        p_status: "active",
        p_current_period_end: null,
        p_stripe_observed_at: "2030-01-01T00:00:00.000Z",
      },
    );
    expect(staleWriteError).toBeNull();
    expect(staleWrite).toBe(false);

    const { data: authoritative, error: authoritativeError } = await admin
      .from("subscriptions")
      .select("tier, status")
      .eq("user_id", userA.id)
      .single();
    expect(authoritativeError).toBeNull();
    expect(authoritative).toMatchObject({ tier: "free", status: "canceled" });
  });

  it("atomically claims Stripe events and permits only the service-role lifecycle path", async () => {

    const eventId = `evt_claim_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const type = "customer.subscription.updated";

    const [first, second] = await Promise.all([
      admin.rpc("claim_stripe_event", { p_event_id: eventId, p_type: type }),
      admin.rpc("claim_stripe_event", { p_event_id: eventId, p_type: type }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const responses = [first.data?.[0], second.data?.[0]];
    const claimed = responses.find((response) => response?.state === "claimed");
    expect(claimed?.claim_token).toEqual(expect.any(String));
    expect(responses.map((response) => response?.state).sort()).toEqual(["claimed", "in_progress"]);

    const { data: released, error: releaseError } = await admin.rpc("release_stripe_event_claim", {
      p_event_id: eventId,
      p_claim_token: claimed!.claim_token,
    });
    expect(releaseError).toBeNull();
    expect(released).toBe(true);

    const { data: retryRows, error: retryError } = await admin.rpc("claim_stripe_event", {
      p_event_id: eventId,
      p_type: type,
    });
    expect(retryError).toBeNull();
    const retry = retryRows?.[0];
    expect(retry?.state).toBe("claimed");

    const { data: completed, error: completeError } = await admin.rpc("complete_stripe_event_claim", {
      p_event_id: eventId,
      p_claim_token: retry!.claim_token,
    });
    expect(completeError).toBeNull();
    expect(completed).toBe(true);

    const { data: duplicateRows, error: duplicateError } = await admin.rpc("claim_stripe_event", {
      p_event_id: eventId,
      p_type: type,
    });
    expect(duplicateError).toBeNull();
    expect(duplicateRows?.[0]?.state).toBe("duplicate");

    const { error: clientClaimError } = await userA.client.rpc("claim_stripe_event", {
      p_event_id: `${eventId}_client`,
      p_type: type,
    });
    expect(clientClaimError).not.toBeNull();
  });

  it("atomically reserves one hosted Checkout for concurrent first-time starts", async () => {

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userId = `billing_reservation_${suffix}`;
    const customerId = `cus_reservation_${suffix}`;
    const { error: customerError } = await admin
      .from("billing_customers")
      .insert({ user_id: userId, stripe_customer_id: customerId });
    expect(customerError).toBeNull();

    const [first, second] = await Promise.all([
      admin.rpc("claim_billing_checkout", {
        p_user_id: userId,
        p_stripe_customer_id: customerId,
      }),
      admin.rpc("claim_billing_checkout", {
        p_user_id: userId,
        p_stripe_customer_id: customerId,
      }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const responses = [first.data?.[0], second.data?.[0]];
    const claimed = responses.find((response) => response?.state === "claim");
    expect(claimed?.idempotency_key).toEqual(expect.any(String));
    expect(responses.map((response) => response?.state).sort()).toEqual(["claim", "in_progress"]);

    const { data: completed, error: completeError } = await admin.rpc(
      "complete_billing_checkout_claim",
      {
        p_user_id: userId,
        p_claim_token: claimed!.claim_token,
        p_checkout_session_id: `cs_${suffix}`,
        p_checkout_url: "https://checkout.stripe.test/reused-session",
        p_expires_at: "2030-01-01T00:00:00.000Z",
      },
    );
    expect(completeError).toBeNull();
    expect(completed).toBe(true);

    const { data: retryRows, error: retryError } = await admin.rpc("claim_billing_checkout", {
      p_user_id: userId,
      p_stripe_customer_id: customerId,
    });
    expect(retryError).toBeNull();
    expect(retryRows?.[0]).toMatchObject({
      state: "ready",
      checkout_url: "https://checkout.stripe.test/reused-session",
    });

    await admin.from("billing_checkout_reservations").delete().eq("user_id", userId);
    await admin.from("billing_customers").delete().eq("user_id", userId);
  });

  it("a user can insert and read back their OWN item", async () => {

    const { data, error } = await userA.client
      .from("items")
      .insert({ user_id: userA.id, condition: "good", attributes: { brand: "A" } })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(userA.id);

    const { data: readBack } = await userA.client
      .from("items")
      .select("id")
      .eq("id", data!.id);
    expect(readBack).toHaveLength(1);
  });

  it("user A CANNOT read user B's items / listings / messages / prediction_logs", async () => {


    // B creates one row in each domain table.
    const { data: bItem, error: bItemErr } = await userB.client
      .from("items")
      .insert({ user_id: userB.id, condition: "fair", attributes: { brand: "B" } })
      .select()
      .single();
    expect(bItemErr).toBeNull();

    await userB.client.from("listings").insert({
      user_id: userB.id,
      item_id: bItem!.id,
      platform: "ebay",
      title: "B listing",
      status: "draft",
    });
    await userB.client.from("messages").insert({
      user_id: userB.id,
      item_id: bItem!.id,
      direction: "inbound",
      body: "B message",
    });
    // prediction_logs.listing_model is NOT NULL (model provenance, #32). Provide it AND
    // assert the insert SUCCEEDS — a rejected insert would leave B with no prediction log,
    // so the isolation assertion below would pass WITHOUT ever testing prediction-log RLS.
    const { error: bLogErr } = await userB.client.from("prediction_logs").insert({
      user_id: userB.id,
      item_id: bItem!.id,
      tier_fired: "isbn",
      model: "test",
      listing_model: "test",
    });
    expect(bLogErr).toBeNull();

    // A queries each table broadly; RLS must filter B's rows out entirely.
    for (const table of [
      "items",
      "listings",
      "messages",
      "prediction_logs",
    ] as const) {
      const { data, error } = await userA.client.from(table).select("*");
      expect(error).toBeNull();
      const leaked = (data ?? []).filter((r) => r.user_id === userB.id);
      expect(leaked).toHaveLength(0);
    }

    // Targeted read of B's specific item id also returns nothing for A.
    const { data: targeted } = await userA.client
      .from("items")
      .select("*")
      .eq("id", bItem!.id);
    expect(targeted ?? []).toHaveLength(0);
  });

  it("user A CANNOT update or delete user B's item", async () => {


    const { data: bItem } = await userB.client
      .from("items")
      .insert({ user_id: userB.id, condition: "good", attributes: { brand: "B2" } })
      .select()
      .single();

    // UPDATE: RLS makes B's row invisible to A, so the update matches 0 rows.
    const { data: updated } = await userA.client
      .from("items")
      .update({ condition: "hijacked" })
      .eq("id", bItem!.id)
      .select();
    expect(updated ?? []).toHaveLength(0);

    // DELETE: same — 0 rows affected.
    const { data: deleted } = await userA.client
      .from("items")
      .delete()
      .eq("id", bItem!.id)
      .select();
    expect(deleted ?? []).toHaveLength(0);

    // B can still see their untouched row.
    const { data: stillThere } = await userB.client
      .from("items")
      .select("condition")
      .eq("id", bItem!.id)
      .single();
    expect(stillThere?.condition).toBe("good");
  });

  it("user A CANNOT insert a row owned by user B (WITH CHECK blocks spoofed user_id)", async () => {


    const { data, error } = await userA.client
      .from("items")
      .insert({ user_id: userB.id, condition: "spoofed", attributes: {} })
      .select();

    // The insert WITH CHECK (auth.uid() = user_id) must reject this.
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("user A CANNOT thread reply_to onto user B's message (tenant-aware composite FK)", async () => {


    // B has an inbound question awaiting B's reply.
    const { data: bMessage, error: bMsgErr } = await userB.client
      .from("messages")
      .insert({ user_id: userB.id, direction: "inbound", body: "B question" })
      .select("id")
      .single();
    expect(bMsgErr).toBeNull();

    // Referential-integrity checks BYPASS RLS, so without the composite FK
    // user A could insert their OWN row whose reply_to points at B's message,
    // letting the global reply_to unique index reserve B's slot (cross-tenant
    // denial of B's reply delivery). The (reply_to, user_id) -> (id, user_id)
    // FK must reject the foreign reference outright.
    const { data: hijack, error: hijackErr } = await userA.client
      .from("messages")
      .insert({
        user_id: userA.id,
        direction: "outbound",
        body: "squatting on B's slot",
        status: "sent",
        reply_to: bMessage!.id,
      })
      .select();
    expect(hijackErr).not.toBeNull();
    expect(hijack ?? []).toHaveLength(0);

    // B's own reply to B's own message still threads fine.
    const { error: legitErr } = await userB.client.from("messages").insert({
      user_id: userB.id,
      direction: "outbound",
      body: "B's actual reply",
      status: "sent",
      reply_to: bMessage!.id,
    });
    expect(legitErr).toBeNull();
  });
});
