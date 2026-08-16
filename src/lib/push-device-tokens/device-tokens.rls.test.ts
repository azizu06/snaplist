import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import {
  createSupabasePushDeviceTokenStore,
  type DeviceTokenDatabaseClient,
  type PushDeviceTokenStore,
} from "./store";

/**
 * Issue #890. Tenancy for `public.device_tokens`, proved against live policies.
 *
 * A device token is the address of one seller's phone. If a policy here is
 * wrong, the failure is not a broken screen — it is one seller's device
 * reachable from another seller's account, which no client-side check can
 * undo. So every claim below is made through a real per-seller JWT against the
 * real policy, and each refusal is paired with the same read succeeding for the
 * tenant that owns the row, so an empty result can only mean scoping and never
 * a fixture that failed to write.
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

/**
 * A well-formed APNs token: 64 lowercase hex characters, the length Apple
 * issues today. The two sellers deliberately register the SAME device string,
 * because that is the case where a global uniqueness rule would have forced one
 * tenant's row to answer for the other's.
 */
const SHARED_DEVICE_TOKEN = "a".repeat(64);
const OWNER_ONLY_TOKEN = "b".repeat(64);
const ERASED_DEVICE_TOKEN = "e".repeat(64);

let reachable = false;
let admin: SupabaseClient;
/**
 * Ground truth for what the table actually holds, read straight from Postgres.
 * `service_role` is deliberately granted nothing but `delete` here, so it can
 * never read a seller's push address; the erasure trigger, not a server-side
 * client, is what removes rows. Teardown and counting therefore run on this
 * superuser connection rather than widening a production grant to suit a test.
 */
let db: Client;
let owner: ClerkTestUser;
let intruder: ClerkTestUser;
let erased: ClerkTestUser;

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
    [owner, intruder, erased] = await Promise.all([
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "device_owner"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "device_intruder"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "device_erased"),
    ]);
  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  const ids = [owner.id, intruder.id, erased.id];
  await db.query("delete from public.device_tokens where user_id = any($1)", [
    ids,
  ]);
  await db.query(
    "delete from private.account_erasure_generations where user_id = any($1)",
    [ids],
  );
  await cleanupClerkTestUsers(admin, ids);
  await db.end();
});

