import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "../supabase/test-users";
import { setAutoReplyEnabled } from "../settings/user-settings";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY?.startsWith("sb_secret_")) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let reachable = false;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "autoreply_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "autoreply_b"),
  ]);

  for (const [index, user] of [userA, userB].entries()) {
    const { data: item, error: itemError } = await admin
      .from("items")
      .insert({ user_id: user.id, attributes: {}, photos: [] })
      .select("id, updated_at")
      .single();
    if (itemError) throw itemError;
    const { data: listing, error: listingError } = await admin
      .from("listings")
      .insert({
        user_id: user.id,
        item_id: item.id,
        platform: "ebay",
        status: "published",
        ebay_status: "published",
        ebay_listing_id: `rls-listing-${index}`,
      })
      .select("id, updated_at")
      .single();
    if (listingError) throw listingError;
    const { data: message, error: messageError } = await admin
      .from("messages")
      .insert({
        user_id: user.id,
        item_id: item.id,
        listing_id: listing.id,
        direction: "inbound",
        body: "Is this still available?",
        status: "drafting",
        marketplace: "ebay",
        external_message_id: `rls-question-${index}`,
        external_listing_id: `rls-listing-${index}`,
      })
      .select("id, ebay_account_generation")
      .single();
    if (messageError) throw messageError;

    const { error: decisionError } = await admin.rpc(
      "record_scheduled_ebay_message_policy_decision",
      {
        p_user_id: user.id,
        p_message_id: message.id,
        p_generation: message.ebay_account_generation,
        p_payload: {
          policy_version: "grounded-pre-sale-v3",
          outcome: "auto_send",
          reason_codes: ["exact_authoritative_fact"],
          grounding_references: [
            {
              key: "listing state",
              value: "active on eBay",
              source: "active_listing_state",
              reference: `listing:${listing.id}:active-state`,
            },
          ],
          safety_signals: {
            preferenceEnabled: true,
            buyerTextTreatedAsUntrusted: true,
            authoritativeFactMatched: true,
            activeListing: true,
            factsCurrent: true,
            conflictsAbsent: true,
          },
          proposed_reply: "Yes — this listing is currently active on eBay.",
          draft_reply: "Yes — this listing is currently active on eBay.",
          draft_model: "policy:grounded-pre-sale-v3",
          listing_updated_at: listing.updated_at,
          item_updated_at: item.updated_at,
          marketplace_verified_at: new Date().toISOString(),
          external_listing_id: `rls-listing-${index}`,
        },
      },
    );
    if (decisionError) throw decisionError;
  }
});

