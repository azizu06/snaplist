import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import { serverRpcHeaders } from "@/lib/supabase/server-rpc-auth";
import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import {
  createSupabaseSellerPushStore,
  type SellerPushRpcClient,
} from "./store";

/**
 * Issue #891. The read path the sender is allowed to have, proved live.
 *
 * #890 gave `service_role` delete on `public.device_tokens` and deliberately no
 * select, so a sender holding the server key cannot enumerate anybody's push
 * address. That asymmetry is the entire tenancy boundary of this feature, and
 * the way it gets quietly lost is somebody adding one grant while wiring a
 * sender. The first test below fails the moment that happens.
 *
 * Everything else is scoped through `security definer` functions that take a
 * tenant rather than a filter, so there is no shape of call that returns two
 * sellers' rows. Each refusal is paired with the same call succeeding for the
 * tenant that owns the data, so an empty result can only mean scoping and never
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
const SERVER_RPC_SECRET = process.env.SERVER_RPC_SECRET;

/** 64 lowercase hex characters, the shape #890's check constraint accepts. */
const OWNER_PHONE = "1".repeat(64);
const OWNER_TABLET = "2".repeat(64);
const INTRUDER_PHONE = "3".repeat(64);
const ERASED_PHONE = "4".repeat(64);

let reachable = false;
/**
 * The worker's client, built the way `createAdminClient` builds it. Its
 * `service_role` claim is what `private.is_server_api_request()` accepts for a
 * caller that holds no seller session at all.
 */
let admin: SupabaseClient;
/** Ground truth, with RLS and PostgREST out of the way. */
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
    requiredValues: [ANON_KEY, SERVICE_ROLE_KEY, SERVER_RPC_SECRET],
  });
  await whenStackReachable(reachable, async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    db = new Client({ connectionString: resolveLocalTestDatabaseUrl() });
    await db.connect();
    [owner, intruder, erased] = await Promise.all([
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "push_owner"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "push_intruder"),
      provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "push_erased"),
    ]);

    // Registered through the seller's own client, the way #890's store does it,
    // so what the scoped read returns is what a real registration wrote. The
    // owner's two devices go in separately: `last_seen_at` orders the result and
    // one statement would give both rows the same timestamp.
    await register(owner, OWNER_PHONE, "production");
    await register(owner, OWNER_TABLET, "sandbox");
    await register(intruder, INTRUDER_PHONE, "production");
    await register(erased, ERASED_PHONE, "sandbox");
  });
});

afterAll(async () => {
  if (!reachable || !admin) return;
  const ids = [owner.id, intruder.id, erased.id];
  await db.query("delete from public.device_tokens where user_id = any($1)", [
    ids,
  ]);
  await db.query(
    "delete from private.seller_push_deliveries where user_id = any($1)",
    [ids],
  );
  await db.query(
    "delete from private.account_erasure_generations where user_id = any($1)",
    [ids],
  );
  await cleanupClerkTestUsers(admin, ids);
  await db.end();
});

async function register(
  user: ClerkTestUser,
  token: string,
  environment: "sandbox" | "production",
): Promise<void> {
  const { error } = await user.client.from("device_tokens").insert({
    platform: "ios",
    token,
    user_id: user.id,
    apns_environment: environment,
  });
  expect(error).toBeNull();
}

