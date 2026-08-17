import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";

/**
 * Issue #890. A guest registers a device, then claims an account. The phone in
 * the seller's hand did not change, so the registration must move with the
 * identity — otherwise the token is stranded under an id nothing will ever
 * address again, and the seller silently stops hearing about their listings.
 *
 * The move is driven the way production drives it: by the state transition
 * `public.complete_guest_draft_claim` performs on
 * `private.guest_draft_recoveries` at the end of a claim. The recovery row is
 * built here directly, because everything else that function touches (drafts,
 * reservations, storage) is irrelevant to whether the device follows.
 *
 * Requires a running local Supabase stack; skips (never fakes a pass) otherwise.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GUEST_DEVICE_TOKEN = "d".repeat(64);

let reachable = false;
let admin: SupabaseClient;
let db: Client;
const provisionedUserIds: string[] = [];

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

beforeAll(async () => {
  reachable = await stackReachable({
    url: SUPABASE_URL,
    apiKey: ANON_KEY,
    requiredValues: [ANON_KEY, SERVICE_ROLE_KEY],
  });
  await whenStackReachable(reachable, async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    db = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
    await db.connect();
  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  await db.query("delete from public.device_tokens where user_id = any($1)", [
    provisionedUserIds,
  ]);
  await db.query(
    "delete from private.guest_draft_recoveries where guest_user_id = any($1)",
    [provisionedUserIds],
  );
  await cleanupClerkTestUsers(admin, provisionedUserIds);
  await db.end();
});

/** A signed-in guest: a real minted JWT, so its writes go through real policies. */
async function provisionGuest(label: string): Promise<ClerkTestUser> {
  const id = `guest_${createHash("sha256")
    .update(`device-token-guest-${label}-${randomUUID()}`)
    .digest("hex")
    .slice(0, 48)}`;
  const jwt = await mintUserJwt(id);
  provisionedUserIds.push(id);
  return {
    id,
    client: createClient(SUPABASE_URL, ANON_KEY!, {
      accessToken: async () => jwt,
    }),
  };
}

async function provisionMember(label: string): Promise<ClerkTestUser> {
  const member = await provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, label);
  provisionedUserIds.push(member.id);
  return member;
}

/**
 * Stages a recovery mid-claim, exactly as `complete_guest_draft_claim` finds it
 * — state `copying`, with the target account already decided — and returns its
 * id so a test can drive the final transition.
 */
async function stageRecoveryMidClaim(
  guestId: string,
  targetId: string,
): Promise<string> {
  const recoveryId = randomUUID();
  const usableDraftAt = new Date().toISOString();
  await db.query(
    `insert into private.guest_draft_recoveries (
       id, guest_user_id, pipeline_run_id, item_id, draft_id, reservation_id,
       allowance_period_id, recovery_token_hash, encrypted_artifact,
       storage_manifest, storage_object_count, usable_draft_at, expires_at,
       state, claim_target_user_id, claim_lease_token, claim_lease_expires_at
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, '{"version":1}'::jsonb,
       '[]'::jsonb, 1, $9::timestamptz, $9::timestamptz + interval '24 hours',
       'copying', $10, $11, now() + interval '10 minutes'
     )`,
    [
      recoveryId,
      guestId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      createHash("sha256").update(recoveryId).digest("hex"),
      usableDraftAt,
      targetId,
      randomUUID(),
    ],
  );
  return recoveryId;
}

/** Performs the transition that ends a claim, the one production's claim ends on. */
async function completeClaim(recoveryId: string): Promise<void> {
  await db.query(
    `update private.guest_draft_recoveries
     set state = 'claimed',
         claimed_lease_token = claim_lease_token,
         claim_lease_token = null,
         claim_lease_expires_at = null,
         claimed_storage_manifest = storage_manifest,
         storage_manifest = null,
         encrypted_artifact = null,
         claimed_at = now()
     where id = $1`,
    [recoveryId],
  );
}

async function tokensHeldBy(userId: string): Promise<string[]> {
  const result = await db.query<{ token: string }>(
    "select token from public.device_tokens where user_id = $1 order by token",
    [userId],
  );
  return result.rows.map((row) => row.token);
}

describe("a claimed guest keeps its device registration", () => {
  it("moves the guest's token onto the account that claimed it", async () => {
    const guest = await provisionGuest("moves");
    const member = await provisionMember("device_claim_moves");

    const { error } = await guest.client.from("device_tokens").insert({
      apns_environment: "production",
      platform: "ios",
      token: GUEST_DEVICE_TOKEN,
      user_id: guest.id,
    });
    expect(error).toBeNull();

    await completeClaim(await stageRecoveryMidClaim(guest.id, member.id));

    await expect(tokensHeldBy(guest.id)).resolves.toEqual([]);
    await expect(tokensHeldBy(member.id)).resolves.toEqual([GUEST_DEVICE_TOKEN]);

    // The member must be able to see it under their own JWT, not merely have a
    // row filed under their id: a moved row the account cannot read is still a
    // device the seller has lost.
    const { data } = await member.client.from("device_tokens").select("token");
    expect((data ?? []).map((row) => row.token)).toEqual([GUEST_DEVICE_TOKEN]);
  });

  it("leaves one row when the account already registered the same device", async () => {
    const guest = await provisionGuest("dedupes");
    const member = await provisionMember("device_claim_dedupes");

    for (const seller of [guest, member]) {
      const { error } = await seller.client.from("device_tokens").insert({
        apns_environment: "production",
        platform: "ios",
        token: GUEST_DEVICE_TOKEN,
        user_id: seller.id,
      });
      expect(error).toBeNull();
    }

    await completeClaim(await stageRecoveryMidClaim(guest.id, member.id));

    // Both halves matter: the guest row is gone, and folding it in did not
    // leave the account holding the same device twice.
    await expect(tokensHeldBy(guest.id)).resolves.toEqual([]);
    await expect(tokensHeldBy(member.id)).resolves.toEqual([GUEST_DEVICE_TOKEN]);
  });

  it("leaves the token alone while a claim is still only in progress", async () => {
    const guest = await provisionGuest("in_progress");
    const member = await provisionMember("device_claim_in_progress");

    const { error } = await guest.client.from("device_tokens").insert({
      apns_environment: "production",
      platform: "ios",
      token: GUEST_DEVICE_TOKEN,
      user_id: guest.id,
    });
    expect(error).toBeNull();

    // Staged, leased, target chosen — but the claim has not completed, and a
    // claim that never completes must not hand the device to that account.
    await stageRecoveryMidClaim(guest.id, member.id);

    await expect(tokensHeldBy(guest.id)).resolves.toEqual([GUEST_DEVICE_TOKEN]);
    await expect(tokensHeldBy(member.id)).resolves.toEqual([]);
  });
});