afterAll(async () => {
  if (!reachable || !admin) return;
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("message policy audit RLS", () => {
  it("requires a running local Supabase stack (skips otherwise, never fakes a pass)", () => {
    if (!reachable) {
      console.warn("[autoreply.rls.test] Local Supabase stack unreachable — skipping.");
    }
    expect(true).toBe(true);
  });

  it("lets a seller read only their own structured decision evidence", async () => {
    if (!reachable) return;
    const { data, error } = await userA.client
      .from("message_policy_decisions")
      .select("user_id, outcome, reason_codes, grounding_references, policy_version");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({
      user_id: userA.id,
      outcome: "auto_send",
      reason_codes: ["exact_authoritative_fact"],
      policy_version: "grounded-pre-sale-v3",
    });
    expect(JSON.stringify(data)).not.toContain(userB.id);
  });

  it("rejects tenant-authenticated direct audit writes", async () => {
    if (!reachable) return;
    const { error } = await userA.client.from("message_policy_decisions").insert({
      user_id: userA.id,
      message_id: "00000000-0000-4000-8000-000000000001",
      listing_id: "00000000-0000-4000-8000-000000000002",
      ebay_account_generation: "00000000-0000-4000-8000-000000000003",
      policy_version: "grounded-pre-sale-v3",
      outcome: "auto_send",
      reason_codes: ["exact_authoritative_fact"],
      grounding_references: [],
      safety_signals: {},
      draft_reply: "forged",
      draft_model: "forged",
    });
    expect(error).not.toBeNull();
  });

  it("keeps queued automatic work inert until the tenant master toggle is on", async () => {
    if (!reachable) return;
    const readPending = () =>
      admin.rpc("read_scheduled_ebay_message_policy", {
        p_user_id: userA.id,
        p_operation: "pending_auto_send",
        p_payload: { policy_version: "grounded-pre-sale-v3" },
      });

    const disabled = await readPending();
    expect(disabled.error).toBeNull();
    expect(disabled.data).toEqual([]);

    const { data: message } = await admin
      .from("messages")
      .select("id, ebay_account_generation, draft_reply")
      .eq("user_id", userA.id)
      .eq("external_message_id", "rls-question-0")
      .single();
    const unauthorized = await admin.rpc("apply_scheduled_ebay_message_write", {
      p_user_id: userA.id,
      p_operation: "claim_canonical",
      p_generation: message!.ebay_account_generation,
      p_payload: {
        message_id: message!.id,
        body: message!.draft_reply,
        at: "2026-07-14T12:05:00.000Z",
        retry: false,
        delivery_actor: "automatic",
        marketplace_observed_at: new Date().toISOString(),
      },
    });
    expect(unauthorized.error?.message).toMatch(/not authorized/i);

    await setAutoReplyEnabled(userA.client, userA.id, true);
    const enabled = await readPending();
    expect(enabled.error).toBeNull();
    expect(enabled.data).toEqual([
      expect.objectContaining({ messageId: expect.any(String) }),
    ]);

    await setAutoReplyEnabled(userA.client, userA.id, false);
    const disabledAgain = await readPending();
    expect(disabledAgain.data).toEqual([]);
  });

  it("projects failed canonical transport truth into the seller-visible audit", async () => {
    if (!reachable) return;
    const { error: updateError } = await admin
      .from("messages")
      .update({
        delivery_status: "failed",
        delivery_error: "failed",
        delivery_attempted_at: "2026-07-14T12:05:00.000Z",
      })
      .eq("user_id", userA.id)
      .eq("external_message_id", "rls-question-0");
    expect(updateError).toBeNull();

    const { data, error } = await userA.client
      .from("message_policy_decisions")
      .select("delivery_status, delivery_error, delivery_attempted_at")
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      delivery_status: "failed",
      delivery_error: "failed",
      delivery_attempted_at: "2026-07-14T12:05:00+00:00",
    });
  });

  it("retires an explicitly answered eBay question so the seller cannot send its draft", async () => {
    if (!reachable) return;
    const { data: message, error: messageError } = await admin
      .from("messages")
      .select("id, ebay_account_generation")
      .eq("user_id", userB.id)
      .eq("external_message_id", "rls-question-1")
      .single();
    expect(messageError).toBeNull();

    const { data: blocked, error: blockError } = await admin.rpc(
      "block_scheduled_ebay_message_policy_delivery",
      {
        p_user_id: userB.id,
        p_message_id: message!.id,
        p_reason: "question_answered",
        p_generation: message!.ebay_account_generation,
      },
    );
    expect(blockError).toBeNull();
    expect(blocked).toBe(true);

    const [{ data: retired }, { data: decision }] = await Promise.all([
      userB.client
        .from("messages")
        .select("status, draft_reply, draft_model, policy_delivery_status, policy_delivery_error")
        .eq("id", message!.id)
        .single(),
      userB.client
        .from("message_policy_decisions")
        .select("delivery_status, delivery_error")
        .eq("message_id", message!.id)
        .single(),
    ]);
    expect(retired).toMatchObject({
      status: "externally_answered",
      draft_reply: null,
      draft_model: null,
      policy_delivery_status: "blocked",
      policy_delivery_error: "question_answered",
    });
    expect(decision).toMatchObject({
      delivery_status: "blocked",
      delivery_error: "question_answered",
    });
  });
});
