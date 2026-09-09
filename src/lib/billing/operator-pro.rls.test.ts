import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  grantIncludedOfferDeviceClaim,
  mintUserJwt,
} from "@/lib/supabase/test-users";
import { canonicalizeVerifiedPhotoSet } from "@/lib/photo-identity/photo-set";
import {
  OPERATOR_PRO_ALLOWANCE,
  ensureOperatorProAllowance,
  type OperatorProGrantClient,
} from "./operator-pro";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

interface StagedRun {
  item_id: string;
  run_id: string;
  queue_message_id: string;
}

interface TestUser {
  id: string;
  client: SupabaseClient;
}

let reachable = false;
let admin: SupabaseClient;
let operator: TestUser;
let seller: TestUser;
const queueMessageIds = new Set<string>();

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

/**
 * `provisionClerkTestUser` builds ids like `user_test_label_1757…`, and the
 * underscores in that shape are exactly what the operator fence refuses. These
 * tests need identities that look like the real thing — `user_` followed by
 * base58 — because the whole point is that the database accepts nothing else.
 */
async function provisionClerkShapedUser(label: string): Promise<TestUser> {
  const id = `user_2${label}${Math.random().toString(36).slice(2, 12)}${Date.now()
    .toString(36)
    .replace(/[^a-z0-9]/gi, "")}`;
  const jwt = await mintUserJwt(id);
  return {
    id,
    client: createClient(SUPABASE_URL, ANON_KEY!, {
      accessToken: async () => jwt,
    }),
  };
}

function stageArgs(userId: string, key: string) {
  const batchId = crypto.randomUUID();
  const entries = [
    {
      idempotency_key: key,
      source: "single" as const,
      autopilot_enabled: false,
      photo_paths: [`${userId}/operator/${batchId}/0/front.jpg`],
      cost_basis: null,
    },
  ];
  return {
    p_batch_id: batchId,
    p_daily_limit: 1_000,
    p_entries: entries,
    p_per_minute_limit: 1_000,
    p_photo_identities: entries.map((entry) => ({
      idempotency_key: entry.idempotency_key,
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: canonicalizeVerifiedPhotoSet([
        createHash("sha256").update(entry.photo_paths[0]).digest("hex"),
      ]).fingerprint,
    })),
    p_user_id: userId,
  };
}

async function stage(userId: string, key: string) {
  const result = await admin.rpc("stage_pipeline_batch", stageArgs(userId, key));
  if (!result.error) {
    for (const row of result.data as StagedRun[]) {
      queueMessageIds.add(String(row.queue_message_id));
    }
  }
  return result;
}

async function periodsFor(user: TestUser) {
  const { data, error } = await user.client
    .from("ai_item_allowance_periods")
    .select("id, source, period_key, state, allowance, original_transaction_id");
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    source: string;
    period_key: string;
    state: string;
    allowance: number;
    original_transaction_id: string | null;
  }>;
}

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
    [operator, seller] = await Promise.all([
      provisionClerkShapedUser("operator"),
      provisionClerkShapedUser("seller"),
    ]);
    // Both accounts start past the #524 device fence, so run #1 spends the
    // included offer for each and run #2 is the honest Pro gate.
    await Promise.all(
      [operator, seller].map((user) =>
        grantIncludedOfferDeviceClaim(admin, user.id),
      ),
    );
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
    await Promise.all(
      [...queueMessageIds].map((messageId) =>
        admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
      ),
    );
    await cleanupClerkTestUsers(admin, [operator.id, seller.id]);
  });
});