/** Counts rows as the database sees them, with RLS and PostgREST out of the way. */
async function storedRowCount(
  where: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*) as count from public.device_tokens where ${where}`,
    [...values],
  );
  return Number(result.rows[0]!.count);
}

/** Epoch milliseconds of one row's `last_seen_at`, read as the database holds it. */
async function lastSeenAt(userId: string, token: string): Promise<number> {
  const result = await db.query<{ last_seen_at: Date }>(
    "select last_seen_at from public.device_tokens where user_id = $1 and token = $2",
    [userId, token],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.last_seen_at.getTime();
}

/**
 * The shipped store, bound to one seller's already-authenticated client. The
 * bearer argument is therefore inert here; what is under test is the write the
 * store performs, against the live policy.
 */
function storeFor(user: ClerkTestUser): PushDeviceTokenStore {
  return createSupabasePushDeviceTokenStore(
    () => user.client as unknown as DeviceTokenDatabaseClient,
  );
}

async function ownedTokens(user: ClerkTestUser): Promise<string[]> {
  const { data, error } = await user.client
    .from("device_tokens")
    .select("token")
    .order("token");
  expect(error).toBeNull();
  return (data ?? []).map((row) => row.token as string);
}

describe("device_tokens tenancy under live RLS", () => {
  it("stores a seller's own registration and shows it to nobody else", async () => {
    const { error } = await owner.client.from("device_tokens").insert({
      platform: "ios",
      token: OWNER_ONLY_TOKEN,
      user_id: owner.id,
    });
    expect(error).toBeNull();

    // The owner-visible half first: without it, the intruder's empty read below
    // would pass just as well against a row that was never written.
    await expect(ownedTokens(owner)).resolves.toContain(OWNER_ONLY_TOKEN);
    await expect(ownedTokens(intruder)).resolves.not.toContain(OWNER_ONLY_TOKEN);
  });

  it("refuses a write addressed to another seller's tenant", async () => {
    const { error } = await intruder.client.from("device_tokens").insert({
      platform: "ios",
      token: "c".repeat(64),
      user_id: owner.id,
    });

    expect(error?.code).toBe("42501");
    await expect(ownedTokens(owner)).resolves.not.toContain("c".repeat(64));
  });

  it("cannot re-key another seller's row onto the caller", async () => {
    const { data } = await intruder.client
      .from("device_tokens")
      .update({ user_id: intruder.id })
      .eq("user_id", owner.id)
      .select("token");

    // The update matches nothing, because the row it names is invisible to this
    // caller in the first place.
    expect(data ?? []).toEqual([]);
    await expect(ownedTokens(owner)).resolves.toContain(OWNER_ONLY_TOKEN);
    await expect(ownedTokens(intruder)).resolves.not.toContain(OWNER_ONLY_TOKEN);
  });

  it("cannot push its own row into another seller's tenant", async () => {
    const { error } = await intruder.client.from("device_tokens").insert({
      platform: "ios",
      token: SHARED_DEVICE_TOKEN,
      user_id: intruder.id,
    });
    expect(error).toBeNull();

    const { error: rekeyError } = await intruder.client
      .from("device_tokens")
      .update({ user_id: owner.id })
      .eq("token", SHARED_DEVICE_TOKEN);

    expect(rekeyError?.code).toBe("42501");
    await expect(ownedTokens(owner)).resolves.not.toContain(SHARED_DEVICE_TOKEN);
    await expect(ownedTokens(intruder)).resolves.toContain(SHARED_DEVICE_TOKEN);
  });

  it("lets two sellers hold the same device string without either seeing the other", async () => {
    const { error } = await owner.client.from("device_tokens").insert({
      platform: "ios",
      token: SHARED_DEVICE_TOKEN,
      user_id: owner.id,
    });
    expect(error).toBeNull();

    // Scoped to this pair: another worker's leftover row must not be able to
    // turn a genuine duplicate into a passing count, or the reverse.
    await expect(
      storedRowCount("token = $1 and user_id = any($2)", [
        SHARED_DEVICE_TOKEN,
        [owner.id, intruder.id],
      ]),
    ).resolves.toBe(2);

    await expect(ownedTokens(owner)).resolves.toEqual([
      SHARED_DEVICE_TOKEN,
      OWNER_ONLY_TOKEN,
    ]);
    await expect(ownedTokens(intruder)).resolves.toEqual([SHARED_DEVICE_TOKEN]);
  });

  it("keeps one row when the same device registers again", async () => {
    const before = await lastSeenAt(owner.id, OWNER_ONLY_TOKEN);

    // Through the production store, not a hand-written upsert: the conflict
    // target is the part that has to be right, and a test that spells it out
    // itself would still pass if the shipped code spelled it differently.
    await storeFor(owner).register({
      bearerToken: "unused: the client is already bound to this seller",
      platform: "ios",
      token: OWNER_ONLY_TOKEN,
      userId: owner.id,
    });

    await expect(
      storedRowCount("user_id = $1 and token = $2", [
        owner.id,
        OWNER_ONLY_TOKEN,
      ]),
    ).resolves.toBe(1);

    const after = await lastSeenAt(owner.id, OWNER_ONLY_TOKEN);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe("device_tokens under account erasure", () => {
  it("takes the seller's devices with the account and refuses late registrations", async () => {
    await storeFor(erased).register({
      bearerToken: "unused: the client is already bound to this seller",
      platform: "ios",
      token: ERASED_DEVICE_TOKEN,
      userId: erased.id,
    });
    await expect(
      storedRowCount("user_id = $1", [erased.id]),
    ).resolves.toBe(1);

    // Erasure runs as the platform, the way the real capability invokes it.
    const eraser = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
    await eraser.connect();
    try {
      await eraser.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      await eraser.query("select public.begin_account_erasure($1, $2::uuid)", [
        erased.id,
        "89000000-0000-4000-8000-000000000001",
      ]);
    } finally {
      await eraser.end();
    }

    await expect(storedRowCount("user_id = $1", [erased.id])).resolves.toBe(0);
    // The exhaustive counter is what account erasure reports completion from,
    // so a table it does not know about would let erasure claim it finished
    // while a deleted account's phone stayed addressable.
    const { rows } = await db.query<{ count: number }>(
      "select private.account_erasure_owned_row_count($1) as count",
      [erased.id],
    );
    expect(rows[0]!.count).toBe(0);

    // A registration already in flight when erasure began must not resurrect
    // the account's reachability behind it.
    const { error } = await erased.client.from("device_tokens").insert({
      platform: "ios",
      token: ERASED_DEVICE_TOKEN,
      user_id: erased.id,
    });
    expect(error?.message ?? "").toMatch(/Account erasure has started/);
    await expect(storedRowCount("user_id = $1", [erased.id])).resolves.toBe(0);
  });
});
