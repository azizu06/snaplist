import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { createPipelineQueueEnvelope } from "./envelope";
import {
  createSupabasePgmqPipelineQueue,
  type PipelineQueueRpcClient,
} from "./supabase-pgmq";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
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
let itemA = "";
let itemB = "";
let listingA = "";
let listingB = "";
let runA = "";
let runB = "";
let runAIdempotencyKey = "";
const claimedMessageIds = new Set<string>();

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;

  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_queue_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_queue_b"),
  ]);

  const [{ data: aItem, error: aItemError }, { data: bItem, error: bItemError }] =
    await Promise.all([
      userA.client
        .from("items")
        .insert({ user_id: userA.id, attributes: { brand: "Tenant A" } })
        .select("id")
        .single(),
      userB.client
        .from("items")
        .insert({ user_id: userB.id, attributes: { brand: "Tenant B" } })
        .select("id")
        .single(),
    ]);
  expect(aItemError).toBeNull();
  expect(bItemError).toBeNull();
  itemA = aItem!.id;
  itemB = bItem!.id;

  const [{ data: aListing, error: aListingError }, { data: bListing, error: bListingError }] =
    await Promise.all([
      userA.client
        .from("listings")
        .insert({ user_id: userA.id, item_id: itemA, platform: "ebay" })
        .select("id")
        .single(),
      userB.client
        .from("listings")
        .insert({ user_id: userB.id, item_id: itemB, platform: "ebay" })
        .select("id")
        .single(),
    ]);
  expect(aListingError).toBeNull();
  expect(bListingError).toBeNull();
  listingA = aListing!.id;
  listingB = bListing!.id;

  runAIdempotencyKey = `run-a-${Date.now()}`;
  const [{ data: aRun, error: aRunError }, { data: bRun, error: bRunError }] =
    await Promise.all([
      userA.client
        .from("pipeline_runs")
        .insert({ user_id: userA.id, item_id: itemA, idempotency_key: runAIdempotencyKey })
        .select("id")
        .single(),
      userB.client
        .from("pipeline_runs")
        .insert({ user_id: userB.id, item_id: itemB, idempotency_key: `run-b-${Date.now()}` })
        .select("id")
        .single(),
    ]);
  expect(aRunError).toBeNull();
  expect(bRunError).toBeNull();
  runA = aRun!.id;
  runB = bRun!.id;
});

