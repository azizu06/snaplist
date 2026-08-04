import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
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
import {
  acquireExclusiveTestResource,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";

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
let itemA = "";
let itemB = "";
let listingA = "";
let listingB = "";
let runA = "";
let runB = "";
let runAIdempotencyKey = "";
let queueLease: ExclusiveTestResourceLease | undefined;
const claimedMessageIds = new Set<string>();

beforeAll(async () => {
  reachable = await stackReachable({ url: SUPABASE_URL, apiKey: ANON_KEY, requiredValues: [ANON_KEY, SERVICE_ROLE_KEY] });
  await whenStackReachable(reachable, async () => {

  queueLease = await acquireExclusiveTestResource(
    `local-pgmq:pipeline_jobs:${SUPABASE_URL}`,
  );

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
});

afterAll(async () => {
  try {
    if (!reachable || !admin) return;
    await Promise.all(
      [...claimedMessageIds].map((messageId) =>
        admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
      ),
    );
    if (userA && userB) {
      await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
    }
  } finally {
    await queueLease?.release();
  }
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
    const { error: retiredLinkError } = await admin.rpc(
      "link_pipeline_run_listing",
      { p_listing_id: listingA, p_run_id: runA },
    );
    expect(retiredLinkError).not.toBeNull();
  });

  it("retires the unfenced context RPC and still denies generic service-role reads", async () => {


    const { data: context, error: contextError } = await admin.rpc(
      "load_pipeline_run_worker_context",
      { p_run_id: runA },
    );
    expect(context).toBeNull();
    expect(contextError).not.toBeNull();

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
    expect(Object.keys(createPipelineQueueEnvelope(runA)).sort()).toEqual([
      "run_id",
      "schema_version",
    ]);
    for (const message of claimed) claimedMessageIds.add(message.id);

    expect(await queue.ack(messageId)).toBe(true);
    claimedMessageIds.delete(messageId);
  });

  it("retires the unfenced transition RPC in favor of message-paired attempts", async () => {


    const { error: runningError } = await admin.rpc(
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
    expect(runningError).not.toBeNull();
  });
});
