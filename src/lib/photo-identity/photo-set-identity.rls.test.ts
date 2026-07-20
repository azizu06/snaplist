import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PHOTO_SET_KIND = "content_sha256_set_v1";
const PHOTO_SET_FINGERPRINT =
  "2601809a314994324ece98d372ae5f7f546deaa21d430b76331d96dcfd5e75a9";

let reachable = false;
let admin: SupabaseClient;
let seller: ClerkTestUser;
let queueMessageId: string | undefined;

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    return (
      await fetch(`${SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: ANON_KEY },
        signal: AbortSignal.timeout(2_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  seller = await provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "photo_identity");
});

afterAll(async () => {
  if (!reachable) return;
  if (queueMessageId) {
    await admin.rpc("ack_pipeline_message", { p_message_id: queueMessageId });
  }
  await cleanupClerkTestUsers(admin, [seller.id]);
});

describe("versioned photo-set identity persistence", () => {
  it("binds one server-verified content identity to the item, run, and credit reservation", async () => {
    if (!reachable) return;
    const idempotencyKey = `photo-identity-${crypto.randomUUID()}`;
    const entry = {
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [
        `${seller.id}/verified/front.jpg`,
        `${seller.id}/verified/detail.jpg`,
        `${seller.id}/verified/back.jpg`,
      ],
      cost_basis: null,
    };
    const stageArgs = {
      p_user_id: seller.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry],
      p_daily_limit: 10,
      p_per_minute_limit: 10,
      p_photo_identities: [
        {
          idempotency_key: idempotencyKey,
          photo_identity_kind: PHOTO_SET_KIND,
          photo_identity_fingerprint: PHOTO_SET_FINGERPRINT,
        },
      ],
    };
    const staged = await admin.rpc("stage_pipeline_batch", stageArgs);

    expect(staged.error).toBeNull();
    const receipt = (staged.data as Array<{
      item_id: string;
      run_id: string;
      queue_message_id: string | number;
    }>)[0];
    queueMessageId = String(receipt.queue_message_id);

    const replay = await admin.rpc("stage_pipeline_batch", stageArgs);
    expect(replay).toMatchObject({ error: null, data: staged.data });

    const orderedRequestConflict = await admin.rpc("stage_pipeline_batch", {
      ...stageArgs,
      p_entries: [{ ...entry, photo_paths: [...entry.photo_paths].reverse() }],
    });
    expect(orderedRequestConflict.error).toMatchObject({ code: "23514" });

    const [{ data: item }, { data: run }, { data: reservation }] = await Promise.all([
      seller.client
        .from("items")
        .select("photo_identity_kind, photo_identity_fingerprint")
        .eq("id", receipt.item_id)
        .single(),
      seller.client
        .from("pipeline_runs")
        .select("photo_identity_kind, photo_identity_fingerprint")
        .eq("id", receipt.run_id)
        .single(),
      seller.client
        .from("ai_item_credit_reservations")
        .select("photo_identity_kind, photo_identity_fingerprint")
        .eq("pipeline_run_id", receipt.run_id)
        .single(),
    ]);

    const expectedIdentity = {
      photo_identity_kind: PHOTO_SET_KIND,
      photo_identity_fingerprint: PHOTO_SET_FINGERPRINT,
    };
    expect(item).toEqual(expectedIdentity);
    expect(run).toEqual(expectedIdentity);
    expect(reservation).toEqual(expectedIdentity);

    const mutation = await seller.client
      .from("items")
      .update({ photo_identity_fingerprint: "f".repeat(64) })
      .eq("id", receipt.item_id);
    expect(mutation.error).toMatchObject({ code: "23514" });
  });
});