function rpcClientFor(client: SupabaseClient): SellerPushRpcClient {
  return {
    async rpc(functionName, args) {
      const { data, error } = await client.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
}

/**
 * The worker's store: `service_role`, no seller session, tenant taken from the
 * stored run because there is nothing else it could come from.
 */
function workerStore() {
  return createSupabaseSellerPushStore(rpcClientFor(admin));
}

/**
 * The publish path's store. Production builds this client with a secret API key
 * at the gateway; the role that reaches Postgres comes from the seller's bearer
 * either way, and the server header is what marks it as a SnapList server call.
 */
async function tenantServerStore(userId: string) {
  const token = await mintUserJwt(userId);
  return createSupabaseSellerPushStore(
    rpcClientFor(
      createClient(SUPABASE_URL, ANON_KEY!, {
        accessToken: async () => token,
        global: { headers: serverRpcHeaders(SERVER_RPC_SECRET!) },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ),
  );
}

/** A seller's ordinary app client: authenticated, but not a server request. */
function sellerAppStore(user: ClerkTestUser) {
  return createSupabaseSellerPushStore(rpcClientFor(user.client));
}

describe("the sender's read path", () => {
  it("still refuses the server key a direct read of the token table", async () => {
    // #890's grant, restated as a test because #891 is exactly the change that
    // would be tempted to loosen it. The sender reads through the scoped
    // function below or it does not read at all.
    const { data, error } = await admin
      .from("device_tokens")
      .select("token")
      .eq("user_id", owner.id);

    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });

  it("gives the worker one seller's devices, newest first, each with the environment it registered under", async () => {
    // The environment is carried per device rather than per process because a
    // seller and a developer can hold rows in one tenant, and a token sent to
    // the wrong APNs host is accepted and then dropped.
    await expect(workerStore().devicesForUser(owner.id)).resolves.toEqual([
      { platform: "ios", token: OWNER_TABLET, environment: "sandbox" },
      { platform: "ios", token: OWNER_PHONE, environment: "production" },
    ]);
  });

  it("returns nothing at all for a seller who is not the one named", async () => {
    // Paired with the assertion above: both sellers have a device, so an empty
    // answer here can only mean the function scoped it away.
    await expect(workerStore().devicesForUser(intruder.id)).resolves.toEqual([
      { platform: "ios", token: INTRUDER_PHONE, environment: "production" },
    ]);
    const owned = await workerStore().devicesForUser(owner.id);
    expect(owned.map((device) => device.token)).not.toContain(INTRUDER_PHONE);
  });

  it("refuses a signed-in seller who names another seller's tenant", async () => {
    // The escalation this feature actually exposes: the publish path's client
    // carries the server header, so `is_server_api_request()` alone would let a
    // seller's own request ask for somebody else's phone.
    const store = await tenantServerStore(owner.id);

    await expect(store.devicesForUser(intruder.id)).rejects.toThrow(
      /does not match/i,
    );
    await expect(store.devicesForUser(owner.id)).resolves.toHaveLength(2);
  });

  it("refuses a caller that is not a SnapList server request", async () => {
    // The seller's own app client, holding a valid session for the tenant it is
    // asking about. Reading a device list is a server capability regardless.
    await expect(sellerAppStore(owner).devicesForUser(owner.id)).rejects.toThrow(
      /server request/i,
    );
  });
});

describe("claiming a push moment", () => {
  it("hands the moment to exactly one caller", async () => {
    const store = workerStore();
    const claim = {
      userId: owner.id,
      moment: "listingReady" as const,
      eventKey: "run-a",
    };

    await expect(store.claimDelivery(claim)).resolves.toBe(true);
    await expect(store.claimDelivery(claim)).resolves.toBe(false);
    await expect(store.claimDelivery(claim)).resolves.toBe(false);
  });

  it("treats a different run, moment, and seller as different moments", async () => {
    const store = workerStore();

    await expect(
      store.claimDelivery({
        userId: owner.id,
        moment: "listingReady",
        eventKey: "run-b",
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimDelivery({
        userId: owner.id,
        moment: "listingPublished",
        eventKey: "run-a",
      }),
    ).resolves.toBe(true);
    // One seller's announcement must not silence another's, which is what a
    // key that forgot the tenant would do.
    await expect(
      store.claimDelivery({
        userId: intruder.id,
        moment: "listingReady",
        eventKey: "run-a",
      }),
    ).resolves.toBe(true);
  });

  it("refuses a signed-in seller claiming against another seller's tenant", async () => {
    const store = await tenantServerStore(owner.id);

    await expect(
      store.claimDelivery({
        userId: intruder.id,
        moment: "listingPublished",
        eventKey: "listing-cross-tenant",
      }),
    ).rejects.toThrow(/does not match/i);

    const { rows } = await db.query<{ count: string }>(
      "select count(*) as count from private.seller_push_deliveries where user_id = $1 and event_key = $2",
      [intruder.id, "listing-cross-tenant"],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});

describe("forgetting a device Apple reports as gone", () => {
  it("removes the named device and leaves the seller's others alone", async () => {
    await workerStore().forgetDevice({
      userId: owner.id,
      platform: "ios",
      token: OWNER_TABLET,
    });

    await expect(workerStore().devicesForUser(owner.id)).resolves.toEqual([
      { platform: "ios", token: OWNER_PHONE, environment: "production" },
    ]);
  });

  it("refuses a signed-in seller deleting another seller's device", async () => {
    const store = await tenantServerStore(owner.id);

    await expect(
      store.forgetDevice({
        userId: intruder.id,
        platform: "ios",
        token: INTRUDER_PHONE,
      }),
    ).rejects.toThrow(/does not match/i);

    await expect(workerStore().devicesForUser(intruder.id)).resolves.toEqual([
      { platform: "ios", token: INTRUDER_PHONE, environment: "production" },
    ]);
  });
});

describe("push claims under account erasure", () => {
  it("takes the seller's claims with the account and refuses late ones", async () => {
    await expect(
      workerStore().claimDelivery({
        userId: erased.id,
        moment: "listingReady",
        eventKey: "run-erased",
      }),
    ).resolves.toBe(true);

    const eraser = new Client({
      connectionString: resolveLocalTestDatabaseUrl(),
    });
    await eraser.connect();
    try {
      await eraser.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      await eraser.query("select public.begin_account_erasure($1, $2::uuid)", [
        erased.id,
        "89100000-0000-4000-8000-000000000001",
      ]);
    } finally {
      await eraser.end();
    }

    // The exhaustive counter is what erasure reports completion from, so a
    // table it does not know about would let erasure claim it finished while
    // the deleted account still had rows naming it.
    const { rows } = await db.query<{ count: number }>(
      "select private.account_erasure_owned_row_count($1) as count",
      [erased.id],
    );
    expect(rows[0]!.count).toBe(0);

    // A dispatch already in flight when erasure began must not write a claim
    // behind it.
    await expect(
      workerStore().claimDelivery({
        userId: erased.id,
        moment: "listingPublished",
        eventKey: "listing-erased",
      }),
    ).rejects.toThrow(/Account erasure has started/);
  });
});