afterAll(async () => {
  if (!reachable || !admin) return;
  await Promise.all(
    [...claimedMessageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("pipeline queue tenant and worker boundary", () => {
  it("requires the local stack for real RLS proof", () => {
    if (!reachable) {
      console.warn(
        "[pipeline-queue.rls.test] Local Supabase credentials unavailable; run a reset and export `supabase status -o env`.",
      );
    }
    expect(true).toBe(true);
  });

  it("shows each seller only their own run and denies direct state mutation", async () => {
    if (!reachable) return;

    const { data: visible, error: readError } = await userA.client
      .from("pipeline_runs")
      .select("id, user_id")
      .order("id");
    expect(readError).toBeNull();
    expect(visible).toEqual([{ id: runA, user_id: userA.id }]);

    const { error: updateError } = await userA.client
      .from("pipeline_runs")
      .update({ status: "succeeded", stage: "completed" })
      .eq("id", runA);
    expect(updateError).not.toBeNull();

    const { data: bAsA, error: crossReadError } = await userA.client
      .from("pipeline_runs")
      .select("id")
      .eq("id", runB);
    expect(crossReadError).toBeNull();
    expect(bAsA).toEqual([]);
  });

  it("rejects forged run/item/user and mismatched listing relationships", async () => {
    if (!reachable) return;

    const { error: crossItemError } = await userA.client.from("pipeline_runs").insert({
      user_id: userA.id,
      item_id: itemB,
      idempotency_key: `forged-item-${Date.now()}`,
    });
    expect(crossItemError).not.toBeNull();

    const { error: forgedOwnerError } = await userA.client.from("pipeline_runs").insert({
      user_id: userB.id,
      item_id: itemB,
      idempotency_key: `forged-owner-${Date.now()}`,
    });
    expect(forgedOwnerError).not.toBeNull();

    const { error: duplicateRunError } = await userA.client.from("pipeline_runs").insert({
      user_id: userA.id,
      item_id: itemA,
      idempotency_key: runAIdempotencyKey,
    });
    expect(duplicateRunError).not.toBeNull();

    const { error: mismatchedListingError } = await admin.rpc(
      "link_pipeline_run_listing",
      { p_listing_id: listingB, p_run_id: runA },
    );
    expect(mismatchedListingError).not.toBeNull();

    const { error: validListingError } = await admin.rpc(
      "link_pipeline_run_listing",
      { p_listing_id: listingA, p_run_id: runA },
    );
    expect(validListingError).toBeNull();
  });

  it("derives worker context from run ownership and denies seller access to the RPC", async () => {
    if (!reachable) return;

    const { data: context, error: contextError } = await admin.rpc(
      "load_pipeline_run_worker_context",
      { p_run_id: runA },
    );
    expect(contextError).toBeNull();
    expect(context).toMatchObject({
      run: { id: runA, user_id: userA.id, item_id: itemA },
      item: { id: itemA, user_id: userA.id },
    });

    const { error: genericAdminReadError } = await admin
      .from("pipeline_runs")
      .select("id")
      .eq("id", runA);
    expect(genericAdminReadError).not.toBeNull();

    const { error: sellerRpcError } = await userA.client.rpc(
      "load_pipeline_run_worker_context",
      { p_run_id: runA },
    );
    expect(sellerRpcError).not.toBeNull();
  });

  it("uses private PGMQ claim/ack authority with redelivery-safe read semantics", async () => {
    if (!reachable) return;
    const queue = createSupabasePgmqPipelineQueue(
      admin as unknown as PipelineQueueRpcClient,
    );
    const messageId = await queue.enqueue(createPipelineQueueEnvelope(runA));
    claimedMessageIds.add(messageId);
    expect(await queue.enqueue(createPipelineQueueEnvelope(runA))).toBe(messageId);

    const claimed = await queue.claim({ limit: 10, visibilityTimeoutSeconds: 60 });
    const ownMessage = claimed.find((message) => message.id === messageId);
    expect(ownMessage).toMatchObject({
      id: messageId,
      envelope: createPipelineQueueEnvelope(runA),
    });
    expect(Object.keys(ownMessage!.envelope).sort()).toEqual(["run_id", "schema_version"]);
    for (const message of claimed) claimedMessageIds.add(message.id);

    expect(await queue.ack(messageId)).toBe(true);
    claimedMessageIds.delete(messageId);
  });

  it("enforces legal state transitions inside the narrow worker RPC", async () => {
    if (!reachable) return;

    const { data: running, error: runningError } = await admin.rpc(
      "transition_pipeline_run",
      {
        p_attempt_count: 1,
        p_expected_status: "queued",
        p_failure_code: null,
        p_failure_message: null,
        p_next_stage: "identifying",
        p_next_status: "running",
        p_run_id: runA,
      },
    );
    expect(runningError).toBeNull();
    expect(running).toMatchObject({ status: "running", stage: "identifying", attempt_count: 1 });

    const { error: forgedAttemptError } = await admin.rpc("transition_pipeline_run", {
      p_attempt_count: 2,
      p_expected_status: "running",
      p_failure_code: null,
      p_failure_message: null,
      p_next_stage: "completed",
      p_next_status: "succeeded",
      p_run_id: runA,
    });
    expect(forgedAttemptError).not.toBeNull();

    const { error: illegalError } = await admin.rpc("transition_pipeline_run", {
      p_attempt_count: 1,
      p_expected_status: "running",
      p_failure_code: null,
      p_failure_message: null,
      p_next_stage: "queued",
      p_next_status: "queued",
      p_run_id: runA,
    });
    expect(illegalError).not.toBeNull();
  });
});
