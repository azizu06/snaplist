import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { resolveNewAiItemRunPolicy } from "./item-run-policy";

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

async function createGeneratedDraft(user: ClerkTestUser): Promise<void> {
  const { data: item, error: itemError } = await user.client
    .from("items")
    .insert({ user_id: user.id, attributes: { category: "test" } })
    .select("id")
    .single();
  expect(itemError).toBeNull();

  const runId = crypto.randomUUID();
  const { error: predictionError } = await user.client.from("prediction_logs").insert({
    user_id: user.id,
    item_id: item!.id,
    run_id: runId,
    extracted_attrs: { category: "test" },
    price: 10,
    price_range: { low: 8, high: 12 },
    confidence: 0.8,
    tier_fired: "llm-only",
    model: "test-model",
    listing_model: "test-model",
    pricing_model: "test-model",
    sources: [],
  });
  expect(predictionError).toBeNull();

  const { error: listingError } = await user.client.from("listings").insert({
    user_id: user.id,
    item_id: item!.id,
    run_id: runId,
    platform: "ebay",
    title: "Generated draft",
    description: "Generated draft",
  });
  expect(listingError).toBeNull();
}

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: ANON_KEY, requiredValues: [ANON_KEY, SERVICE_ROLE_KEY] });
  await whenStackReachable(reachable, async () => {

  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "item_policy_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "item_policy_b"),
  ]);

  await createGeneratedDraft(userB);
  const { error } = await admin.from("subscriptions").insert({
    user_id: userB.id,
    stripe_customer_id: `cus_${userB.id}`,
    stripe_subscription_id: `sub_${userB.id}`,
    tier: "paid",
    status: "active",
    current_period_end: "2099-01-01T00:00:00.000Z",
  });
  expect(error).toBeNull();

  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("new AI-item policy RLS boundary", () => {
  it("reports when the local Supabase integration seam is unavailable", () => {
    if (!reachable) {
      console.warn(
        "[item-run-policy.rls.test] Local Supabase unavailable; run a reset and export `supabase status -o env`.",
      );
    }
    expect(true).toBe(true);
  });

  it("does not let another tenant's generated draft or paid mirror consume or grant access", async () => {


    await expect(
      resolveNewAiItemRunPolicy(userA.id, { client: userA.client }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: "included-first-run",
      hasCompletedAiItemRun: false,
    });

    await expect(
      resolveNewAiItemRunPolicy(userB.id, { client: userB.client }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: "snaplist-pro",
      entitlement: "paid",
      hasCompletedAiItemRun: true,
    });
  });

  it("requires Pro after this tenant has its own completed generated draft", async () => {

    await createGeneratedDraft(userA);

    await expect(
      resolveNewAiItemRunPolicy(userA.id, { client: userA.client }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "snaplist-pro-required",
      entitlement: "free",
      hasCompletedAiItemRun: true,
    });
  });
});