describe("operator SnapList Pro grant DB/RLS boundary", () => {
  it("turns the same denied second run into a reserved one, and records it in the ledger", async () => {
    const granted = { SNAPLIST_PRO_OPERATOR_USER_IDS: operator.id };
    const client = admin as unknown as OperatorProGrantClient;

    const first = await stage(operator.id, `operator-run-1-${operator.id}`);
    expect(first.error).toBeNull();

    // Before the grant the reviewer is an ordinary exhausted account. This is
    // the assertion the whole issue exists to invert, so it runs against the
    // very same logical run that succeeds below.
    const deniedBefore = await stage(operator.id, `operator-run-2-${operator.id}`);
    expect(deniedBefore.error?.message).toMatch(/snaplist-pro-required/i);

    await expect(
      ensureOperatorProAllowance({ userId: operator.id, client, env: granted }),
    ).resolves.toBe(true);

    const allowedAfter = await stage(operator.id, `operator-run-2-${operator.id}`);
    expect(allowedAfter.error).toBeNull();

    const periods = await periodsFor(operator);
    const operatorPeriod = periods.find((period) => period.source === "operator");
    expect(operatorPeriod).toBeDefined();
    expect(operatorPeriod).toMatchObject({
      period_key: "operator-pro-grant",
      state: "active",
      allowance: OPERATOR_PRO_ALLOWANCE,
      // No invented StoreKit transaction span, and no store period to
      // reconcile: the grant is its own source.
      original_transaction_id: null,
    });
    expect(periods.some((period) => period.source === "storekit")).toBe(false);

    // The eval harness depends on every run being recorded, so the operator
    // run is an ordinary reservation against the operator period — not a
    // bypass that skips the ledger.
    const { data: reservations, error } = await operator.client
      .from("ai_item_credit_reservations")
      .select("id, allowance_period_id, state");
    expect(error).toBeNull();
    const rows = (reservations ?? []) as Array<{
      allowance_period_id: string;
      state: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((row) => row.allowance_period_id === operatorPeriod!.id),
    ).toHaveLength(1);

    // Settings reads the same envelope it always did: an active Pro period
    // with a remainder, carried by the non-purchase billing source the shipped
    // client already decodes.
    const entitlement = await admin.rpc("get_verified_ai_item_entitlement", {
      p_user_id: operator.id,
    });
    expect(entitlement.error).toBeNull();
    expect((entitlement.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      billing_source: "included",
      status: "active",
      remaining_items: OPERATOR_PRO_ALLOWANCE - 1,
    });
  });

  it("leaves a seller the environment does not name exactly as they were", async () => {
    const granted = { SNAPLIST_PRO_OPERATOR_USER_IDS: operator.id };
    const client = admin as unknown as OperatorProGrantClient;

    const first = await stage(seller.id, `seller-run-1-${seller.id}`);
    expect(first.error).toBeNull();

    await expect(
      ensureOperatorProAllowance({ userId: seller.id, client, env: granted }),
    ).resolves.toBe(false);
    // Inverting the environment must not rescue the operator either: this is
    // the mutation check the grant has to survive.
    await expect(
      ensureOperatorProAllowance({ userId: operator.id, client, env: {} }),
    ).resolves.toBe(false);

    expect(await periodsFor(seller)).toHaveLength(1);
    const denied = await stage(seller.id, `seller-run-2-${seller.id}`);
    expect(denied.error?.message).toMatch(/snaplist-pro-required/i);
  });

  it("refuses to grant Pro to anything that is not an exact Clerk subject", async () => {
    for (const candidate of [
      `guest_${"a".repeat(48)}`,
      "reviewer@example.com",
      "user_*",
      "user_",
      "",
    ]) {
      const { error } = await admin.rpc("grant_operator_ai_item_allowance", {
        p_user_id: candidate,
        p_allowance: OPERATOR_PRO_ALLOWANCE,
      });
      expect(error?.message).toMatch(/exact Clerk subject/i);
    }

    // The ledger's own ceiling still applies; an operator cannot be handed an
    // allowance the schema would refuse.
    const overflow = await admin.rpc("grant_operator_ai_item_allowance", {
      p_user_id: operator.id,
      p_allowance: OPERATOR_PRO_ALLOWANCE + 1,
    });
    expect(overflow.error?.message).toMatch(/Invalid operator allowance/i);
  });

  it("is closed to every caller below the service role", async () => {
    const { error } = await operator.client.rpc(
      "grant_operator_ai_item_allowance",
      { p_user_id: operator.id, p_allowance: OPERATOR_PRO_ALLOWANCE },
    );
    expect(error).not.toBeNull();
    expect(`${error?.message} ${error?.code ?? ""}`).toMatch(
      /permission denied|not find the function|42501|PGRST202/i,
    );
  });
});
